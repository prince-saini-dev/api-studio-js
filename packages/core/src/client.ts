import { captureText, type CapturedBody } from './body';
import { PersistentQueue } from './queue';
import { parseQuery, Redactor } from './redaction';
import type {
  ApiLog,
  ApiStudioOptions,
  AppInfo,
  Breadcrumb,
  CaptureContext,
  DeviceInfo,
  ErrorEvent,
  PlatformAdapter,
  UserInfo,
} from './types';
import { Uploader } from './uploader';

export const DEFAULT_BASE_URL = 'https://api-studio-backend-345113340482.asia-south1.run.app';

const MAX_BREADCRUMBS = 100;
const MAX_BREADCRUMB_MESSAGE = 300;
const MAX_STACK_CHARS = 60_000;
const MAX_MESSAGE_CHARS = 4_000;
const LOG_BATCH = 50;
const ERROR_BATCH = 20;
const INSTALL_ID_KEY = 'apistudio.install_id';

/** One finished HTTP request, as an instrumentation saw it. */
export interface RecordedRequest {
  method: string;
  url: string;
  startedAt: number;
  durationMs: number;
  requestHeaders?: Record<string, string>;
  requestBody?: CapturedBody;
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: CapturedBody;
  error?: string;
  cancelled?: boolean;
}

export class ApiStudioClient {
  readonly options: Required<Pick<ApiStudioOptions, 'baseUrl' | 'maxBodyChars' | 'flushIntervalMs' | 'maxQueueSize'>> &
    ApiStudioOptions;
  readonly sessionId = randomId();
  readonly redactor: Redactor;
  private user?: UserInfo;
  private app?: AppInfo;
  private installId?: string;
  private breadcrumbs: Breadcrumb[] = [];
  private readonly logQueue: PersistentQueue<ApiLog>;
  private readonly errorQueue: PersistentQueue<ErrorEvent>;
  private readonly logUploader: Uploader<ApiLog>;
  private readonly errorUploader: Uploader<ErrorEvent>;
  private timer?: ReturnType<typeof setInterval>;
  private uninstall?: () => void;

  constructor(
    options: ApiStudioOptions,
    readonly adapter: PlatformAdapter,
  ) {
    if (!options?.apiKey) throw new Error('API Studio: apiKey is required.');
    this.options = {
      baseUrl: DEFAULT_BASE_URL,
      maxBodyChars: 64 * 1024,
      flushIntervalMs: 5000,
      maxQueueSize: 500,
      ...options,
    };
    this.options.baseUrl = this.options.baseUrl.replace(/\/+$/, '');
    this.user = options.user;
    this.app = options.app;
    this.redactor = new Redactor({
      headers: options.redactHeaders,
      keys: options.redactKeys,
      includeDefaults: options.includeDefaultRedaction,
    });
    const storage = options.storage ?? adapter.storage;
    const onError = (error: unknown) => this.debug('Storage error', error);
    this.logQueue = new PersistentQueue<ApiLog>('apistudio.logs', this.options.maxQueueSize, storage, onError);
    this.errorQueue = new PersistentQueue<ErrorEvent>('apistudio.errors', this.options.maxQueueSize, storage, onError);
    const common = { apiKey: options.apiKey, fetch: adapter.fetch, log: (m: string) => this.debug(m) };
    this.logUploader = new Uploader({
      ...common,
      url: `${this.options.baseUrl}/api/v1/logs/batch`,
      queue: this.logQueue,
      wrap: (logs) => ({ logs }),
      batchSize: LOG_BATCH,
      shrink: shrinkLog,
    });
    this.errorUploader = new Uploader({
      ...common,
      url: `${this.options.baseUrl}/api/v1/errors/batch`,
      queue: this.errorQueue,
      wrap: (events) => ({ events }),
      batchSize: ERROR_BATCH,
      shrink: shrinkError,
    });
  }

  get enabled(): boolean {
    return this.options.enabled !== false;
  }

  /** Hooks up automatic capture and starts sending. Called by `ApiStudio.init`. */
  start(): void {
    if (!this.enabled) return;
    void this.loadInstallId();
    try {
      this.uninstall = this.adapter.install?.(this);
    } catch (error) {
      this.debug('Could not install instrumentation', error);
    }
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.(); // never keep a Node process alive
    void this.flush();
  }

  close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.uninstall?.();
    this.uninstall = undefined;
    return this.flush(true);
  }

  // ---- context --------------------------------------------------------

  setUser(user: UserInfo | null): void {
    this.user = user ?? undefined;
  }

  setApp(app: AppInfo): void {
    this.app = { ...this.app, ...app };
  }

  device(): DeviceInfo {
    let device: DeviceInfo = {};
    try {
      device = this.adapter.device();
    } catch {
      // A missing native module must never break logging.
    }
    return this.installId ? { ...device, install_id: this.installId } : device;
  }

  private context() {
    return {
      session_id: this.sessionId,
      device: this.device(),
      ...(this.app ? { app: this.app } : {}),
      ...(this.user ? { user: this.user } : {}),
      sdk: this.adapter.sdk,
    };
  }

  // ---- network --------------------------------------------------------

  /** False for API Studio's own uploads and for ignored URLs. */
  shouldCapture(url: string): boolean {
    if (!this.enabled || this.options.captureNetwork === false || !url) return false;
    if (url.startsWith(this.options.baseUrl)) return false;
    return !(this.options.ignoreUrls ?? []).some((rule) => (typeof rule === 'string' ? url.includes(rule) : rule.test(url)));
  }

  recordRequest(input: RecordedRequest): void {
    if (!this.shouldCapture(input.url)) return;
    try {
      const statusCode = input.statusCode ?? 0;
      const failed = Boolean(input.error) || input.cancelled || statusCode === 0 || statusCode >= 400;
      const request = input.requestBody ?? { body: null, sizeBytes: null, truncated: false };
      const response = input.responseBody ?? { body: null, sizeBytes: null, truncated: false };
      let log: ApiLog | null = {
        method: (input.method || 'GET').toUpperCase(),
        url: this.redactor.redactUrl(input.url),
        status_code: statusCode,
        duration_ms: Math.max(0, Math.round(input.durationMs)),
        status: input.cancelled ? 'cancelled' : failed ? 'error' : 'success',
        query_params: this.redactor.redactQuery(parseQuery(input.url)),
        request: {
          headers: this.redactor.redactHeaders(input.requestHeaders),
          body: this.redactor.redactBody(request.body),
          size_bytes: request.sizeBytes,
        },
        response: {
          headers: this.redactor.redactHeaders(input.responseHeaders),
          body: this.redactor.redactBody(response.body),
          size_bytes: response.sizeBytes,
        },
        error: input.error ?? null,
        is_truncated: request.truncated || response.truncated,
        timestamp: new Date(input.startedAt).toISOString(),
        ...this.context(),
      };
      this.addHttpBreadcrumb(log);
      if (this.options.beforeSendLog) log = this.options.beforeSendLog(log);
      if (log) this.logQueue.push(log);
    } catch (error) {
      this.debug('Could not record a request', error);
    }
  }

  /** Captures a body string the caller already read, e.g. from a manual integration. */
  captureBody(text: string | null | undefined): CapturedBody {
    return captureText(text, this.options.maxBodyChars);
  }

  private addHttpBreadcrumb(log: ApiLog): void {
    const path = log.url.split('?')[0]!;
    this.addBreadcrumb({
      category: 'http',
      message: `${log.method} ${path} ${log.status_code || 'failed'}`,
      level: log.status === 'success' ? 'info' : 'error',
      timestamp: log.timestamp,
      data: {
        method: log.method,
        url: path,
        status_code: log.status_code,
        duration_ms: log.duration_ms,
        ...(log.error ? { error: log.error.slice(0, 200) } : {}),
      },
    });
  }

  // ---- errors ---------------------------------------------------------

  addBreadcrumb(breadcrumb: Breadcrumb): void {
    if (!this.enabled) return;
    const message = breadcrumb.message;
    this.breadcrumbs.push({
      ...breadcrumb,
      timestamp: breadcrumb.timestamp ?? new Date().toISOString(),
      ...(message && message.length > MAX_BREADCRUMB_MESSAGE ? { message: `${message.slice(0, MAX_BREADCRUMB_MESSAGE)}…` } : {}),
    });
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) this.breadcrumbs.splice(0, this.breadcrumbs.length - MAX_BREADCRUMBS);
  }

  captureException(error: unknown, context: CaptureContext = {}): void {
    if (!this.enabled) return;
    try {
      const { type, message, stack } = describeError(error);
      let event: ErrorEvent | null = {
        exception_type: type.slice(0, 200),
        message: (context.message ?? message)?.slice(0, MAX_MESSAGE_CHARS),
        ...(stack ? { stack_trace: stack.slice(0, MAX_STACK_CHARS) } : {}),
        fatal: context.fatal ?? false,
        handled: context.handled ?? true,
        timestamp: new Date().toISOString(),
        ...(context.fingerprint?.length ? { fingerprint: context.fingerprint } : {}),
        breadcrumbs: [...this.breadcrumbs],
        ...(context.tags && Object.keys(context.tags).length ? { tags: context.tags } : {}),
        ...(context.extra && Object.keys(context.extra).length
          ? { extra: this.redactor.redactBody(context.extra) as Record<string, unknown> }
          : {}),
        ...this.context(),
      };
      if (this.options.beforeSendError) event = this.options.beforeSendError(event);
      if (event) this.errorQueue.push(event);
    } catch (failure) {
      this.debug('Could not capture an error', failure);
    }
  }

  captureMessage(message: string, context: CaptureContext = {}): void {
    this.captureException({ name: 'Message', message, stack: undefined }, { handled: true, ...context });
  }

  // ---- delivery -------------------------------------------------------

  /** Sends everything queued now. Errors go first. */
  async flush(force = false): Promise<void> {
    try {
      await this.errorUploader.flush(force);
      await this.logUploader.flush(force);
    } catch (error) {
      this.debug('Flush failed', error);
    }
  }

  /** Saves both queues right away; crash handlers await this before the app dies. */
  persist(): Promise<void> {
    return Promise.all([this.errorQueue.persistNow(), this.logQueue.persistNow()]).then(() => undefined);
  }

  private async loadInstallId(): Promise<void> {
    const storage = this.options.storage ?? this.adapter.storage;
    try {
      const saved = storage ? await storage.getItem(INSTALL_ID_KEY) : null;
      this.installId = saved || randomId();
      if (!saved && storage) await storage.setItem(INSTALL_ID_KEY, this.installId);
    } catch {
      this.installId ??= randomId();
    }
  }

  debug(message: string, detail?: unknown): void {
    if (this.options.debug) console.log(`[API Studio] ${message}`, detail ?? '');
  }
}

function shrinkLog(log: ApiLog): ApiLog | null {
  if (log.request?.body == null && log.response?.body == null) return null;
  return {
    ...log,
    request: { ...log.request, body: null },
    response: { ...log.response, body: null },
    is_truncated: true,
  };
}

/** One smaller retry for a 413: last 10 breadcrumbs without data, no extra. Null once already shrunk. */
function shrinkError(event: ErrorEvent): ErrorEvent | null {
  const crumbs = event.breadcrumbs ?? [];
  const alreadySmall = !event.extra && crumbs.length <= 10 && crumbs.every((crumb) => crumb.data === undefined);
  if (alreadySmall) return null;
  const { extra: _extra, ...rest } = event;
  return { ...rest, breadcrumbs: crumbs.slice(-10).map(({ data: _data, ...crumb }) => crumb) };
}

export function describeError(error: unknown): { type: string; message?: string; stack?: string } {
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown; constructor?: { name?: string } };
    const ctor = e.constructor?.name;
    const name = typeof e.name === 'string' && e.name ? e.name : undefined;
    const type = name && name !== 'Error' ? name : ctor && ctor !== 'Object' ? ctor : name ?? 'Error';
    const message = typeof e.message === 'string' ? e.message : safeStringify(error);
    return { type, message, stack: typeof e.stack === 'string' ? e.stack : undefined };
  }
  if (typeof error === 'string') return { type: 'Error', message: error };
  return { type: typeof error, message: String(error) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, MAX_MESSAGE_CHARS) ?? String(value);
  } catch {
    return String(value);
  }
}

export function randomId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
