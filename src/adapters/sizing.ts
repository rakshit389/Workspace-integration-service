import type { Config } from '../config.js';
import type { SizingInputs, User } from '../domain/types.js';
import { TtlCache } from '../resilience/cache.js';
import { CircuitBreaker, CircuitOpenError } from '../resilience/circuitBreaker.js';
import { ResilientFetcher, type Outcome } from '../resilience/resilientFetcher.js';
import { isRetryable, withRetry } from '../resilience/retry.js';
import { requestJson } from './http.js';

export interface SizingResult {
  frame: string;
  variantCode: string;
  loadPct: number;
}

/**
 * Sizing adapter: slow (seconds), rate-limited and down for maintenance every night, so every call goes
 * through retries with backoff and a circuit breaker. Results are cached by inputs + country.
 */
export class SizingAdapter {
  readonly fetcher: ResilientFetcher<SizingResult>;
  readonly breaker: CircuitBreaker;

  constructor(private readonly config: Config['sizing'], now: () => number = Date.now) {
    this.fetcher = new ResilientFetcher('Sizing tool', new TtlCache(config.ttlMs, config.staleMaxMs, now));
    this.breaker = new CircuitBreaker('Sizing tool', { ...config.breaker, now });
  }

  size(inputs: SizingInputs, user: User, budgetMs: number): Promise<Outcome<SizingResult>> {
    const key = [user.country, inputs.motorKw, inputs.voltage, inputs.ipRating].join('|');
    return this.fetcher.get(key, async () => ({ value: await this.call(inputs, user) }), budgetMs);
  }

  private call(inputs: SizingInputs, user: User): Promise<SizingResult> {
    return withRetry(
      () =>
        this.breaker.exec(() =>
          requestJson<SizingResult>('Sizing tool', `${this.config.baseUrl}/size`, {
            method: 'POST',
            // Production exchanges the user's token on-behalf-of for a sizing-scoped token; the mock accepts it as is.
            headers: { authorization: `Bearer ${user.token}` },
            body: inputs,
            timeoutMs: this.config.timeoutMs,
          }),
        ),
      { ...this.config.retry, shouldRetry: (error) => !(error instanceof CircuitOpenError) && isRetryable(error) },
    );
  }
}
