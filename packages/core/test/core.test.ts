import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiStudioClient,
  classify,
  createApiStudio,
  describeError,
  instrumentFetch,
  instrumentXhr,
  parseQuery,
  PersistentQueue,
  REDACTED,
  Redactor,
  type ApiLog,
  type ErrorEvent,
  type KeyValueStorage,
  type PlatformAdapter,
} from '@apistudio/core';

const BASE = 'https://ingest.test';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

function fakeUpload(statuses: number[] = []) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response('{}', { status: statuses.shift() ?? 202 });
  });
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

function makeClient(overrides: Partial<ConstructorParameters<typeof ApiStudioClient>[0]> = {}, adapter: Partial<PlatformAdapter> = {}) {
  const upload = fakeUpload();
  const client = new ApiStudioClient(
    { apiKey: 'key-1', baseUrl: BASE, flushIntervalMs: 60_000, ...overrides },
    {
      sdk: { name: 'api_studio.test', version: '0.0.0', platform: 'test' },
      fetch: upload.fetch,
      device: () => ({ os: 'test', os_version: '1' }),
      ...adapter,
    },
  );
  return { client, upload };
}

describe('redaction', () => {
  const redactor = new Redactor({ keys: ['otp'] });

  it('redacts default and custom keys, ignoring case, _ and -', () => {
    expect(
      redactor.redactBody({ accessToken: 'a', nested: [{ Password: 'p', ok: 1 }], otp: '1234', name: 'n' }),
    ).toEqual({ accessToken: REDACTED, nested: [{ Password: REDACTED, ok: 1 }], otp: REDACTED, name: 'n' });
  });

  it('redacts headers and query parameters inside the URL', () => {
    expect(redactor.redactHeaders({ Authorization: 'Bearer x', Accept: 'json' })).toEqual({ Authorization: REDACTED, Accept: 'json' });
    expect(redactor.redactUrl('https://a.test/p?token=abc&page=2#top')).toBe(`https://a.test/p?token=${encodeURIComponent(REDACTED)}&page=2#top`);
  });

  it('parses repeated and encoded query parameters without URLSearchParams', () => {
    expect(parseQuery('https://a.test/p?tag=a&tag=b&q=hello%20world&flag')).toEqual({ tag: ['a', 'b'], q: 'hello world', flag: '' });
    expect(parseQuery('https://a.test/p')).toBeNull();
  });
});

describe('uploads', () => {
  it('follows the protocol retry rules', () => {
    expect(classify(202)).toBe('accepted');
    expect(classify(422)).toBe('dropped');
    expect(classify(400)).toBe('dropped');
    expect(classify(413)).toBe('tooLarge');
    expect(classify(401)).toBe('retryLater');
    expect(classify(429)).toBe('retryLater');
    expect(classify(503)).toBe('retryLater');
  });

  it('sends logs in batches with the API key and empties the queue', async () => {
    const { client, upload } = makeClient();
    for (let i = 0; i < 3; i++) client.recordRequest({ method: 'get', url: `https://api.test/items/${i}`, startedAt: Date.now(), durationMs: 5, statusCode: 200 });
    await client.flush(true);
    expect(upload.calls).toHaveLength(1);
    expect(upload.calls[0]!.url).toBe(`${BASE}/api/v1/logs/batch`);
    expect(upload.calls[0]!.headers.Authorization).toBe('Bearer key-1');
    expect(upload.calls[0]!.body.logs).toHaveLength(3);
    await client.flush(true);
    expect(upload.calls).toHaveLength(1);
  });

  it('keeps the queue on 503 and sends it on the next flush', async () => {
    const upload = fakeUpload([503]);
    const { client } = makeClient({}, { fetch: upload.fetch });
    client.recordRequest({ method: 'GET', url: 'https://api.test/a', startedAt: Date.now(), durationMs: 1, statusCode: 200 });
    await client.flush(true);
    await client.flush(true);
    expect(upload.calls).toHaveLength(2);
    expect(upload.calls[1]!.body.logs).toHaveLength(1);
  });

  it('retries an oversized log once without bodies, then drops it', async () => {
    const upload = fakeUpload([413, 413]);
    const { client } = makeClient({}, { fetch: upload.fetch });
    client.recordRequest({
      method: 'POST',
      url: 'https://api.test/a',
      startedAt: Date.now(),
      durationMs: 1,
      statusCode: 200,
      requestBody: client.captureBody('{"big":true}'),
    });
    await client.flush(true);
    expect(upload.calls).toHaveLength(2);
    expect(upload.calls[0]!.body.logs[0].request.body).toEqual({ big: true });
    expect(upload.calls[1]!.body.logs[0].request.body).toBeNull();
    expect(upload.calls[1]!.body.logs[0].is_truncated).toBe(true);
    await client.flush(true);
    expect(upload.calls).toHaveLength(2);
  });

  it('retries an oversized error once smaller, then drops it instead of looping', async () => {
    const upload = fakeUpload([413, 413, 413, 413]);
    const { client } = makeClient({}, { fetch: upload.fetch });
    for (let i = 0; i < 30; i++) client.addBreadcrumb({ category: 'log', message: String(i), data: { i } });
    client.captureException(new Error('huge'), { extra: { blob: 'x' } });
    await client.flush(true);
    expect(upload.calls).toHaveLength(2);
    const retried = upload.calls[1]!.body.events[0];
    expect(retried.extra).toBeUndefined();
    expect(retried.breadcrumbs).toHaveLength(10);
    expect(retried.breadcrumbs.every((b: { data?: unknown }) => b.data === undefined)).toBe(true);
    await client.flush(true);
    expect(upload.calls).toHaveLength(2);
  });

  it('restores a queue saved by an earlier launch before new items', async () => {
    const saved: ApiLog = { method: 'GET', url: 'https://api.test/old', status_code: 200, duration_ms: 1, status: 'success', timestamp: new Date().toISOString() };
    const storage = memoryStorage({ 'apistudio.logs': JSON.stringify([saved]) });
    const { client, upload } = makeClient({ storage });
    client.recordRequest({ method: 'GET', url: 'https://api.test/new', startedAt: Date.now(), durationMs: 1, statusCode: 200 });
    await client.flush(true);
    expect(upload.calls[0]!.body.logs.map((l: ApiLog) => l.url)).toEqual(['https://api.test/old', 'https://api.test/new']);
  });

  it('caps the queue and drops the oldest items', () => {
    const queue = new PersistentQueue<number>('q', 3);
    [1, 2, 3, 4, 5].forEach((n) => queue.push(n));
    expect(queue.peek(10)).toEqual([2, 3, 4, 5].slice(-3));
  });
});

describe('logs', () => {
  it('builds a protocol log with redaction, status, query and context', async () => {
    const { client, upload } = makeClient({ app: { name: 'Shop', version: '2.4.0', build: '118' } });
    client.setUser({ id: 'tester-7' });
    client.recordRequest({
      method: 'post',
      url: 'https://api.test/checkout?token=t&page=2',
      startedAt: Date.parse('2026-11-24T10:00:00Z'),
      durationMs: 412.6,
      requestHeaders: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      requestBody: client.captureBody('{"sku":"A1","password":"p"}'),
      statusCode: 500,
      responseBody: client.captureBody('oops'),
    });
    await client.flush(true);
    const log = upload.calls[0]!.body.logs[0];
    expect(log).toMatchObject({
      method: 'POST',
      status_code: 500,
      duration_ms: 413,
      status: 'error',
      query_params: { token: REDACTED, page: '2' },
      request: { headers: { Authorization: REDACTED, 'Content-Type': 'application/json' }, body: { sku: 'A1', password: REDACTED } },
      response: { body: 'oops', size_bytes: 4 },
      timestamp: '2026-11-24T10:00:00.000Z',
      app: { name: 'Shop', version: '2.4.0', build: '118' },
      user: { id: 'tester-7' },
      sdk: { name: 'api_studio.test', platform: 'test' },
      device: { os: 'test' },
    });
    expect(log.url).not.toContain('token=t&');
    expect(log.session_id).toBe(client.sessionId);
  });

  it('never logs its own uploads or ignored URLs', () => {
    const { client } = makeClient({ ignoreUrls: ['/health', /analytics/] });
    expect(client.shouldCapture(`${BASE}/api/v1/logs/batch`)).toBe(false);
    expect(client.shouldCapture('https://api.test/health')).toBe(false);
    expect(client.shouldCapture('https://analytics.test/e')).toBe(false);
    expect(client.shouldCapture('https://api.test/items')).toBe(true);
  });

  it('marks network failures as status 0 errors and aborts as cancelled', async () => {
    const { client, upload } = makeClient();
    client.recordRequest({ method: 'GET', url: 'https://api.test/a', startedAt: Date.now(), durationMs: 3, error: 'Network request failed' });
    client.recordRequest({ method: 'GET', url: 'https://api.test/b', startedAt: Date.now(), durationMs: 3, error: 'AbortError', cancelled: true });
    await client.flush(true);
    const [failed, cancelled] = upload.calls[0]!.body.logs;
    expect(failed).toMatchObject({ status_code: 0, status: 'error', error: 'Network request failed' });
    expect(cancelled.status).toBe('cancelled');
  });

  it('truncates long bodies and parses JSON', () => {
    const { client } = makeClient({ maxBodyChars: 10 });
    expect(client.captureBody('x'.repeat(20))).toEqual({ body: `${'x'.repeat(10)}…`, sizeBytes: 20, truncated: true });
    expect(client.captureBody('[1,2]').body).toEqual([1, 2]);
    expect(client.captureBody('{bad json').body).toBe('{bad json');
  });

  it('lets beforeSendLog change or drop logs', async () => {
    const { client, upload } = makeClient({ beforeSendLog: (log) => (log.url.includes('skip') ? null : { ...log, method: 'PATCH' }) });
    client.recordRequest({ method: 'GET', url: 'https://api.test/skip', startedAt: Date.now(), durationMs: 1, statusCode: 200 });
    client.recordRequest({ method: 'GET', url: 'https://api.test/keep', startedAt: Date.now(), durationMs: 1, statusCode: 200 });
    await client.flush(true);
    expect(upload.calls[0]!.body.logs).toHaveLength(1);
    expect(upload.calls[0]!.body.logs[0].method).toBe('PATCH');
  });
});

describe('errors', () => {
  it('describes errors of every shape', () => {
    expect(describeError(new TypeError('bad')).type).toBe('TypeError');
    class CheckoutError extends Error {}
    expect(describeError(new CheckoutError('x')).type).toBe('CheckoutError');
    expect(describeError('plain')).toEqual({ type: 'Error', message: 'plain' });
    expect(describeError({ code: 7 })).toMatchObject({ type: 'Error', message: '{"code":7}' });
    expect(describeError(42).type).toBe('number');
  });

  it('sends errors with breadcrumbs (including http ones) before logs', async () => {
    const { client, upload } = makeClient();
    client.recordRequest({ method: 'POST', url: 'https://api.test/checkout?x=1', startedAt: Date.now(), durationMs: 9, statusCode: 500 });
    client.addBreadcrumb({ category: 'navigation', message: 'Cart → Checkout' });
    client.captureException(new TypeError("Cannot read properties of undefined (reading 'total')"), {
      fatal: true,
      handled: false,
      tags: { flavor: 'staging' },
      extra: { cart: 'c1', token: 'secret' },
    });
    await client.flush(true);
    expect(upload.calls.map((c) => c.url)).toEqual([`${BASE}/api/v1/errors/batch`, `${BASE}/api/v1/logs/batch`]);
    const event: ErrorEvent = upload.calls[0]!.body.events[0];
    expect(event).toMatchObject({ exception_type: 'TypeError', fatal: true, handled: false, tags: { flavor: 'staging' }, extra: { cart: 'c1', token: REDACTED } });
    expect(event.stack_trace).toContain('at ');
    expect(event.breadcrumbs!.map((b) => b.category)).toEqual(['http', 'navigation']);
    expect(event.breadcrumbs![0]!.message).toBe('POST https://api.test/checkout 500');
  });

  it('keeps only the last 100 breadcrumbs', () => {
    const { client } = makeClient();
    for (let i = 0; i < 120; i++) client.addBreadcrumb({ category: 'log', message: String(i) });
    client.captureMessage('m');
    // @ts-expect-error reading private state in a test
    const event = client.errorQueue.peek(1)[0] as ErrorEvent;
    expect(event.breadcrumbs).toHaveLength(100);
    expect(event.breadcrumbs![0]!.message).toBe('20');
    expect(event.exception_type).toBe('Message');
  });
});

describe('fetch instrumentation', () => {
  it('logs fetch calls with request and response bodies without changing the response', async () => {
    const target = {
      fetch: vi.fn(async () => new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } })),
    } as unknown as typeof globalThis;
    const { client, upload } = makeClient();
    const undo = instrumentFetch(client, target);
    const response = await target.fetch('https://api.test/orders?page=1', { method: 'POST', body: '{"sku":"A1"}', headers: { 'X-Trace': '1' } });
    expect(await response.json()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 10));
    await client.flush(true);
    expect(upload.calls[0]!.body.logs[0]).toMatchObject({
      method: 'POST',
      status_code: 201,
      status: 'success',
      request: { headers: { 'X-Trace': '1' }, body: { sku: 'A1' } },
      response: { body: { ok: true } },
    });
    undo();
  });

  it('logs failed fetches and rethrows the error', async () => {
    const target = { fetch: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) } as unknown as typeof globalThis;
    const { client, upload } = makeClient();
    instrumentFetch(client, target);
    await expect(target.fetch('https://api.test/x')).rejects.toThrow('Failed to fetch');
    await client.flush(true);
    expect(upload.calls[0]!.body.logs[0]).toMatchObject({ status_code: 0, status: 'error', error: 'TypeError: Failed to fetch' });
  });
});

describe('XMLHttpRequest instrumentation', () => {
  class FakeXhr {
    status = 0;
    responseType = '';
    responseText = '';
    response: unknown = null;
    responseURL = '';
    private listeners: Record<string, Array<() => void>> = {};
    private headers: Record<string, string> = {};
    open(_method: string, _url: string) {}
    setRequestHeader(_name: string, _value: string) {}
    addEventListener(type: string, cb: () => void) {
      (this.listeners[type] ??= []).push(cb);
    }
    removeEventListener(type: string, cb: () => void) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
    }
    getAllResponseHeaders() {
      return Object.entries(this.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    }
    getResponseHeader(name: string) {
      return this.headers[name.toLowerCase()] ?? null;
    }
    send(_body?: unknown) {}
    respond(status: number, text: string, headers: Record<string, string> = {}) {
      this.status = status;
      this.responseText = text;
      this.headers = headers;
      this.fire('load');
      this.fire('loadend');
    }
    fail(type: 'error' | 'timeout' | 'abort') {
      this.fire(type);
      this.fire('loadend');
    }
    private fire(type: string) {
      [...(this.listeners[type] ?? [])].forEach((cb) => cb());
    }
  }

  afterEach(() => {
    // each test installs on a fresh class
  });

  it('logs XHR requests (axios) with headers and bodies', async () => {
    const target = { XMLHttpRequest: class extends FakeXhr {} } as unknown as typeof globalThis;
    const { client, upload } = makeClient();
    instrumentXhr(client, target);
    const xhr = new target.XMLHttpRequest() as unknown as FakeXhr;
    xhr.open('PUT', 'https://api.test/profile');
    xhr.setRequestHeader('Authorization', 'Bearer t');
    xhr.send('{"name":"A"}');
    xhr.respond(200, '{"saved":true}', { 'content-type': 'application/json' });
    await new Promise((r) => setTimeout(r, 5));
    await client.flush(true);
    expect(upload.calls[0]!.body.logs[0]).toMatchObject({
      method: 'PUT',
      status_code: 200,
      request: { headers: { Authorization: REDACTED }, body: { name: 'A' } },
      response: { body: { saved: true }, headers: { 'content-type': 'application/json' } },
    });
  });

  it('logs timeouts and aborts', async () => {
    const target = { XMLHttpRequest: class extends FakeXhr {} } as unknown as typeof globalThis;
    const { client, upload } = makeClient();
    instrumentXhr(client, target);
    const a = new target.XMLHttpRequest() as unknown as FakeXhr;
    a.open('GET', 'https://api.test/slow');
    a.send();
    a.fail('timeout');
    const b = new target.XMLHttpRequest() as unknown as FakeXhr;
    b.open('GET', 'https://api.test/cancel');
    b.send();
    b.fail('abort');
    await client.flush(true);
    const [timeout, abort] = upload.calls[0]!.body.logs;
    expect(timeout).toMatchObject({ status_code: 0, status: 'error', error: 'Request timed out' });
    expect(abort).toMatchObject({ status: 'cancelled' });
  });
});

describe('public facade', () => {
  it('is safe before init and refuses to start without an API key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sdk = createApiStudio(() => ({ sdk: { name: 'x', version: '0', platform: 'x' }, fetch: fakeUpload().fetch, device: () => ({}) }));
    sdk.captureException(new Error('before init'));
    await sdk.flush();
    sdk.init({ apiKey: '' });
    expect(sdk.client).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing when disabled', async () => {
    const { client, upload } = makeClient({ enabled: false });
    client.start();
    client.recordRequest({ method: 'GET', url: 'https://api.test/a', startedAt: Date.now(), durationMs: 1, statusCode: 200 });
    client.captureException(new Error('x'));
    await client.flush(true);
    expect(upload.calls).toHaveLength(0);
  });
});
