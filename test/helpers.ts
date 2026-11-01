import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createAdapters } from '../src/adapters/index.js';
import { buildApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { defaultConfig, mergeConfig, type Config, type DeepPartial } from '../src/config.js';
import { loadCatalogueData } from '../src/mocks/catalogueData.js';
import { createCatalogueMock, type CatalogueMockOptions } from '../src/mocks/catalogueMock.js';
import { createPricingMock, type PricingMockOptions } from '../src/mocks/pricingMock.js';
import { createSizingMock, type SizingMockOptions } from '../src/mocks/sizingMock.js';
import { loadPanels } from '../src/panels/registry.js';
import { InMemoryProjectRepository } from '../src/store/projectRepository.js';

const dataDir = fileURLToPath(new URL('../data', import.meta.url));

export const PROJECT = 'P-24117';
export const ITEMS = {
  'DRV-03': '3f6c1d2e-0a41-4b8e-9d1e-2b7c1f0a9e03',
  'DRV-04': '8a2d4f61-5c0b-4e3a-b7f2-6d9e1c4a8b04',
  'CAB-01': 'c41e9b7a-2f3d-4d8c-a0e5-7b1f6c2d9a01',
} as const;

export interface TestOptions {
  config?: DeepPartial<Config>;
  sizing?: Partial<SizingMockOptions>;
  pricing?: Partial<PricingMockOptions>;
  catalogue?: Partial<CatalogueMockOptions>;
}

const address = (app: FastifyInstance) => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

/** Starts the three mocks on random ports (fast and healthy by default) and builds the API against them. */
export async function startTestEnv(options: TestOptions = {}) {
  const data = loadCatalogueData(dataDir);
  const catalogue = createCatalogueMock(data, options.catalogue);
  const sizing = createSizingMock(data, { minLatencyMs: 5, maxLatencyMs: 5, failRate: 0, ...options.sizing });
  const pricing = createPricingMock(data, options.pricing);
  await Promise.all([catalogue, sizing, pricing].map((mock) => mock.app.listen({ host: '127.0.0.1', port: 0 })));

  const testDefaults: DeepPartial<Config> = {
    catalogue: { baseUrl: address(catalogue.app) },
    sizing: { baseUrl: address(sizing.app), retry: { baseDelayMs: 10, maxDelayMs: 20 } },
    pricing: { baseUrl: address(pricing.app), retry: { baseDelayMs: 10, maxDelayMs: 20 } },
  };
  const config = mergeConfig(mergeConfig(defaultConfig({}), testDefaults), options.config);

  const repo = InMemoryProjectRepository.fromFile(resolve(dataDir, 'projects.json'));
  const adapters = createAdapters(config);
  const app = await buildApp({ config, repo, adapters, panels: await loadPanels() });

  const token = (role = 'sales_engineer', country = 'DE', expiresIn: string | number = '1h') =>
    signToken(config.auth, { sub: `test-${role}`, role, country }, expiresIn);

  const request = async (method: 'GET' | 'POST', url: string, opts: { role?: string; country?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await token(opts.role, opts.country)}`, ...opts.headers },
      ...(opts.body === undefined ? {} : { payload: opts.body as object }),
    });

  const close = async () => {
    await app.close();
    await Promise.all([catalogue, sizing, pricing].map((mock) => mock.app.close()));
  };

  return { app, config, repo, adapters, mocks: { catalogue, sizing, pricing }, token, request, close };
}

export type TestEnv = Awaited<ReturnType<typeof startTestEnv>>;

export const sidebarUrl = (itemId: string) => `/projects/${PROJECT}/items/${itemId}/sidebar`;
export const resizeUrl = (itemId: string) => `/projects/${PROJECT}/items/${itemId}/resize`;
export const bomUrl = `/projects/${PROJECT}/bom`;
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
