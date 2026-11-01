export interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

/**
 * In-memory TTL cache that keeps expired entries for a while, so a failing system can still be
 * answered with the last good value (`stale`). Production uses Redis behind the same interface.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly staleMaxMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  set(key: string, value: T, ttlMs: number = this.ttlMs): void {
    const storedAt = this.now();
    this.entries.set(key, { value, storedAt, expiresAt: storedAt + Math.max(0, ttlMs) });
  }

  /** Only a value that is still within its TTL. */
  getFresh(key: string): CacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    return entry && this.now() < entry.expiresAt ? entry : undefined;
  }

  /** Any value still inside the stale window, fresh or not. */
  getStale(key: string): CacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.expiresAt > this.staleMaxMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
