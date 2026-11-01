import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogueVariant, ModelAssets } from '../adapters/catalogue.js';

export interface CatalogueData {
  models: ModelAssets[];
  variants: Array<Omit<CatalogueVariant, 'model'> & { modelId: string }>;
  pricing: {
    baseEur: Record<string, number>;
    leadTimeDays: Record<string, number>;
    countries: Record<string, { currency: string; rate: number }>;
    customerGroups: Record<string, number>;
  };
}

export function loadCatalogueData(dataDir: string): CatalogueData {
  return JSON.parse(readFileSync(join(dataDir, 'catalogue.json'), 'utf8')) as CatalogueData;
}
