import { resolve } from 'node:path';
import { createAdapters } from './adapters/index.js';
import { buildApp } from './app.js';
import { defaultConfig } from './config.js';
import { loadCatalogueData } from './mocks/catalogueData.js';
import { createCatalogueMock } from './mocks/catalogueMock.js';
import { createPricingMock } from './mocks/pricingMock.js';
import { createSizingMock } from './mocks/sizingMock.js';
import { loadPanels } from './panels/registry.js';
import { InMemoryProjectRepository } from './store/projectRepository.js';

const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const config = defaultConfig();
const catalogueData = loadCatalogueData(dataDir);

// The three enterprise systems run as separate HTTP servers so the adapters make real network calls.
const mocks = [
  { name: 'catalogue', url: config.catalogue.baseUrl, server: createCatalogueMock(catalogueData) },
  { name: 'sizing', url: config.sizing.baseUrl, server: createSizingMock(catalogueData) },
  { name: 'pricing', url: config.pricing.baseUrl, server: createPricingMock(catalogueData, { apiKey: config.pricing.apiKey }) },
];
for (const mock of mocks) {
  const { hostname, port } = new URL(mock.url);
  await mock.server.app.listen({ host: hostname, port: Number(port) });
}

const app = await buildApp({
  config,
  repo: InMemoryProjectRepository.fromFile(resolve(dataDir, 'projects.json')),
  adapters: createAdapters(config),
  panels: await loadPanels(),
  logger: true,
});
await app.listen({ host: '0.0.0.0', port: config.port });

console.log(`
Workspace integration service on http://localhost:${config.port}
Mocks: ${mocks.map((mock) => `${mock.name} ${mock.url}`).join(', ')}
Get a token:  npm run -s token -- --role sales_engineer --country DE
`);

const shutdown = async () => {
  await app.close();
  await Promise.all(mocks.map((mock) => mock.server.app.close()));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
