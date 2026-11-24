/** On-device redaction, with the same defaults as the Flutter SDK. */

export const REDACTED = '***REDACTED***';

export const DEFAULT_REDACT_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'];

export const DEFAULT_REDACT_KEYS = [
  'password',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'api_key',
  'authorization',
  'card_number',
  'cvv',
];

/** Case-insensitive and ignores `_` / `-`, so `accessToken` matches `access_token`. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export class Redactor {
  private readonly headers: Set<string>;
  private readonly keys: Set<string>;

  constructor(options: { headers?: string[]; keys?: string[]; includeDefaults?: boolean } = {}) {
    const defaults = options.includeDefaults !== false;
    this.headers = new Set(
      [...(defaults ? DEFAULT_REDACT_HEADERS : []), ...(options.headers ?? [])].map((h) => h.toLowerCase()),
    );
    this.keys = new Set([...(defaults ? DEFAULT_REDACT_KEYS : []), ...(options.keys ?? [])].map(normalizeKey));
  }

  isSecretKey(key: string): boolean {
    return this.keys.has(normalizeKey(key));
  }

  redactHeaders(headers: Record<string, string> | null | undefined): Record<string, string> | null {
    if (!headers) return null;
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      result[name] = this.headers.has(lower) || this.isSecretKey(lower) ? REDACTED : value;
    }
    return result;
  }

  redactBody(value: unknown, depth = 0): unknown {
    if (depth > 20 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => this.redactBody(item, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = this.isSecretKey(key) ? REDACTED : this.redactBody(item, depth + 1);
    }
    return result;
  }

  redactQuery(query: Record<string, string | string[]> | null): Record<string, string | string[]> | null {
    if (!query) return null;
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(query)) {
      result[key] = this.isSecretKey(key) ? REDACTED : value;
    }
    return result;
  }

  /** Redacts secret query parameters inside a URL string. */
  redactUrl(url: string): string {
    const queryStart = url.indexOf('?');
    if (queryStart < 0) return url;
    const hashStart = url.indexOf('#', queryStart);
    const query = url.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart);
    const redacted = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return pair;
        const key = safeDecode(pair.slice(0, eq));
        return this.isSecretKey(key) ? `${pair.slice(0, eq)}=${encodeURIComponent(REDACTED)}` : pair;
      })
      .join('&');
    return url.slice(0, queryStart + 1) + redacted + (hashStart < 0 ? '' : url.slice(hashStart));
  }
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** Parses the query string without relying on URL/URLSearchParams (incomplete on React Native). */
export function parseQuery(url: string): Record<string, string | string[]> | null {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return null;
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart);
  if (!query) return null;
  const result: Record<string, string | string[]> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = safeDecode(eq < 0 ? pair : pair.slice(0, eq));
    const value = eq < 0 ? '' : safeDecode(pair.slice(eq + 1));
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return Object.keys(result).length ? result : null;
}
