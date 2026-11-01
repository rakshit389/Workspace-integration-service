import Fastify from 'fastify';
import type { CatalogueData } from './catalogueData.js';

export interface PricingMockOptions {
  ratePerSecond: number;
  apiKey: string;
  failRate: number;
  random: () => number;
}

/** Pricing (ERP) mock: prices by country and customer group, a hard 5 req/s limit and a service-account key. */
export function createPricingMock(data: CatalogueData, overrides: Partial<PricingMockOptions> = {}) {
  const options: PricingMockOptions = { ratePerSecond: 5, apiKey: 'local-pricing-service-account', failRate: 0, random: Math.random, ...overrides };
  const stats = { calls: 0, rateLimited: 0 };
  const recent: number[] = [];
  const app = Fastify();

  app.get<{ Querystring: { variant?: string; country?: string; customerGroup?: string } }>('/prices', async (request, reply) => {
    stats.calls++;
    if (request.headers['x-api-key'] !== options.apiKey) return reply.code(401).send({ error: 'invalid service account' });

    const now = Date.now();
    while (recent.length > 0 && recent[0]! <= now - 1_000) recent.shift();
    if (recent.length >= options.ratePerSecond) {
      stats.rateLimited++;
      return reply.code(429).header('retry-after', '1').send({ error: 'rate limit exceeded' });
    }
    recent.push(now);

    if (options.random() < options.failRate) return reply.code(503).send({ error: 'ERP unavailable' });

    const { variant = '', country = '', customerGroup = 'standard' } = request.query;
    const base = data.pricing.baseEur[variant];
    const market = data.pricing.countries[country];
    const groupFactor = data.pricing.customerGroups[customerGroup];
    if (base === undefined) return reply.code(404).send({ error: 'no price for this variant' });
    if (!market || groupFactor === undefined) return reply.code(400).send({ error: 'unsupported country or customer group' });

    return {
      variantCode: variant,
      country,
      customerGroup,
      unitPrice: Math.round(base * market.rate * groupFactor * 100) / 100,
      currency: market.currency,
      leadTimeDays: data.pricing.leadTimeDays[variant] ?? 30,
      validUntil: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
    };
  });

  return { app, stats, options };
}
