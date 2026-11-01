import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../src/errors.js';
import { TtlCache } from '../src/resilience/cache.js';
import { CircuitBreaker, CircuitOpenError } from '../src/resilience/circuitBreaker.js';
import { RateLimiter, RateLimitWaitError } from '../src/resilience/rateLimiter.js';
import { withRetry } from '../src/resilience/retry.js';
import { startTestEnv } from './helpers.js';

const retryable = () => new UpstreamError('test', 503, 'down', true);

describe('TtlCache', () => {
  it('separates fresh, stale and evicted values', () => {
    let now = 0;
    const cache = new TtlCache<string>(100, 50, () => now);
    cache.set('k', 'v');

    now = 99;
    expect(cache.getFresh('k')?.value).toBe('v');
    now = 120;
    expect(cache.getFresh('k')).toBeUndefined();
    expect(cache.getStale('k')?.value).toBe('v');
    now = 151;
    expect(cache.getStale('k')).toBeUndefined();
  });
});

describe('withRetry', () => {
  it('retries retryable errors and then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        if (++attempts < 3) throw retryable();
        return 'done';
      },
      { retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(result).toBe('done');
    expect(attempts).toBe(3);
  });

  it('does not retry a non-retryable error', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new UpstreamError('test', 404, 'missing', false);
        },
        { retries: 3, baseDelayMs: 1, maxDelayMs: 2 },
      ),
    ).rejects.toThrow('missing');
    expect(attempts).toBe(1);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, fails fast, then closes after a successful trial', async () => {
    let now = 0;
    const breaker = new CircuitBreaker('test', { failureThreshold: 2, cooldownMs: 1_000, now: () => now });
    const fail = () => breaker.exec(async () => Promise.reject(retryable()));

    await expect(fail()).rejects.toThrow('down');
    await expect(fail()).rejects.toThrow('down');
    expect(breaker.currentState).toBe('open');
    await expect(breaker.exec(async () => 'never')).rejects.toBeInstanceOf(CircuitOpenError);

    now = 1_000;
    expect(breaker.currentState).toBe('half_open');
    await expect(breaker.exec(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.currentState).toBe('closed');
  });

  it('re-opens when the half-open trial fails', async () => {
    let now = 0;
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 1_000, now: () => now });
    await expect(breaker.exec(async () => Promise.reject(retryable()))).rejects.toThrow();
    now = 1_000;
    await expect(breaker.exec(async () => Promise.reject(retryable()))).rejects.toThrow();
    expect(breaker.currentState).toBe('open');
  });
});

describe('RateLimiter', () => {
  it('spreads calls so no more than the limit start in one second', async () => {
    const limiter = new RateLimiter('test', 5);
    const started = Date.now();
    const times: number[] = [];
    await Promise.all(Array.from({ length: 7 }, () => limiter.acquire(5_000).then(() => times.push(Date.now() - started))));

    times.sort((a, b) => a - b);
    expect(times[4]!).toBeLessThan(200);
    expect(times[5]!).toBeGreaterThanOrEqual(1_000);
  });

  it('refuses to queue a caller beyond its maximum wait', async () => {
    const limiter = new RateLimiter('test', 1);
    await limiter.acquire(0);
    await expect(limiter.acquire(100)).rejects.toBeInstanceOf(RateLimitWaitError);
  });
});

describe('pricing adapter against the rate-limited ERP mock', () => {
  it('stays under 5 req/s, so the ERP never answers 429', async () => {
    const env = await startTestEnv();
    try {
      const variants = ['R5-IP54', 'R6-IP54', 'R7-IP54', 'R8-IP54', 'R9-IP54', 'R5-IP21', 'R6-IP21', 'R7-IP21'];
      const outcomes = await Promise.all(
        variants.map((variantCode) => env.adapters.pricing.getQuote({ variantCode, country: 'DE', customerGroup: 'standard' }, 5_000)),
      );

      expect(outcomes.every((outcome) => outcome.status === 'ok')).toBe(true);
      expect(env.mocks.pricing.stats.calls).toBe(8);
      expect(env.mocks.pricing.stats.rateLimited).toBe(0);
    } finally {
      await env.close();
    }
  });
});
