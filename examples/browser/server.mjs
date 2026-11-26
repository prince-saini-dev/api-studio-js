// Local playground for @api-studio-core/browser: serves the demo page and a mock
// ingest API that records what the SDK uploads (GET /received to read it).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 8095);
const root = fileURLToPath(new URL('../../', import.meta.url));
const received = { logs: [], events: [] };

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.url === '/ingest/api/v1/logs/batch') {
      received.logs.push(...JSON.parse(body).logs);
      return res.writeHead(202, { ...cors, 'content-type': 'application/json' }).end('{"success":true}');
    }
    if (req.url === '/ingest/api/v1/errors/batch') {
      received.events.push(...JSON.parse(body).events);
      return res.writeHead(202, { ...cors, 'content-type': 'application/json' }).end('{"success":true}');
    }
    if (req.url === '/received') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(received));
    if (req.url?.startsWith('/demo-api/')) {
      const status = req.url.includes('fail') ? 500 : 200;
      return res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url, echo: body || null }));
    }
    const file = req.url === '/' ? 'examples/browser/index.html' : req.url.slice(1);
    let content;
    try {
      content = readFileSync(root + file);
    } catch {
      return res.writeHead(404).end('not found');
    }
    const type = file.endsWith('.mjs') || file.endsWith('.js') ? 'text/javascript' : 'text/html';
    res.writeHead(200, { 'content-type': type }).end(content);
  });
}).listen(port, () => console.log(`API Studio browser playground on http://localhost:${port}`));
