import type { Config } from '../config.js';
import { CatalogueAdapter } from './catalogue.js';
import { PricingAdapter } from './pricing.js';
import { SizingAdapter } from './sizing.js';

export interface Adapters {
  catalogue: CatalogueAdapter;
  sizing: SizingAdapter;
  pricing: PricingAdapter;
}

export function createAdapters(config: Config, now: () => number = Date.now): Adapters {
  return {
    catalogue: new CatalogueAdapter(config.catalogue, now),
    sizing: new SizingAdapter(config.sizing, now),
    pricing: new PricingAdapter(config.pricing, now),
  };
}
