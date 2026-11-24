import { ApiStudioClient, type RecordedRequest } from './client';
import type { ApiStudioOptions, AppInfo, Breadcrumb, CaptureContext, PlatformAdapter, UserInfo } from './types';

/** The public `ApiStudio` object each platform package exports. Every call is safe before `init`. */
export interface ApiStudioSdk<O extends ApiStudioOptions = ApiStudioOptions> {
  /** Starts the SDK. Call once, as early as possible. */
  init(options: O): void;
  setUser(user: UserInfo | null): void;
  setApp(app: AppInfo): void;
  /** Reports an error you caught (`handled: true` unless you say otherwise). */
  captureException(error: unknown, context?: CaptureContext): void;
  captureMessage(message: string, context?: CaptureContext): void;
  addBreadcrumb(breadcrumb: Breadcrumb): void;
  /** Records a request made by an HTTP client the SDK does not instrument. */
  recordRequest(request: RecordedRequest): void;
  /** Sends everything queued now. */
  flush(): Promise<void>;
  /** Removes instrumentation and sends what is left. */
  close(): Promise<void>;
  readonly client: ApiStudioClient | undefined;
}

export function createApiStudio<O extends ApiStudioOptions>(adapter: (options: O) => PlatformAdapter): ApiStudioSdk<O> {
  let client: ApiStudioClient | undefined;
  return {
    init(options) {
      if (client) {
        client.debug('init() called again; ignoring.');
        return;
      }
      try {
        client = new ApiStudioClient(options, adapter(options));
        client.start();
      } catch (error) {
        client = undefined;
        console.warn('[API Studio] Not started:', error instanceof Error ? error.message : error);
      }
    },
    setUser: (user) => client?.setUser(user),
    setApp: (app) => client?.setApp(app),
    captureException: (error, context) => client?.captureException(error, context),
    captureMessage: (message, context) => client?.captureMessage(message, context),
    addBreadcrumb: (breadcrumb) => client?.addBreadcrumb(breadcrumb),
    recordRequest: (request) => client?.recordRequest(request),
    flush: () => client?.flush(true) ?? Promise.resolve(),
    async close() {
      const current = client;
      client = undefined;
      await current?.close();
    },
    get client() {
      return client;
    },
  };
}
