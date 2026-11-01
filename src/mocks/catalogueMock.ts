import Fastify from 'fastify';
import type { CatalogueData } from './catalogueData.js';

export interface CatalogueMockOptions {
  failRate: number;
  random: () => number;
}

/** Catalogue mock backed by the static JSON file. */
export function createCatalogueMock(data: CatalogueData, overrides: Partial<CatalogueMockOptions> = {}) {
  const options: CatalogueMockOptions = { failRate: 0, random: Math.random, ...overrides };
  const stats = { calls: 0 };
  const models = new Map(data.models.map((model) => [model.modelId, model]));
  const app = Fastify();

  app.get<{ Params: { code: string } }>('/variants/:code', async (request, reply) => {
    stats.calls++;
    if (options.random() < options.failRate) return reply.code(503).send({ error: 'catalogue unavailable' });
    const variant = data.variants.find((candidate) => candidate.variantCode === request.params.code);
    if (!variant) return reply.code(404).send({ error: 'unknown variant' });
    const { modelId, ...rest } = variant;
    return { ...rest, model: models.get(modelId) };
  });

  return { app, stats, options };
}
