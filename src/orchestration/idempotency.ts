import { HttpError } from '../errors.js';

interface Entry {
  fingerprint: string;
  result: Promise<unknown>;
  storedAt: number;
}

/**
 * Remembers the result of a write per idempotency key, so a double-click or a client retry runs the
 * re-size once. Failures are forgotten so the client can retry them. Production keeps this in Redis.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  run<T>(key: string, fingerprint: string, work: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && this.now() - existing.storedAt < this.ttlMs) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new HttpError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request'));
      }
      return existing.result as Promise<T>;
    }

    const result = work();
    this.entries.set(key, { fingerprint, result, storedAt: this.now() });
    result.catch(() => this.entries.delete(key));
    return result;
  }
}
