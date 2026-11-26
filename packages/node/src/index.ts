import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  captureRequestBody,
  createApiStudio,
  instrumentFetch,
  type ApiStudioClient,
  type ApiStudioOptions,
  type KeyValueStorage,
  type PlatformAdapter,
} from '@api-studio-core/core';

export * from '@api-studio-core/core';

export const SDK_VERSION = '0.1.0';

export interface NodeOptions extends ApiStudioOptions {
  /** Instrument the http/https modules (axios, got, node-fetch, SDK clients). Default true. */
  captureHttpModule?: boolean;
  /** Where the offline queue is kept. Default: a file in os.tmpdir(). Pass false for memory only. */
  queueFile?: string | false;
}

// Taken before instrumentFetch wraps it, so uploads are never logged.
const nativeFetch = globalThis.fetch?.bind(globalThis);

/**
 * A JSON file read once and written synchronously, so a crash handler can
 * save the queue before the process exits.
 */
export function fileStorage(file: string): KeyValueStorage {
  let cache: Record<string, string> | undefined;
  const read = () => {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      cache = {};
    }
    return cache;
  };
  const write = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cache ?? {}));
    } catch {
      // Read-only file system (some serverless hosts): keep going in memory.
    }
  };
  return {
    getItem: (key) => read()[key] ?? null,
    setItem: (key, value) => {
      read()[key] = value;
      write();
    },
    removeItem: (key) => {
      delete read()[key];
      write();
    },
  };
}

function requestUrl(args: unknown[], defaultProtocol: string): { url: string; method: string; headers: Record<string, string> } {
  let url = '';
  let options: http.RequestOptions = {};
  for (const arg of args) {
    if (typeof arg === 'string') url = arg;
    else if (arg instanceof URL) url = arg.href;
    else if (arg && typeof arg === 'object' && typeof arg !== 'function') options = arg as http.RequestOptions;
  }
  if (!url) {
    const protocol = options.protocol ?? defaultProtocol;
    const host = options.hostname ?? options.host ?? 'localhost';
    const port = options.port ? `:${options.port}` : '';
    url = `${protocol}//${host}${port}${options.path ?? '/'}`;
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) if (value !== undefined) headers[key] = String(value);
  return { url, method: options.method ?? 'GET', headers };
}

function instrumentHttpModule(client: ApiStudioClient, mod: typeof http | typeof https, protocol: string): () => void {
  const originalRequest = mod.request;
  const originalGet = mod.get;

  const request = function (this: unknown, ...args: unknown[]) {
    const req = (originalRequest as (...a: unknown[]) => http.ClientRequest).apply(this, args);
    try {
      const info = requestUrl(args, protocol);
      if (!client.shouldCapture(info.url)) return req;
      const startedAt = Date.now();
      const chunks: string[] = [];
      let size = 0;
      const max = client.options.maxBodyChars;
      const { write, end } = req;
      const keep = (chunk: unknown) => {
        if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
        size += Buffer.byteLength(text);
        if (chunks.join('').length < max + 1) chunks.push(text);
      };
      req.write = function (this: http.ClientRequest, chunk: unknown, ...rest: unknown[]) {
        keep(chunk);
        return (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
      } as typeof req.write;
      req.end = function (this: http.ClientRequest, chunk?: unknown, ...rest: unknown[]) {
        keep(chunk);
        return (end as (...a: unknown[]) => http.ClientRequest).call(this, chunk, ...rest);
      } as typeof req.end;

      let done = false;
      const finish = (statusCode: number, responseHeaders?: http.IncomingHttpHeaders, error?: unknown) => {
        if (done) return;
        done = true;
        const body = captureRequestBody(chunks.join(''), max);
        client.recordRequest({
          method: req.method || info.method,
          url: info.url,
          startedAt,
          durationMs: Date.now() - startedAt,
          requestHeaders: { ...info.headers, ...stringHeaders(req.getHeaders()) },
          requestBody: { ...body, sizeBytes: size || body.sizeBytes },
          statusCode,
          responseHeaders: responseHeaders ? stringHeaders(responseHeaders) : undefined,
          // Response bodies are not read: attaching a reader would change how the app's stream flows.
          error: error ? String((error as Error).message ?? error) : undefined,
          cancelled: (error as { code?: string } | undefined)?.code === 'ECONNRESET' && req.destroyed,
        });
      };
      req.once('response', (res: http.IncomingMessage) => {
        res.once('end', () => finish(res.statusCode ?? 0, res.headers));
        res.once('close', () => finish(res.statusCode ?? 0, res.headers));
      });
      req.once('error', (error) => finish(0, undefined, error));
    } catch {
      // Never break the app's request.
    }
    return req;
  };

  const get = function (this: unknown, ...args: unknown[]) {
    const req = (request as (...a: unknown[]) => http.ClientRequest).apply(this, args);
    req.end();
    return req;
  };

  (mod as { request: unknown }).request = request;
  (mod as { get: unknown }).get = get;
  syncBuiltinESMExports(); // so `import { request } from 'node:http'` sees the wrapper too
  return () => {
    (mod as { request: unknown }).request = originalRequest;
    (mod as { get: unknown }).get = originalGet;
    syncBuiltinESMExports();
  };
}

function stringHeaders(headers: http.OutgoingHttpHeaders | http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) result[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

function installErrorHandlers(client: ApiStudioClient): () => void {
  // The monitor event never changes Node's own behaviour (the process still exits).
  const onUncaught = (error: Error, origin: string) => {
    client.captureException(error, {
      fatal: true,
      handled: false,
      tags: { mechanism: origin === 'unhandledRejection' ? 'unhandledrejection' : 'uncaughtexception' },
    });
    // The file storage writes synchronously, so this is saved before exit
    // and sent on the next start.
    void client.persist();
  };
  process.on('uncaughtExceptionMonitor', onUncaught);
  const onExit = () => void client.persist();
  process.once('beforeExit', () => void client.flush(true));
  process.on('exit', onExit);
  return () => {
    process.off('uncaughtExceptionMonitor', onUncaught);
    process.off('exit', onExit);
  };
}

function adapter(options: NodeOptions): PlatformAdapter {
  if (!nativeFetch) throw new Error('API Studio needs Node 18 or newer (global fetch).');
  const keyHash = createHash('sha256').update(options.apiKey ?? '').digest('hex').slice(0, 12);
  const file = options.queueFile === false ? undefined : options.queueFile ?? path.join(os.tmpdir(), `apistudio-${keyHash}.json`);
  return {
    sdk: { name: 'api_studio.node', version: SDK_VERSION, platform: 'node' },
    fetch: nativeFetch,
    device: () => ({ os: process.platform, os_version: os.release(), runtime: `node ${process.version}`, arch: process.arch }),
    storage: file ? fileStorage(file) : undefined,
    install(client) {
      const undo: Array<() => void> = [];
      if (options.captureNetwork !== false) {
        undo.push(instrumentFetch(client));
        if (options.captureHttpModule !== false) {
          undo.push(instrumentHttpModule(client, http, 'http:'), instrumentHttpModule(client, https, 'https:'));
        }
      }
      if (options.captureErrors !== false) undo.push(installErrorHandlers(client));
      return () => undo.forEach((fn) => fn());
    },
  };
}

export const ApiStudio = createApiStudio<NodeOptions>(adapter);
export default ApiStudio;

/**
 * Express / Connect error middleware. Add it after your routes:
 * `app.use(apiStudioErrorHandler())`. It reports the error, then passes it on.
 */
export function apiStudioErrorHandler() {
  return (error: unknown, req: { method?: string; originalUrl?: string; url?: string }, _res: unknown, next: (error?: unknown) => void) => {
    ApiStudio.captureException(error, {
      handled: false,
      tags: { mechanism: 'express' },
      extra: { method: req.method, url: req.originalUrl ?? req.url },
    });
    next(error);
  };
}
