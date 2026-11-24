/** Turns request/response bodies into what the protocol stores. */

export interface CapturedBody {
  body: unknown;
  sizeBytes: number | null;
  truncated: boolean;
}

const TEXTUAL = /json|text|xml|javascript|x-www-form-urlencoded|graphql/i;

export function isTextualContentType(contentType: string | null | undefined): boolean {
  // No content type: most APIs that omit it still return JSON or text.
  return !contentType || TEXTUAL.test(contentType);
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** JSON text becomes an object (so the portal can pretty-print it), other text stays a string. */
export function captureText(text: string | null | undefined, maxChars: number): CapturedBody {
  if (text === null || text === undefined || text === '') return { body: null, sizeBytes: text === '' ? 0 : null, truncated: false };
  const sizeBytes = utf8Length(text);
  if (text.length > maxChars) return { body: `${text.slice(0, maxChars)}…`, sizeBytes, truncated: true };
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { body: JSON.parse(text), sizeBytes, truncated: false };
    } catch {
      // Not JSON after all.
    }
  }
  return { body: text, sizeBytes, truncated: false };
}

/** A request body passed to fetch / XHR send, in any of the forms they accept. */
export function captureRequestBody(body: unknown, maxChars: number): CapturedBody {
  if (body === null || body === undefined) return { body: null, sizeBytes: null, truncated: false };
  if (typeof body === 'string') return captureText(body, maxChars);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return captureText(body.toString(), maxChars);
  if (typeof FormData !== 'undefined' && body instanceof FormData) return { body: describeFormData(body), sizeBytes: null, truncated: false };
  if (typeof Blob !== 'undefined' && body instanceof Blob) return { body: null, sizeBytes: body.size, truncated: false };
  if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
    return { body: null, sizeBytes: (body as ArrayBuffer).byteLength, truncated: false };
  }
  return { body: null, sizeBytes: null, truncated: false }; // streams and unknown types
}

function describeFormData(form: FormData): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  // React Native's FormData has getParts() instead of entries().
  const rn = form as unknown as { getParts?: () => Array<{ fieldName: string; string?: string; name?: string }> };
  if (typeof rn.getParts === 'function') {
    for (const part of rn.getParts()) fields[part.fieldName] = part.string ?? `[file${part.name ? `: ${part.name}` : ''}]`;
    return fields;
  }
  const entries = (form as unknown as { entries?: () => Iterable<[string, unknown]> }).entries;
  if (typeof entries !== 'function') return { _form: '[FormData]' };
  for (const [key, value] of entries.call(form)) {
    fields[key] = typeof value === 'string' ? value : `[file${(value as { name?: string })?.name ? `: ${(value as { name: string }).name}` : ''}]`;
  }
  return fields;
}
