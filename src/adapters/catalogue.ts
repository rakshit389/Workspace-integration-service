import type { SystemConfig } from '../config.js';
import { TtlCache } from '../resilience/cache.js';
import { ResilientFetcher, type Outcome } from '../resilience/resilientFetcher.js';
import { withRetry } from '../resilience/retry.js';
import { requestJson } from './http.js';

export interface ModelAssets {
  modelId: string;
  lod: { low: string; medium: string; high: string };
}

export interface CatalogueVariant {
  variantCode: string;
  kind: 'drive' | 'cabinet' | 'panel';
  frame?: string;
  ratedKw?: number;
  ipRating: string;
  description: string;
  dimensionsMm: { w: number; h: number; d: number };
  model: ModelAssets;
}

/**
 * Catalogue adapter. In production the catalogue is a read model synced from the nightly export and
 * change feed; here it reads the mock catalogue service and caches each variant for `ttlMs`.
 */
export class CatalogueAdapter {
  readonly fetcher: ResilientFetcher<CatalogueVariant>;

  constructor(private readonly config: SystemConfig, now: () => number = Date.now) {
    this.fetcher = new ResilientFetcher('Catalogue', new TtlCache(config.ttlMs, config.staleMaxMs, now));
  }

  getVariant(variantCode: string, budgetMs: number): Promise<Outcome<CatalogueVariant>> {
    const url = `${this.config.baseUrl}/variants/${encodeURIComponent(variantCode)}`;
    return this.fetcher.get(
      variantCode,
      async () => ({
        value: await withRetry(
          () => requestJson<CatalogueVariant>('Catalogue', url, { timeoutMs: this.config.timeoutMs }),
          this.config.retry,
        ),
      }),
      budgetMs,
    );
  }
}
