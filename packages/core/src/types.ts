/** Wire types for the API Studio ingestion protocol (backend docs/sdk-protocol.md). */

export interface SdkInfo {
  name: string;
  version: string;
  platform: 'react-native' | 'browser' | 'node' | string;
}

export interface DeviceInfo {
  os?: string;
  os_version?: string;
  model?: string;
  install_id?: string;
  [key: string]: unknown;
}

export interface AppInfo {
  name?: string;
  version?: string;
  build?: string;
}

export interface UserInfo {
  id?: string;
  email?: string;
  name?: string;
  username?: string;
  [key: string]: unknown;
}

export type LogStatus = 'success' | 'error' | 'cancelled';

export interface LogPayload {
  headers?: Record<string, string> | null;
  body?: unknown;
  size_bytes?: number | null;
}

export interface ApiLog {
  method: string;
  url: string;
  status_code: number;
  duration_ms: number;
  status: LogStatus;
  query_params?: Record<string, string | string[]> | null;
  request?: LogPayload;
  response?: LogPayload;
  error?: string | null;
  is_truncated?: boolean;
  timestamp: string;
  session_id?: string;
  device?: DeviceInfo;
  app?: AppInfo;
  user?: UserInfo;
  sdk?: SdkInfo;
}

export interface Breadcrumb {
  timestamp?: string;
  category: 'http' | 'navigation' | 'log' | 'user' | string;
  message?: string;
  level?: 'debug' | 'info' | 'warning' | 'error' | string;
  data?: Record<string, unknown>;
}

export interface StackFrame {
  function?: string;
  file?: string;
  module?: string;
  line?: number;
  column?: number;
  in_app?: boolean;
}

export interface ErrorEvent {
  exception_type: string;
  message?: string;
  stack_trace?: string;
  frames?: StackFrame[];
  fatal: boolean;
  handled: boolean;
  timestamp: string;
  session_id?: string;
  fingerprint?: string[];
  breadcrumbs?: Breadcrumb[];
  device?: DeviceInfo;
  app?: AppInfo;
  user?: UserInfo;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  sdk?: SdkInfo;
}

/** AsyncStorage, localStorage, or a file-backed store: sync or async both work. */
export interface KeyValueStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface CaptureContext {
  fatal?: boolean;
  handled?: boolean;
  message?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
}

export interface ApiStudioOptions {
  /** The project/environment key from the API Studio portal. */
  apiKey: string;
  /** Defaults to the hosted API Studio backend. */
  baseUrl?: string;
  /** Turn the SDK off (e.g. in production builds) without removing calls. Default true. */
  enabled?: boolean;
  /** Record network requests automatically. Default true. */
  captureNetwork?: boolean;
  /** Report uncaught errors and unhandled rejections automatically. Default true. */
  captureErrors?: boolean;
  app?: AppInfo;
  user?: UserInfo;
  /** Extra header names to redact (added to the defaults). */
  redactHeaders?: string[];
  /** Extra JSON body keys / query parameters to redact (added to the defaults). */
  redactKeys?: string[];
  /** Set false to redact only your own lists. Default true. */
  includeDefaultRedaction?: boolean;
  /** Requests to these URLs are never logged (substring or RegExp). */
  ignoreUrls?: Array<string | RegExp>;
  /** Body characters kept per request/response. Default 65536. */
  maxBodyChars?: number;
  /**
   * How long logs wait to be sent together. Default 10000 ms. A full batch
   * (50 logs) goes at once, a failed call shortens the wait to 2 s, and
   * errors are sent immediately with the logs that led to them.
   */
  flushIntervalMs?: number;
  /** Items kept per queue while offline; the oldest are dropped. Default 500. */
  maxQueueSize?: number;
  /** Persists the offline queue across launches. */
  storage?: KeyValueStorage;
  /** Change or drop (return null) a log before it is queued. */
  beforeSendLog?: (log: ApiLog) => ApiLog | null;
  /** Change or drop (return null) an error before it is queued. */
  beforeSendError?: (event: ErrorEvent) => ErrorEvent | null;
  /** Print SDK diagnostics to the console. */
  debug?: boolean;
}

/** What a platform package supplies to the shared client. */
export interface PlatformAdapter {
  sdk: SdkInfo;
  /** The un-instrumented fetch used for uploads, so they are never logged. */
  fetch: typeof fetch;
  device(): DeviceInfo;
  storage?: KeyValueStorage;
  /** Hook up automatic capture; returns a function that undoes it. */
  install?(client: import('./client').ApiStudioClient): () => void;
}
