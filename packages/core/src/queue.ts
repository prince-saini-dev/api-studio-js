import type { KeyValueStorage } from './types';

/**
 * A FIFO queue that survives restarts when storage is given.
 *
 * Writes are coalesced: many pushes in a row cause one storage write.
 * `persistNow()` is for crash handlers that must save before the process dies.
 */
export class PersistentQueue<T> {
  private items: T[] = [];
  private loaded = false;
  private writeScheduled = false;
  private loading?: Promise<void>;

  constructor(
    private readonly key: string,
    private readonly maxSize: number,
    private readonly storage?: KeyValueStorage,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  get size(): number {
    return this.items.length;
  }

  /** Loads items saved by an earlier launch, ahead of anything queued since. */
  load(): Promise<void> {
    if (this.loaded || !this.storage) {
      this.loaded = true;
      return Promise.resolve();
    }
    this.loading ??= (async () => {
      try {
        const raw = await this.storage!.getItem(this.key);
        const saved = raw ? (JSON.parse(raw) as unknown) : [];
        if (Array.isArray(saved)) this.items = [...(saved as T[]), ...this.items].slice(-this.maxSize);
      } catch (error) {
        this.onError(error);
      } finally {
        this.loaded = true;
      }
    })();
    return this.loading;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.maxSize) this.items.splice(0, this.items.length - this.maxSize);
    this.scheduleWrite();
  }

  peek(count: number): T[] {
    return this.items.slice(0, count);
  }

  /** Removes the first `count` items (the ones a `peek` returned). */
  drop(count: number): void {
    if (count <= 0) return;
    this.items.splice(0, count);
    this.scheduleWrite();
  }

  /** Replaces the first item (used to retry an oversized one without bodies). */
  replaceFirst(item: T): void {
    if (this.items.length) this.items[0] = item;
    this.scheduleWrite();
  }

  persistNow(): Promise<void> {
    this.writeScheduled = false;
    if (!this.storage) return Promise.resolve();
    // Never overwrite what an earlier launch saved before it has been read.
    if (!this.loaded) return this.load().then(() => this.persistNow());
    try {
      return Promise.resolve(this.storage.setItem(this.key, JSON.stringify(this.items))).catch(this.onError);
    } catch (error) {
      this.onError(error);
      return Promise.resolve();
    }
  }

  private scheduleWrite(): void {
    if (!this.storage || this.writeScheduled) return;
    this.writeScheduled = true;
    setTimeout(() => {
      if (this.writeScheduled) void this.persistNow();
    }, 0);
  }
}
