import { TtlCache } from './cache.js';
import { CircuitOpenError } from './circuitBreaker.js';
import { RateLimitWaitError } from './rateLimiter.js';
import { UpstreamError } from '../errors.js';

/** What a caller gets back within its time budget. Panels map this directly to their status. */
export type Outcome<T> =
  | { status: 'ok'; value: T; asOf: number }
  | { status: 'stale'; value: T; asOf: number; reason: string }
  | { status: 'pending'; reason: string }
  | { status: 'unavailable'; reason: string };

export interface Loaded<T> {
  value: T;
  /** Overrides the default TTL, e.g. a quote's own expiry. */
  ttlMs?: number;
}

type Raced<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

/**
 * Cache-first access to one enterprise system:
 * fresh cache → ok; otherwise one shared in-flight load (single flight) raced against the caller's budget.
 * A load that outlives the budget keeps running and fills the cache for the next request.
 */
export class ResilientFetcher<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(
    private readonly system: string,
    readonly cache: TtlCache<T>,
  ) {}

  async get(key: string, loader: () => Promise<Loaded<T>>, budgetMs: number): Promise<Outcome<T>> {
    const fresh = this.cache.getFresh(key);
    if (fresh) return { status: 'ok', value: fresh.value, asOf: fresh.storedAt };

    const result = await raceBudget(this.load(key, loader), budgetMs);
    if (result.kind === 'value') {
      return { status: 'ok', value: result.value, asOf: this.cache.getStale(key)?.storedAt ?? Date.now() };
    }

    const stale = this.cache.getStale(key);
    const reason = result.kind === 'timeout' ? `${this.system} is still working on this` : describe(result.error);
    if (stale) return { status: 'stale', value: stale.value, asOf: stale.storedAt, reason };
    return result.kind === 'timeout' ? { status: 'pending', reason } : { status: 'unavailable', reason };
  }

  private load(key: string, loader: () => Promise<Loaded<T>>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const flight = loader()
      .then(({ value, ttlMs }) => {
        this.cache.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    // The caller may stop waiting at its budget; the load still finishes and its failure is handled here.
    flight.catch(() => undefined);
    this.inFlight.set(key, flight);
    return flight;
  }
}

async function raceBudget<T>(promise: Promise<T>, budgetMs: number): Promise<Raced<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Raced<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(0, budgetMs));
  });
  try {
    return await Promise.race([
      promise.then((value): Raced<T> => ({ kind: 'value', value })).catch((error: unknown): Raced<T> => ({ kind: 'error', error })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  if (error instanceof CircuitOpenError || error instanceof RateLimitWaitError || error instanceof UpstreamError) {
    return error.message;
  }
  return 'unexpected error while calling the system';
}
