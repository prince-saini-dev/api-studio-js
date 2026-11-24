# API Studio JavaScript SDKs

API logs, crash reporting and breadcrumbs for [API Studio](https://apistudio.cloud),
for every JavaScript runtime. All packages speak the same ingestion protocol as
the Flutter SDK (`api_studio` on pub.dev), so data from every platform shows up
in the same portal: Logs, Issues, Alerts, testers, sessions, and releases.

| Package | For | Captures |
|---|---|---|
| [`@apistudio/react-native`](packages/react-native) | React Native and Expo | fetch, axios, and XHR; JS crashes; unhandled promise rejections; React Navigation screens |
| [`@apistudio/browser`](packages/browser) | Web apps (React, Vue, Angular, Svelte, plain JS) | fetch, axios, and XHR; uncaught errors; unhandled rejections; route changes |
| [`@apistudio/node`](packages/node) | Node.js 18+ backends and scripts | global fetch; axios, got, and anything else on `http`/`https`; uncaught exceptions; Express errors |
| [`@apistudio/core`](packages/core) | Building your own integration | Queue, redaction, uploads, fetch/XHR capture |

Every SDK:

* redacts secrets on the device (`Authorization`, cookies, `password`, `token`, …)
* batches uploads and keeps an offline queue with retry and backoff
* never logs its own uploads, and never throws into your app
* records `session_id`, device, app version/build, tester (`setUser`), and SDK

## Development

```bash
npm install
npm run check     # typecheck + tests
npm run build     # dist/ for every package
```

`examples/browser` is a playground with a mock ingest server:
`node examples/browser/server.mjs`, then open http://localhost:8095.

`scripts/contract-payloads.mjs` writes real SDK payloads to a file. The backend
validates them with its own schemas (see `api-studio-backend/docs/sdk-protocol.md`).

## Publishing

Versions are kept in step across packages. Publish `@apistudio/core` first:

```bash
npm run check && npm run build
npm publish -w packages/core --access public
npm publish -w packages/react-native --access public
npm publish -w packages/browser --access public
npm publish -w packages/node --access public
```
