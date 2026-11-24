import { captureRequestBody, captureText, isTextualContentType, type CapturedBody } from './body';
import type { ApiStudioClient } from './client';

type AnyGlobal = typeof globalThis & { fetch?: typeof fetch; XMLHttpRequest?: typeof XMLHttpRequest };

function now(): number {
  return Date.now();
}

/** Relative URLs (fetch('/api/x')) become absolute against the page, when there is one. */
function absoluteUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  if (!base) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function headersToObject(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  const h = headers as { forEach?: (cb: (value: string, key: string) => void) => void };
  if (typeof h.forEach === 'function' && !Array.isArray(headers)) {
    h.forEach((value, key) => {
      result[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers as Array<[string, string]>) result[key] = String(value);
  } else if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) result[key] = String(value);
  }
  return result;
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const e = error as { name?: string; message?: string };
    return `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message ?? ''}`.trim() || String(error);
  }
  return String(error);
}

function isAbort(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError');
}

/**
 * Wraps global fetch. Returns the original so uploads can bypass the wrapper.
 * The response body is read from a clone after the caller gets the response,
 * so logging never delays the app.
 */
export function instrumentFetch(client: ApiStudioClient, target: AnyGlobal = globalThis as AnyGlobal): () => void {
  const original = target.fetch;
  if (typeof original !== 'function' || (original as { __apiStudio?: boolean }).__apiStudio) return () => {};

  const wrapped = async function apiStudioFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
    const url = absoluteUrl(request ? request.url : String(input instanceof URL ? input.href : input));
    if (!client.shouldCapture(url)) return original.call(target, input as RequestInfo, init);

    const method = init?.method ?? request?.method ?? 'GET';
    const requestHeaders = headersToObject(init?.headers ?? request?.headers);
    const requestBody = captureRequestBody(init?.body, client.options.maxBodyChars);
    const startedAt = now();

    let response: Response;
    try {
      response = await original.call(target, input as RequestInfo, init);
    } catch (error) {
      client.recordRequest({
        method,
        url,
        startedAt,
        durationMs: now() - startedAt,
        requestHeaders,
        requestBody,
        error: errorText(error),
        cancelled: isAbort(error),
      });
      throw error;
    }

    const durationMs = now() - startedAt;
    const responseHeaders = headersToObject(response.headers);
    const record = (body?: CapturedBody) =>
      client.recordRequest({
        method,
        url,
        startedAt,
        durationMs,
        requestHeaders,
        requestBody,
        statusCode: response.status,
        responseHeaders,
        responseBody: body,
      });

    const contentType = response.headers?.get?.('content-type');
    if (isTextualContentType(contentType) && typeof response.clone === 'function') {
      let copy: Response | undefined;
      try {
        copy = response.clone();
      } catch {
        copy = undefined;
      }
      if (copy) {
        copy
          .text()
          .then((text) => record(captureText(text, client.options.maxBodyChars)))
          .catch(() => record());
        return response;
      }
    }
    const length = Number(response.headers?.get?.('content-length'));
    record({ body: null, sizeBytes: Number.isFinite(length) ? length : null, truncated: false });
    return response;
  };
  (wrapped as { __apiStudio?: boolean }).__apiStudio = true;
  target.fetch = wrapped as typeof fetch;
  return () => {
    if (target.fetch === wrapped) target.fetch = original;
  };
}

interface XhrState {
  method: string;
  url: string;
  headers: Record<string, string>;
  startedAt: number;
}

const STATE = Symbol('apiStudioXhr');

/** Wraps XMLHttpRequest (axios, and fetch on React Native, use it). */
export function instrumentXhr(client: ApiStudioClient, target: AnyGlobal = globalThis as AnyGlobal): () => void {
  const Xhr = target.XMLHttpRequest;
  if (typeof Xhr !== 'function') return () => {};
  const proto = Xhr.prototype as XMLHttpRequest & { [STATE]?: XhrState; __apiStudio?: boolean };
  if (proto.__apiStudio) return () => {};
  const { open, send, setRequestHeader } = proto;

  proto.open = function (this: XMLHttpRequest & { [STATE]?: XhrState }, method: string, url: string | URL, ...rest: unknown[]) {
    this[STATE] = { method, url: absoluteUrl(String(url)), headers: {}, startedAt: 0 };
    return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;

  proto.setRequestHeader = function (this: XMLHttpRequest & { [STATE]?: XhrState }, name: string, value: string) {
    if (this[STATE]) this[STATE]!.headers[name] = value;
    return setRequestHeader.call(this, name, value);
  };

  proto.send = function (this: XMLHttpRequest & { [STATE]?: XhrState }, body?: Document | XMLHttpRequestBodyInit | null) {
    const state = this[STATE];
    if (state && client.shouldCapture(state.url)) {
      state.startedAt = now();
      const requestBody = captureRequestBody(body, client.options.maxBodyChars);
      let outcome: { error?: string; cancelled?: boolean } = {};
      const xhr = this;
      const onError = () => (outcome = { error: 'Network request failed' });
      const onTimeout = () => (outcome = { error: 'Request timed out' });
      const onAbort = () => (outcome = { error: 'Request cancelled', cancelled: true });
      const onLoadEnd = () => {
        xhr.removeEventListener('error', onError);
        xhr.removeEventListener('timeout', onTimeout);
        xhr.removeEventListener('abort', onAbort);
        xhr.removeEventListener('loadend', onLoadEnd);
        const status = outcome.error ? 0 : xhr.status;
        const durationMs = now() - state.startedAt;
        const record = (responseBody?: CapturedBody) => {
          try {
            client.recordRequest({
              method: state.method,
              url: xhr.responseURL || state.url,
              startedAt: state.startedAt,
              durationMs,
              requestHeaders: state.headers,
              requestBody,
              statusCode: status,
              responseHeaders: status ? parseRawHeaders(xhr.getAllResponseHeaders()) : undefined,
              responseBody,
              error: outcome.error ?? (status === 0 ? 'Network request failed' : undefined),
              cancelled: outcome.cancelled,
            });
          } catch {
            // Never break the app's request.
          }
        };
        if (!status) record();
        else readXhrBody(xhr, client.options.maxBodyChars).then(record, () => record());
      };
      xhr.addEventListener('error', onError);
      xhr.addEventListener('timeout', onTimeout);
      xhr.addEventListener('abort', onAbort);
      xhr.addEventListener('loadend', onLoadEnd);
    }
    return send.call(this, body as XMLHttpRequestBodyInit | null);
  };
  proto.__apiStudio = true;

  return () => {
    proto.open = open;
    proto.send = send;
    proto.setRequestHeader = setRequestHeader;
    proto.__apiStudio = false;
  };
}

function parseRawHeaders(raw: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) result[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return result;
}

const EMPTY: CapturedBody = { body: null, sizeBytes: null, truncated: false };

function readXhrBody(xhr: XMLHttpRequest, maxChars: number): Promise<CapturedBody> {
  if (!isTextualContentType(xhr.getResponseHeader('content-type'))) return Promise.resolve(EMPTY);
  try {
    const type = xhr.responseType;
    if (type === '' || type === 'text') return Promise.resolve(captureText(xhr.responseText, maxChars));
    if (type === 'json') return Promise.resolve(captureText(JSON.stringify(xhr.response), maxChars));
    // React Native's fetch is built on XHR with responseType "blob".
    if (type === 'blob' && xhr.response) return readBlobText(xhr.response as Blob).then((text) => captureText(text, maxChars));
  } catch {
    // responseText throws for some response types
  }
  return Promise.resolve(EMPTY);
}

function readBlobText(blob: Blob): Promise<string | null> {
  const Reader = (globalThis as { FileReader?: typeof FileReader }).FileReader;
  if (!Reader) return typeof blob.text === 'function' ? blob.text() : Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new Reader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsText(blob);
  });
}
