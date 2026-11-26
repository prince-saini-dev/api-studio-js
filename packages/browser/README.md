# @api-studio-core/browser

API logs, crash reporting, and breadcrumbs for web apps, sent to
[API Studio](https://apistudio.cloud). Works with React, Next.js (client side),
Vue, Angular, Svelte, and plain JavaScript.

```bash
npm install @api-studio-core/browser
```

```ts
import { ApiStudio } from '@api-studio-core/browser';

ApiStudio.init({
  apiKey: 'YOUR_API_KEY',
  app: { name: 'Shop web', version: '2.4.0' },
});
ApiStudio.setUser({ id: 'tester-7' });
```

The SDK records:

* every `fetch` and XHR request (axios included), with secrets redacted in the browser
* uncaught errors and unhandled promise rejections
* route changes (`history.pushState`, back/forward) as breadcrumbs

The queue is kept in `localStorage`, so logs from a closed tab are sent on the
next visit. Options are the same as [`@api-studio-core/react-native`](../react-native),
plus `captureNavigation` (default `true`).

Your API must allow the browser to read response bodies (CORS). Opaque
`no-cors` responses are logged without a body.
