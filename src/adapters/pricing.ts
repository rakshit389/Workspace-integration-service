import { z } from 'zod';
import type { Config } from '../config.js';
import { TtlCache } from '../resilience/cache.js';
import { RateLimiter } from '../resilience/rateLimiter.js';
import { ResilientFetcher, type Outcome } from '../resilience/resilientFetcher.js';
import { withRetry } from '../resilience/retry.js';
import { requestJson } from './http.js';

/** The ERP's quote contract. A response that does not match is rejected in `requestJson`. */
const quoteSchema = z.object({
  variantCode: z.string(),
  country: z.string().length(2),
  customerGroup: z.string(),
  unitPrice: z.number().nonnegative(),
  currency: z.string().length(3),
  leadTimeDays: z.number().int().nonnegative(),
  validUntil: z.string().datetime(),
});

export type Quote = z.infer<typeof quoteSchema>;

export interface QuoteRequest {
  variantCode: string;
  country: string;
  customerGroup: string;
}

/**
 * Pricing adapter: called with a service account, so it must only be reached after authorization.
 * Every call takes a slot from the shared 5 req/s limiter; prices are cached per variant, country and
 * customer group and never kept beyond the quote's own validity.
 */
export class PricingAdapter {
  readonly fetcher: ResilientFetcher<Quote>;
  readonly limiter: RateLimiter;

  constructor(
    private readonly config: Config['pricing'],
    private readonly now: () => number = Date.now,
  ) {
    this.fetcher = new ResilientFetcher('Pricing', new TtlCache(config.ttlMs, config.staleMaxMs, now));
    this.limiter = new RateLimiter('Pricing', config.ratePerSecond, now);
  }

  getQuote(request: QuoteRequest, budgetMs: number): Promise<Outcome<Quote>> {
    const key = [request.variantCode, request.country, request.customerGroup].join('|');
    return this.fetcher.get(
      key,
      async () => {
        const quote = await this.call(request);
        const ttlMs = Math.min(this.config.ttlMs, Date.parse(quote.validUntil) - this.now());
        return { value: quote, ttlMs };
      },
      budgetMs,
    );
  }

  private call(request: QuoteRequest): Promise<Quote> {
    const query = new URLSearchParams({ variant: request.variantCode, country: request.country, customerGroup: request.customerGroup });
    return withRetry(async () => {
      await this.limiter.acquire(this.config.maxQueueWaitMs);
      return requestJson('Pricing', `${this.config.baseUrl}/prices?${query}`, quoteSchema, {
        headers: { 'x-api-key': this.config.apiKey },
        timeoutMs: this.config.timeoutMs,
      });
    }, this.config.retry);
  }
}
