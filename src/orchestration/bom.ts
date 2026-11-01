import type { Adapters } from '../adapters/index.js';
import type { Quote } from '../adapters/pricing.js';
import { policy } from '../auth/policy.js';
import type { Item, Project, User } from '../domain/types.js';
import type { Outcome } from '../resilience/resilientFetcher.js';

export interface BomLine {
  variantCode: string;
  description: string | null;
  quantity: number;
  itemTags: string[];
  unitPrice?: number;
  currency?: string;
  leadTimeDays?: number;
  lineTotal?: number;
  priceStatus?: Outcome<Quote>['status'];
}

/** The BOM is derived from the layout: items grouped by variant, with quantities. It is never stored separately. */
export function groupByVariant(items: Item[]): Map<string, Item[]> {
  const groups = new Map<string, Item[]>();
  for (const item of items) groups.set(item.variantCode, [...(groups.get(item.variantCode) ?? []), item]);
  return groups;
}

export async function buildBom(user: User, project: Project, adapters: Adapters, budgetMs: number) {
  const groups = [...groupByVariant(project.items)];
  const variants = await Promise.all(groups.map(([code]) => adapters.catalogue.getVariant(code, budgetMs)));
  const lines: BomLine[] = groups.map(([variantCode, items], index) => ({
    variantCode,
    description: valueOf(variants[index]!)?.description ?? null,
    quantity: items.length,
    itemTags: items.map((item) => item.tag),
  }));

  // Denied means the ERP is not called and price fields are absent, not masked.
  if (!policy.canViewPrices(user)) return { projectId: project.projectId, pricing: { status: 'not_permitted' as const }, lines };

  const quotes = await Promise.all(
    lines.map((line) =>
      adapters.pricing.getQuote({ variantCode: line.variantCode, country: user.country, customerGroup: project.customerGroup }, budgetMs),
    ),
  );
  quotes.forEach((outcome, index) => {
    const line = lines[index]!;
    const quote = valueOf(outcome);
    line.priceStatus = outcome.status;
    if (quote) {
      Object.assign(line, {
        unitPrice: quote.unitPrice,
        currency: quote.currency,
        leadTimeDays: quote.leadTimeDays,
        lineTotal: round(quote.unitPrice * line.quantity),
      });
    }
  });

  const priced = lines.filter((line) => line.unitPrice !== undefined);
  const status = priced.length === 0 ? 'unavailable' : priced.length < lines.length ? 'partial' : lines.some((line) => line.priceStatus === 'stale') ? 'stale' : 'ok';
  const longest = priced.reduce<BomLine | undefined>((max, line) => (!max || line.leadTimeDays! > max.leadTimeDays! ? line : max), undefined);

  return {
    projectId: project.projectId,
    pricing: { status },
    lines,
    // Totals only when every line has a price; a partial total would mislead.
    totals:
      status === 'ok' || status === 'stale'
        ? {
            amount: round(priced.reduce((sum, line) => sum + line.lineTotal!, 0)),
            currency: priced[0]!.currency,
            longestLeadTime: { days: longest!.leadTimeDays, variantCode: longest!.variantCode, itemTags: longest!.itemTags },
          }
        : undefined,
  };
}

export const valueOf = <T>(outcome: Outcome<T>): T | undefined =>
  outcome.status === 'ok' || outcome.status === 'stale' ? outcome.value : undefined;

const round = (value: number) => Math.round(value * 100) / 100;
