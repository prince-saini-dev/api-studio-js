import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiStudio, apiStudioErrorHandler, fileStorage } from '../src/index';

let server: http.Server;
let base = '';
const ingested: any[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url?.startsWith('/ingest/')) {
        ingested.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"success":true}');
        return;
      }
      res.writeHead(req.url === '/fail' ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ echo: body || null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ApiStudio.init({ apiKey: 'node-key', baseUrl: `${base}/ingest`, queueFile: false, flushIntervalMs: 60_000 });
});

afterAll(async () => {
  await ApiStudio.close();
  server.close();
});

describe('Node SDK', () => {
  it('captures global fetch and the http module, and skips its own uploads', async () => {
    // Uploads go to `${base}/ingest/...`; route them to the same server.
    const res = await fetch(`${base}/orders?page=1`, { method: 'POST', body: '{"sku":"A1"}', headers: { 'content-type': 'application/json' } });
    expect(await res.json()).toEqual({ echo: '{"sku":"A1"}' });

    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${base}/fail`, { method: 'PUT', headers: { authorization: 'Bearer secret' } }, (r) => {
        r.resume();
        r.on('end', resolve);
      });
      req.on('error', reject);
      req.end('{"password":"p","name":"n"}');
    });
    await new Promise((r) => setTimeout(r, 20));
    await ApiStudio.flush();

    const batches = ingested.filter((i) => i.path.endsWith('/logs/batch'));
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0].auth).toBe('Bearer node-key');
    const all = batches.flatMap((b) => b.body.logs);
    expect(all.some((l: any) => l.url.includes('/ingest/'))).toBe(false);
    const fetchLog = all.find((l: any) => l.url.endsWith('/orders?page=1'));
    expect(fetchLog).toMatchObject({ method: 'POST', status_code: 200, request: { body: { sku: 'A1' } }, response: { body: { echo: '{"sku":"A1"}' } }, sdk: { name: 'api_studio.node', platform: 'node' } });
    const httpLog = all.find((l: any) => l.url.endsWith('/fail'));
    expect(httpLog).toMatchObject({ method: 'PUT', status_code: 503, status: 'error', request: { headers: { authorization: '***REDACTED***' }, body: { password: '***REDACTED***', name: 'n' } } });
    expect(httpLog.device.os).toBe(process.platform);
  });

  it('reports errors passed through the Express middleware', async () => {
    let forwarded: unknown;
    apiStudioErrorHandler()(new RangeError('bad page'), { method: 'GET', originalUrl: '/items?page=-1' }, {}, (e) => (forwarded = e));
    await ApiStudio.flush();
    expect(forwarded).toBeInstanceOf(RangeError);
    const event = ingested.filter((i) => i.path.endsWith('/errors/batch')).flatMap((i) => i.body.events)[0];
    expect(event).toMatchObject({ exception_type: 'RangeError', message: 'bad page', handled: false, tags: { mechanism: 'express' }, extra: { url: '/items?page=-1' } });
    expect(event.stack_trace).toContain('node.test.ts');
  });

  it('file storage writes synchronously and survives a reload', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apistudio-test-')), 'queue.json');
    fileStorage(file).setItem('k', 'v');
    expect(fileStorage(file).getItem('k')).toBe('v');
  });
});
