import { PersistentQueue } from './queue';

export type Outcome = 'accepted' | 'dropped' | 'tooLarge' | 'retryLater';

/** Retry rules from the protocol: drop what can never succeed, keep the rest. */
export function classify(status: number): Outcome {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 413) return 'tooLarge';
  if (status === 400 || status === 404 || status === 410 || status === 422) return 'dropped';
  return 'retryLater'; // 401/403, 408, 429, 5xx
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export interface UploaderOptions<T> {
  url: string;
  apiKey: string;
  fetch: typeof fetch;
  queue: PersistentQueue<T>;
  /** Wraps a batch into the request body, e.g. `{logs: batch}`. */
  wrap: (batch: T[]) => unknown;
  batchSize: number;
  /** A smaller copy of an item that was rejected as too large, or null to drop it. */
  shrink?: (item: T) => T | null;
  log: (message: string) => void;
}

/** Sends one queue in batches, one request at a time, with exponential backoff. */
export class Uploader<T> {
  private sending?: Promise<void>;
  private failures = 0;
  private retryAt = 0;
  private batchSize: number;

  constructor(private readonly options: UploaderOptions<T>) {
    this.batchSize = options.batchSize;
  }

  /**
   * Sends what is queued when the flush starts. Items queued meanwhile wait
   * for the next flush, so a busy app never turns one flush into a stream of
   * tiny requests. Resolves when done or when a retry is pending.
   */
  flush(force = false): Promise<void> {
    if (!force && Date.now() < this.retryAt) return Promise.resolve();
    this.sending ??= this.sendAll().finally(() => {
      this.sending = undefined;
    });
    return this.sending;
  }

  private async sendAll(): Promise<void> {
    const { queue } = this.options;
    await queue.load();
    let left = queue.size;
    while (left > 0 && queue.size > 0) {
      const batch = queue.peek(Math.min(this.batchSize, left));
      let outcome: Outcome;
      try {
        outcome = classify(await this.post(batch));
      } catch {
        outcome = 'retryLater'; // offline, DNS, timeout
      }
      switch (outcome) {
        case 'accepted':
        case 'dropped':
          if (outcome === 'dropped') this.options.log(`Dropped ${batch.length} rejected item(s).`);
          queue.drop(batch.length);
          left -= batch.length;
          this.failures = 0;
          this.retryAt = 0;
          this.batchSize = this.options.batchSize;
          break;
        case 'tooLarge':
          if (batch.length > 1) {
            this.batchSize = Math.max(1, Math.floor(batch.length / 2));
          } else {
            // shrink() returns null for an item it already shrank, so this ends.
            const smaller = this.options.shrink?.(batch[0]!);
            if (smaller) {
              queue.replaceFirst(smaller);
              this.options.log('Retrying an oversized item without bodies.');
            } else {
              queue.drop(1);
              left -= 1;
            }
          }
          break;
        case 'retryLater':
          this.failures++;
          this.retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(this.failures, 10));
          this.options.log(`Upload paused; retrying in ${Math.round((this.retryAt - Date.now()) / 1000)} s.`);
          return;
      }
    }
  }

  private async post(batch: T[]): Promise<number> {
    const response = await this.options.fetch(this.options.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify(this.options.wrap(batch)),
    });
    return response.status;
  }
}
