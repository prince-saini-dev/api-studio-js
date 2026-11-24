# @apistudio/node

Outgoing API logs and crash reporting for Node.js 18+, sent to
[API Studio](https://apistudio.cloud).

```bash
npm install @apistudio/node
```

```ts
import { ApiStudio, apiStudioErrorHandler } from '@apistudio/node';

ApiStudio.init({ apiKey: process.env.API_STUDIO_KEY!, app: { name: 'orders-api', version: '1.8.0' } });

// Express: after your routes
app.use(apiStudioErrorHandler());
```

The SDK records:

* calls made with global `fetch` (with request and response bodies)
* calls made through `http`/`https`: axios, got, node-fetch, and most vendor SDKs
  (request bodies only; response streams are left untouched)
* uncaught exceptions and unhandled rejections. They are saved to disk before the
  process exits and sent on the next start. Node's own crash behaviour is unchanged.

The offline queue lives in a file in `os.tmpdir()`. Set `queueFile` to move it,
or `queueFile: false` on read-only hosts. Call `await ApiStudio.close()` before
a short-lived script or serverless function returns, so nothing is lost.
