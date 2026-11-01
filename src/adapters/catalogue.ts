import { z } from 'zod';
import type { SystemConfig } from '../config.js';
import { HttpError } from '../errors.js';
import { TtlCache } from '../resilience/cache.js';
import { ResilientFetcher, type Outcome } from '../resilience/resilientFetcher.js';
import { withRetry } from '../resilience/retry.js';
import { requestJson } from './http.js';

const modelAssetsSchema = z.object({
  modelId: z.string(),
  lod: z.object({ low: z.string(), medium: z.string(), high: z.string() }),
});

/** The catalogue's response contract. A response that does not match is rejected in `requestJson`. */
const catalogueVariantSchema = z.object({
  variantCode: z.string(),
  kind: z.enum(['drive', 'cabinet', 'panel']),
  frame: z.string().optional(),
  ratedKw: z.number().positive().optional(),
  ipRating: z.string(),
  description: z.string(),
  dimensionsMm: z.object({ w: z.number(), h: z.number(), d: z.number() }),
  model: modelAssetsSchema,
});

const exportSchema = z.object({ exportedAt: z.string(), variants: z.array(catalogueVariantSchema) });

export type ModelAssets = z.infer<typeof modelAssetsSchema>;
export type CatalogueVariant = z.infer<typeof catalogueVariantSchema>;

export interface CatalogueSearch {
  text?: string;
  kind?: CatalogueVariant['kind'];
  minKw?: number;
  maxKw?: number;
  ipRating?: string;
  limit?: number;
}

interface ReadModel {
  variants: CatalogueVariant[];
  exportedAt: string;
  loadedAt: number;
}

/**
 * Catalogue adapter.
 * - `getVariant` reads one variant from the catalogue service and caches it for `ttlMs`.
 * - `search` runs on a read model loaded from the bulk export and refreshed every `ttlMs`, so a search
 *   never calls the catalogue. In production the read model is a PostgreSQL table fed by the nightly
 *   export and the change feed, with full-text search.
 */
export class CatalogueAdapter {
  readonly fetcher: ResilientFetcher<CatalogueVariant>;
  private readModel: ReadModel | undefined;
  private loading: Promise<ReadModel> | undefined;

  constructor(
    private readonly config: SystemConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.fetcher = new ResilientFetcher('Catalogue', new TtlCache(config.ttlMs, config.staleMaxMs, now));
  }

  getVariant(variantCode: string, budgetMs: number): Promise<Outcome<CatalogueVariant>> {
    const url = `${this.config.baseUrl}/variants/${encodeURIComponent(variantCode)}`;
    return this.fetcher.get(
      variantCode,
      async () => ({
        value: await withRetry(
          () => requestJson('Catalogue', url, catalogueVariantSchema, { timeoutMs: this.config.timeoutMs }),
          this.config.retry,
        ),
      }),
      budgetMs,
    );
  }

  async search(query: CatalogueSearch) {
    const model = await this.currentReadModel();
    const words = (query.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const matches = model.variants
      .filter((variant) => {
        const haystack = `${variant.variantCode} ${variant.description}`.toLowerCase();
        return (
          words.every((word) => haystack.includes(word)) &&
          (!query.kind || variant.kind === query.kind) &&
          (!query.ipRating || variant.ipRating.toLowerCase() === query.ipRating.toLowerCase()) &&
          (query.minKw === undefined || (variant.ratedKw ?? 0) >= query.minKw) &&
          (query.maxKw === undefined || (variant.ratedKw ?? Infinity) <= query.maxKw)
        );
      })
      .sort((a, b) => (a.ratedKw ?? 0) - (b.ratedKw ?? 0) || a.variantCode.localeCompare(b.variantCode));

    return {
      total: matches.length,
      catalogueAsOf: model.exportedAt,
      results: matches.slice(0, Math.min(query.limit ?? 10, 50)),
    };
  }

  /** Fresh read model, a refresh when it is older than `ttlMs`, or the old one if the refresh fails. */
  private async currentReadModel(): Promise<ReadModel> {
    const current = this.readModel;
    if (current && this.now() - current.loadedAt < this.config.ttlMs) return current;

    this.loading ??= withRetry(
      () => requestJson('Catalogue', `${this.config.baseUrl}/export`, exportSchema, { timeoutMs: this.config.timeoutMs }),
      this.config.retry,
    )
      .then(({ exportedAt, variants }) => (this.readModel = { variants, exportedAt, loadedAt: this.now() }))
      .finally(() => (this.loading = undefined));

    try {
      return await this.loading;
    } catch {
      if (current) return current;
      throw new HttpError(503, 'catalogue_unavailable', 'The catalogue has not been loaded yet and its export is unavailable');
    }
  }
}
