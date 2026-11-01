import type { Adapters } from '../adapters/index.js';
import type { Item, Project, User } from '../domain/types.js';
import type { Outcome } from '../resilience/resilientFetcher.js';

export type PanelStatus = 'ok' | 'stale' | 'pending' | 'unavailable' | 'not_permitted';

export type PanelResponse =
  | { status: 'ok'; asOf: string; data: unknown }
  | { status: 'stale'; asOf: string; message: string; data: unknown }
  | { status: 'pending'; message: string; retryAfterMs: number }
  | { status: 'unavailable'; message: string }
  | { status: 'not_permitted' };

export interface PanelContext {
  user: User;
  project: Project;
  item: Item;
  adapters: Adapters;
  budgetMs: number;
}

/**
 * One sidebar panel = one enterprise system. A new system is added as one `*.panel.ts` file in this
 * folder; the registry discovers it and the sidebar endpoint includes it without other changes.
 */
export interface PanelDefinition {
  id: string;
  /** Position in the sidebar. */
  order: number;
  appliesTo(item: Item): boolean;
  /** Authorization for this panel. Checked before `load`, so a denied system is never called. */
  isPermitted(user: User): boolean;
  load(context: PanelContext): Promise<PanelResponse>;
}

export function fromOutcome<T>(outcome: Outcome<T>, toData: (value: T) => unknown): PanelResponse {
  switch (outcome.status) {
    case 'ok':
      return { status: 'ok', asOf: new Date(outcome.asOf).toISOString(), data: toData(outcome.value) };
    case 'stale':
      return { status: 'stale', asOf: new Date(outcome.asOf).toISOString(), message: outcome.reason, data: toData(outcome.value) };
    case 'pending':
      return { status: 'pending', message: outcome.reason, retryAfterMs: 1_000 };
    case 'unavailable':
      return { status: 'unavailable', message: outcome.reason };
  }
}
