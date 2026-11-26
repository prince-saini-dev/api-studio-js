import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiStudioClient } from '../src/index';

const BASE = 'https://ingest.test';

/** Records upload batches; each upload takes `latencyMs` like a real round trip. */
function slowBackend(latencyMs = 300) {
  const logBatches: number[] = [];
  const errorBatches: number[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).endsWith('/logs/batch')) logBatches.push(body.logs.length);
    else errorBatches.push(body.events.length);
    await new Promise((r) => setTimeout(r, latencyMs));
    return new Response('{}', { status: 202 });
  });
  return { logBatches, errorBatches, fetch: fetchImpl as unknown as typeof fetch };
}

function startClient(backend: ReturnType<typeof slowBackend>, flushIntervalMs?: number) {
  const client = new ApiStudioClient(
    { apiKey: 'key', baseUrl: BASE, ...(flushIntervalMs ? { flushIntervalMs } : {}) },
    {
      sdk: { name: 'api_studio.test', version: '0.0.0', platform: 'test' },
      fetch: backend.fetch,
      device: () => ({ os: 'test', os_version: '1' }),
    },
  );
  client.start();
  return client;
}

function call(client: ApiStudioClient, i: number, statusCode = 200) {
  client.recordRequest({
    method: 'GET',
    url: `https://api.example.com/v1/master/table${i}`,
    startedAt: Date.now(),
    durationMs: 120,
    statusCode,
  });
}

/** Runs `calls` app API calls `gapMs` apart, then lets every timer settle. */
async function sync(client: ApiStudioClient, calls: number, gapMs: number, failed: (i: number) => boolean = () => false) {
  for (let i = 0; i < calls; i++) {
    call(client, i, failed(i) ? 500 : 200);
    await vi.advanceTimersByTimeAsync(gapMs);
  }
  await vi.advanceTimersByTimeAsync(30_000);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('upload batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a 50-call sync, one after another, costs 1–2 uploads instead of one per call', async () => {
    const backend = slowBackend();
    const client = startClient(backend);
    await vi.advanceTimersByTimeAsync(10); // the empty start-up flush
    await sync(client, 50, 200);
    expect(backend.logBatches.length).toBeLessThanOrEqual(2);
    expect(sum(backend.logBatches)).toBe(50);
    await client.close();
  });

  it('50 calls at once go as one full batch, without waiting for the window', async () => {
    const backend = slowBackend();
    const client = startClient(backend);
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 50; i++) call(client, i);
    await vi.advanceTimersByTimeAsync(400);
    expect(backend.logBatches).toEqual([50]);
    await client.close();
  });

  it('slow calls (2 s apart) go once per 10 s window', async () => {
    const backend = slowBackend();
    const client = startClient(backend);
    await vi.advanceTimersByTimeAsync(10);
    await sync(client, 50, 2000);
    expect(backend.logBatches.length).toBeLessThanOrEqual(11);
    expect(sum(backend.logBatches)).toBe(50);
    await client.close();
  });

  it('a failed call is sent within 2 s, taking the waiting logs along', async () => {
    const backend = slowBackend();
    const client = startClient(backend);
    await vi.advanceTimersByTimeAsync(10);
    call(client, 1);
    await vi.advanceTimersByTimeAsync(1000);
    call(client, 2, 500);
    await vi.advanceTimersByTimeAsync(1900);
    expect(backend.logBatches).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.logBatches).toEqual([2]);
    await client.close();
  });

  it('an error is sent at once, with the API calls that led to it', async () => {
    const backend = slowBackend();
    const client = startClient(backend);
    await vi.advanceTimersByTimeAsync(10);
    call(client, 1);
    call(client, 2);
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.logBatches).toEqual([]);

    client.captureException(new TypeError('total of undefined'), { fatal: true, handled: false });
    await vi.advanceTimersByTimeAsync(800);
    expect(backend.errorBatches).toEqual([1]);
    expect(backend.logBatches).toEqual([2]);
    await client.close();
  });

  it('honours a custom flushIntervalMs', async () => {
    const backend = slowBackend();
    const client = startClient(backend, 60_000);
    await vi.advanceTimersByTimeAsync(10);
    call(client, 1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backend.logBatches).toEqual([]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(backend.logBatches).toEqual([1]);
    await client.close();
  });
});
