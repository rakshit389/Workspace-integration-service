import { UpstreamError } from '../errors.js';
import type { RetryConfig } from '../config.js';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RetryOptions extends RetryConfig {
  shouldRetry?: (error: unknown) => boolean;
  random?: () => number;
}

export const isRetryable = (error: unknown) => error instanceof UpstreamError && error.retryable;

/** Exponential backoff with jitter. Honours Retry-After when the system sends one. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const shouldRetry = options.shouldRetry ?? isRetryable;
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= options.retries || !shouldRetry(error)) throw error;
      const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
      const jittered = ceiling / 2 + random() * (ceiling / 2);
      const retryAfter = error instanceof UpstreamError ? error.retryAfterMs : undefined;
      await sleep(Math.round(retryAfter ?? jittered));
    }
  }
}
