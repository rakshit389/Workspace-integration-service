import Fastify from 'fastify';
import { sleep } from '../resilience/retry.js';
import type { CatalogueData } from './catalogueData.js';

export interface SizingMockOptions {
  minLatencyMs: number;
  maxLatencyMs: number;
  failRate: number;
  random: () => number;
}

interface SizeBody {
  motorKw: number;
  voltage: number;
  ipRating: string;
}

/** Sizing tool mock: 0.5–3 s per run and 20 % failures by default, as in the brief. */
export function createSizingMock(data: CatalogueData, overrides: Partial<SizingMockOptions> = {}) {
  const options: SizingMockOptions = { minLatencyMs: 500, maxLatencyMs: 3_000, failRate: 0.2, random: Math.random, ...overrides };
  const stats = { calls: 0, failures: 0 };
  const drives = data.variants
    .filter((variant) => variant.kind === 'drive' && variant.ratedKw !== undefined)
    .sort((a, b) => a.ratedKw! - b.ratedKw!);
  const app = Fastify();

  app.post<{ Body: SizeBody }>('/size', async (request, reply) => {
    stats.calls++;
    if (!request.headers.authorization) return reply.code(401).send({ error: 'delegated user token required' });

    const { motorKw, voltage, ipRating } = request.body ?? ({} as SizeBody);
    if (!(motorKw > 0) || !voltage || !ipRating) return reply.code(400).send({ error: 'motorKw, voltage and ipRating are required' });

    await sleep(options.minLatencyMs + options.random() * (options.maxLatencyMs - options.minLatencyMs));
    if (options.random() < options.failRate) {
      stats.failures++;
      return reply.code(503).send({ error: 'sizing engine unavailable' });
    }

    // The smallest frame that runs the motor at or below 95 % of its rating.
    const drive = drives.find((candidate) => candidate.ipRating === ipRating && (motorKw / candidate.ratedKw!) * 100 <= 95);
    if (!drive) return reply.code(422).send({ error: 'no frame is large enough for this motor' });
    return { frame: drive.frame, variantCode: drive.variantCode, loadPct: Math.round((motorKw / drive.ratedKw!) * 100) };
  });

  return { app, stats, options };
}
