# @apistudio/react-native

API logs, crash reporting, and breadcrumbs for React Native and Expo, sent to
[API Studio](https://apistudio.cloud). Pure JavaScript: no native code and no
pod install, and it works in Expo Go.

## Install

```bash
npm install @apistudio/react-native @react-native-async-storage/async-storage
```

AsyncStorage is optional but recommended. With it, logs queued while offline,
and crashes that close the app, are kept and sent on the next launch.

## Set up

Initialise once, as early as possible, for example at the top of `index.js` or `App.tsx`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiStudio } from '@apistudio/react-native';

ApiStudio.init({
  apiKey: 'YOUR_API_KEY', // Portal → Project → API Keys
  storage: AsyncStorage,
  app: { name: 'Shop', version: '2.4.0', build: '118' },
  enabled: __DEV__ || isInternalBuild, // keep production builds clean if you like
});
```

That's all. Every request made with `fetch`, axios, or any XHR-based client is
logged, and uncaught JS errors and unhandled promise rejections are reported.

## Testers

```ts
ApiStudio.setUser({ id: tester.id, email: tester.email, name: tester.name });
ApiStudio.setUser(null); // on sign-out
```

## Screens as breadcrumbs (React Navigation)

```tsx
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { trackNavigation } from '@apistudio/react-native';

const navigationRef = useNavigationContainerRef();
<NavigationContainer ref={navigationRef} onStateChange={trackNavigation(navigationRef)}>
```

## Report errors yourself

```ts
try {
  await checkout();
} catch (error) {
  ApiStudio.captureException(error, { tags: { step: 'checkout' }, extra: { cartId } });
}
ApiStudio.captureMessage('Payment sheet closed without result');
ApiStudio.addBreadcrumb({ category: 'user', message: 'Tapped Pay' });
```

## Options

| Option | Default | |
|---|---|---|
| `apiKey` | required | Key from the portal |
| `enabled` | `true` | Turn the SDK off without removing calls |
| `captureNetwork` / `captureErrors` | `true` | Automatic capture |
| `storage` | none | `AsyncStorage` for the offline and crash queue |
| `app` | none | `{name, version, build}`; the portal groups crashes by release |
| `redactHeaders` / `redactKeys` | | Added to the built-in list |
| `ignoreUrls` | `[]` | Substrings or RegExps never logged |
| `maxBodyChars` | `65536` | Longer bodies are cut and marked truncated |
| `beforeSendLog` / `beforeSendError` | | Change an item, or return `null` to drop it |
| `debug` | `false` | Print SDK diagnostics |

## Limits

* Release builds without source maps show minified function names in stack
  traces. Source map upload is planned.
* Native (Java/Kotlin/Swift) crashes are not captured yet. The native Android and
  iOS SDKs will add that.
