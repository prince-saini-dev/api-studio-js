import {
  createApiStudio,
  instrumentFetch,
  instrumentXhr,
  type ApiStudioClient,
  type ApiStudioOptions,
  type DeviceInfo,
  type KeyValueStorage,
  type PlatformAdapter,
} from '@apistudio/core';

export * from '@apistudio/core';

export const SDK_VERSION = '0.1.0';

export interface BrowserOptions extends ApiStudioOptions {
  /** Record page changes (history pushState / popstate) as breadcrumbs. Default true. */
  captureNavigation?: boolean;
}

// Taken before instrumentFetch wraps it, so uploads are never logged.
const nativeFetch: typeof fetch | undefined = typeof fetch === 'function' ? fetch.bind(globalThis) : undefined;

/** localStorage, or nothing in private mode / when storage is blocked. */
function localStorageAdapter(): KeyValueStorage | undefined {
  try {
    const storage = globalThis.localStorage;
    const probe = '__apistudio_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => {
        try {
          storage.setItem(key, value);
        } catch {
          // Quota exceeded: keep going in memory.
        }
      },
      removeItem: (key) => storage.removeItem(key),
    };
  } catch {
    return undefined;
  }
}

function describeDevice(): DeviceInfo {
  const nav = (globalThis as { navigator?: Navigator & { userAgentData?: { platform?: string; mobile?: boolean } } }).navigator;
  const ua = nav?.userAgent ?? '';
  return {
    os: 'web',
    os_version: nav?.userAgentData?.platform || platformFromUa(ua),
    model: browserFromUa(ua),
    ...(nav?.language ? { locale: nav.language } : {}),
    ...(typeof location !== 'undefined' ? { page: location.origin + location.pathname } : {}),
  };
}

function platformFromUa(ua: string): string {
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/mac os x/i.test(ua)) return 'macOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/linux/i.test(ua)) return 'Linux';
  return 'unknown';
}

function browserFromUa(ua: string): string {
  const match =
    /(Edg|OPR|SamsungBrowser|Firefox|Chrome|CriOS|FxiOS)\/(\d+)/.exec(ua) ?? (/Version\/(\d+).*Safari/.test(ua) ? ['', 'Safari', /Version\/(\d+)/.exec(ua)![1]] : null);
  if (!match) return 'Browser';
  const names: Record<string, string> = { Edg: 'Edge', OPR: 'Opera', CriOS: 'Chrome', FxiOS: 'Firefox', SamsungBrowser: 'Samsung Internet' };
  return `${names[match[1]!] ?? match[1]} ${match[2]}`;
}

function installErrorHandlers(client: ApiStudioClient): () => void {
  const onError = (event: ErrorEvent) => {
    // Resource load errors (img/script 404) have no error object; skip them.
    if (!event.error && !event.message) return;
    client.captureException(event.error ?? { name: 'Error', message: event.message, stack: `at ${event.filename}:${event.lineno}:${event.colno}` }, {
      fatal: true,
      handled: false,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    client.captureException(event.reason, { fatal: false, handled: false, tags: { mechanism: 'unhandledrejection' } });
  };
  addEventListener('error', onError);
  addEventListener('unhandledrejection', onRejection);
  return () => {
    removeEventListener('error', onError);
    removeEventListener('unhandledrejection', onRejection);
  };
}

function installNavigation(client: ApiStudioClient): () => void {
  let previous = location.pathname + location.search;
  const record = () => {
    const current = location.pathname + location.search;
    if (current === previous) return;
    client.addBreadcrumb({ category: 'navigation', message: `${previous} → ${current}`, data: { from: previous, to: current } });
    previous = current;
  };
  const { pushState, replaceState } = history;
  history.pushState = function (...args) {
    const result = pushState.apply(this, args);
    record();
    return result;
  };
  history.replaceState = function (...args) {
    const result = replaceState.apply(this, args);
    record();
    return result;
  };
  addEventListener('popstate', record);
  return () => {
    history.pushState = pushState;
    history.replaceState = replaceState;
    removeEventListener('popstate', record);
  };
}

function adapter(options: BrowserOptions): PlatformAdapter {
  if (!nativeFetch) throw new Error('fetch is not available in this browser.');
  return {
    sdk: { name: 'api_studio.browser', version: SDK_VERSION, platform: 'browser' },
    fetch: nativeFetch,
    device: describeDevice,
    storage: localStorageAdapter(),
    install(client) {
      const undo: Array<() => void> = [];
      if (options.captureNetwork !== false) undo.push(instrumentFetch(client), instrumentXhr(client));
      if (options.captureErrors !== false) undo.push(installErrorHandlers(client));
      if (options.captureNavigation !== false && typeof history !== 'undefined') undo.push(installNavigation(client));
      // Save the queue when the tab is hidden or closed; it is sent on the next visit.
      const onHide = () => {
        if (document.visibilityState === 'hidden') void client.persist().then(() => client.flush(true));
      };
      const onPageHide = () => void client.persist();
      document.addEventListener('visibilitychange', onHide);
      addEventListener('pagehide', onPageHide);
      undo.push(() => {
        document.removeEventListener('visibilitychange', onHide);
        removeEventListener('pagehide', onPageHide);
      });
      return () => undo.forEach((fn) => fn());
    },
  };
}

export const ApiStudio = createApiStudio<BrowserOptions>(adapter);
export default ApiStudio;
