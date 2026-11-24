// Writes real SDK payloads (from the built core) to a file, so the backend's
// own Pydantic schemas can validate them: node scripts/contract-payloads.mjs out.json
import { writeFileSync } from 'node:fs';
import { ApiStudioClient } from '../packages/core/dist/index.mjs';

const captured = {};
const client = new ApiStudioClient(
  { apiKey: 'k', baseUrl: 'https://ingest.test', app: { name: 'Shop', version: '1.0.0', build: '7' } },
  {
    sdk: { name: 'api_studio.react_native', version: '0.1.0', platform: 'react-native' },
    device: () => ({ os: 'android', os_version: '34', model: 'Pixel 8' }),
    fetch: async (url, init) => {
      captured[url.endsWith('logs/batch') ? 'logs' : 'errors'] = JSON.parse(String(init.body));
      return new Response('{}', { status: 202 });
    },
  },
);
client.setUser({ id: 'tester-1', email: 'qa@example.com' });
client.recordRequest({
  method: 'POST',
  url: 'https://api.shop.test/checkout?page=1',
  startedAt: Date.now(),
  durationMs: 120,
  requestHeaders: { 'content-type': 'application/json' },
  requestBody: client.captureBody('{"sku":"A1"}'),
  statusCode: 500,
  responseBody: client.captureBody('{"error":"x"}'),
});
client.recordRequest({ method: 'GET', url: 'https://api.shop.test/offline', startedAt: Date.now(), durationMs: 0, error: 'Network request failed' });
function checkout() {
  throw new TypeError("Cannot read properties of undefined (reading 'total')");
}
try {
  checkout();
} catch (error) {
  client.captureException(error, { fatal: true, handled: false, tags: { flavor: 'qa' } });
}
await client.flush(true);
writeFileSync(process.argv[2], JSON.stringify(captured));
