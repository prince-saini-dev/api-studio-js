import { AppState, Platform } from 'react-native';
import {
  createApiStudio,
  instrumentXhr,
  type ApiStudioClient,
  type ApiStudioOptions,
  type DeviceInfo,
  type PlatformAdapter,
} from '@api-studio-core/core';

export * from '@api-studio-core/core';

export const SDK_VERSION = '0.1.0';

export interface ReactNativeOptions extends ApiStudioOptions {
  /**
   * Pass `AsyncStorage` (from `@react-native-async-storage/async-storage`) so the
   * offline queue and fatal crashes survive an app restart. Without it,
   * a fatal crash is sent only if the upload finishes before the app closes.
   */
  storage?: ApiStudioOptions['storage'];
  /** How long a fatal crash may wait for its upload before the app closes. Default 1500 ms. */
  fatalFlushTimeoutMs?: number;
}

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsShape {
  getGlobalHandler(): ErrorHandler;
  setGlobalHandler(handler: ErrorHandler): void;
}
interface HermesShape {
  enablePromiseRejectionTracker?: (options: {
    allRejections: boolean;
    onUnhandled: (id: number, rejection: unknown) => void;
    onHandled?: (id: number) => void;
  }) => void;
}

// Captured before anything is wrapped. On React Native fetch is built on
// XMLHttpRequest, which is what gets instrumented; uploads are skipped by URL.
const uploadFetch: typeof fetch = (...args) => globalThis.fetch(...args);

function describeDevice(): DeviceInfo {
  const constants = (Platform as unknown as { constants?: Record<string, unknown> }).constants ?? {};
  const model =
    (constants.Model as string | undefined) ??
    (Platform.OS === 'ios' ? ((Platform as unknown as { isPad?: boolean }).isPad ? 'iPad' : 'iPhone') : undefined);
  return {
    os: Platform.OS,
    os_version: String(Platform.Version ?? ''),
    ...(model ? { model } : {}),
    ...(constants.Manufacturer ? { manufacturer: String(constants.Manufacturer) } : {}),
    runtime: (globalThis as { HermesInternal?: unknown }).HermesInternal ? 'hermes' : 'jsc',
  };
}

function installErrorHandlers(client: ApiStudioClient, timeoutMs: number): () => void {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
  const undo: Array<() => void> = [];

  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    const handler: ErrorHandler = (error, isFatal) => {
      client.captureException(error, { fatal: Boolean(isFatal), handled: false });
      if (!isFatal) {
        previous?.(error, isFatal);
        return;
      }
      // Save, try to send, then let React Native close the app as usual.
      const done = () => previous?.(error, isFatal);
      const timer = setTimeout(done, timeoutMs);
      client
        .persist()
        .then(() => client.flush(true))
        .finally(() => {
          clearTimeout(timer);
          done();
        });
    };
    errorUtils.setGlobalHandler(handler);
    undo.push(() => errorUtils.setGlobalHandler(previous));
  }

  const hermes = (globalThis as { HermesInternal?: HermesShape }).HermesInternal;
  if (hermes?.enablePromiseRejectionTracker) {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (_id, rejection) => {
        client.captureException(rejection, { fatal: false, handled: false, tags: { mechanism: 'unhandledrejection' } });
        if (__DEV__) console.warn('Possible unhandled promise rejection:', rejection);
      },
    });
  }

  return () => undo.forEach((fn) => fn());
}

/**
 * Saves and sends everything queued when the app leaves the foreground: the
 * OS may kill a background app at any time, and logs otherwise wait for the
 * next flush interval.
 */
function flushInBackground(client: ApiStudioClient): () => void {
  try {
    const subscription = AppState?.addEventListener?.('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        void client.persist().then(() => client.flush(true));
      }
    });
    return () => subscription?.remove();
  } catch {
    return () => {};
  }
}

function adapter(options: ReactNativeOptions): PlatformAdapter {
  return {
    sdk: { name: 'api_studio.react_native', version: SDK_VERSION, platform: 'react-native' },
    fetch: uploadFetch,
    device: describeDevice,
    storage: options.storage,
    install(client) {
      const undo: Array<() => void> = [];
      if (options.captureNetwork !== false) undo.push(instrumentXhr(client));
      if (options.captureErrors !== false) undo.push(installErrorHandlers(client, options.fatalFlushTimeoutMs ?? 1500));
      undo.push(flushInBackground(client));
      return () => undo.forEach((fn) => fn());
    },
  };
}

export const ApiStudio = createApiStudio<ReactNativeOptions>(adapter);
export default ApiStudio;

/**
 * Records screen changes as breadcrumbs for React Navigation:
 *
 * ```tsx
 * const navigationRef = useNavigationContainerRef();
 * <NavigationContainer ref={navigationRef} onStateChange={trackNavigation(navigationRef)}>
 * ```
 */
export function trackNavigation(navigationRef: { getCurrentRoute(): { name: string } | undefined }): () => void {
  let previous: string | undefined;
  return () => {
    try {
      const current = navigationRef.getCurrentRoute()?.name;
      if (!current || current === previous) return;
      ApiStudio.addBreadcrumb({
        category: 'navigation',
        message: previous ? `${previous} → ${current}` : current,
        data: { from: previous ?? null, to: current },
      });
      previous = current;
    } catch {
      // Never break navigation.
    }
  };
}
