import type { Adapters } from '../adapters/index.js';
import type { ModelAssets } from '../adapters/catalogue.js';
import type { SizingResult } from '../adapters/sizing.js';
import { policy, requireResize } from '../auth/policy.js';
import type { Item, Project, SizingInputs, User } from '../domain/types.js';
import { HttpError } from '../errors.js';
import type { InMemoryProjectRepository } from '../store/projectRepository.js';
import { groupByVariant, valueOf } from './bom.js';

export interface ResizeBody {
  motorKw: number;
  voltage?: number;
  baseRevision?: number;
}

export interface BomChangeLine {
  variantCode: string;
  quantityBefore: number;
  quantityAfter: number;
}

export type PriceDelta = { status: 'ok'; amount: number; currency: string } | { status: 'unavailable' };

/** Everything a re-size would change, worked out without writing anything. */
export interface ResizePlan {
  projectId: string;
  itemId: string;
  tag: string;
  baseRevision: number;
  previousVariant: string;
  inputs: SizingInputs;
  sizing: SizingResult;
  changed: boolean;
  variantCode: string;
  model?: ModelAssets;
  bomChange: { lines: BomChangeLine[]; priceDelta?: PriceDelta };
}

export interface PlanRequest {
  user: User;
  project: Project;
  item: Item;
  motorKw: number;
  voltage?: number;
  adapters: Adapters;
  budgetMs: number;
}

/** Runs sizing for the new inputs and works out the variant, 3D model and BOM change. Writes nothing. */
export async function planResize(request: PlanRequest): Promise<ResizePlan> {
  const { user, project, item, adapters, budgetMs } = request;
  requireResize(user);
  if (item.kind !== 'drive' || !item.sizingInputs) {
    throw new HttpError(422, 'not_resizable', `${item.tag} is a ${item.kind}; only drives can be re-sized`);
  }

  const inputs: SizingInputs = { ...item.sizingInputs, motorKw: request.motorKw, voltage: request.voltage ?? item.sizingInputs.voltage };
  const sizing = await adapters.sizing.size(inputs, user, budgetMs);
  // A re-size needs a fresh answer for these inputs; a stale or missing one is not good enough to change the BOM.
  if (sizing.status !== 'ok') {
    throw new HttpError(503, 'sizing_unavailable', `Re-size not applied: ${sizing.reason}`, { sizingStatus: sizing.status });
  }

  const base = {
    projectId: project.projectId,
    itemId: item.itemId,
    tag: item.tag,
    baseRevision: item.revision,
    previousVariant: item.variantCode,
    inputs,
    sizing: sizing.value,
  };
  if (sizing.value.variantCode === item.variantCode) {
    return { ...base, changed: false, variantCode: item.variantCode, bomChange: { lines: [] } };
  }

  const catalogueEntry = valueOf(await adapters.catalogue.getVariant(sizing.value.variantCode, budgetMs));
  if (!catalogueEntry) {
    throw new HttpError(503, 'catalogue_unavailable', `Re-size not applied: no catalogue data for ${sizing.value.variantCode}`);
  }

  const after = project.items.map((candidate) => (candidate.itemId === item.itemId ? { ...candidate, variantCode: sizing.value.variantCode } : candidate));
  return {
    ...base,
    changed: true,
    variantCode: sizing.value.variantCode,
    model: catalogueEntry.model,
    bomChange: {
      lines: diffQuantities(project.items, after),
      priceDelta: await priceDelta(user, project, item.variantCode, sizing.value.variantCode, adapters, budgetMs),
    },
  };
}

/** Writes a plan, but only if the item is still at the revision the plan was made from. */
export function applyResize(repo: InMemoryProjectRepository, plan: ResizePlan): Item {
  return repo.updateItem(
    plan.projectId,
    plan.itemId,
    plan.baseRevision,
    plan.changed ? { variantCode: plan.variantCode, modelRef: plan.model!.modelId, sizingInputs: plan.inputs } : { sizingInputs: plan.inputs },
  );
}

export function resizeResponse(plan: ResizePlan, updated: Item) {
  return {
    itemId: updated.itemId,
    tag: updated.tag,
    changed: plan.changed,
    previousVariant: plan.previousVariant,
    variantCode: updated.variantCode,
    modelRef: updated.modelRef,
    model: plan.model,
    revision: updated.revision,
    sizing: { frame: plan.sizing.frame, loadPct: plan.sizing.loadPct, inputs: updated.sizingInputs },
    bomChange: plan.bomChange,
  };
}

export interface ResizeRequest {
  user: User;
  projectId: string;
  itemId: string;
  body: ResizeBody;
  adapters: Adapters;
  repo: InMemoryProjectRepository;
  budgetMs: number;
}

/** The direct re-size used by the sizing panel: plan, then apply in one request. */
export async function resizeItem(request: ResizeRequest) {
  const { user, repo, body } = request;
  requireResize(user);
  const { project, item } = repo.getItem(request.projectId, request.itemId);
  if (body.baseRevision !== undefined && body.baseRevision !== item.revision) {
    throw new HttpError(409, 'revision_conflict', 'The item has changed since you loaded it', {
      expectedRevision: body.baseRevision,
      currentRevision: item.revision,
    });
  }
  const plan = await planResize({ user, project, item, motorKw: body.motorKw, voltage: body.voltage, adapters: request.adapters, budgetMs: request.budgetMs });
  return resizeResponse(plan, applyResize(repo, plan));
}

function diffQuantities(before: Item[], after: Item[]): BomChangeLine[] {
  const count = (items: Item[]) => new Map([...groupByVariant(items)].map(([code, group]) => [code, group.length]));
  const a = count(before);
  const b = count(after);
  return [...new Set([...a.keys(), ...b.keys()])]
    .map((variantCode) => ({ variantCode, quantityBefore: a.get(variantCode) ?? 0, quantityAfter: b.get(variantCode) ?? 0 }))
    .filter((line) => line.quantityBefore !== line.quantityAfter);
}

async function priceDelta(user: User, project: Project, fromVariant: string, toVariant: string, adapters: Adapters, budgetMs: number): Promise<PriceDelta | undefined> {
  if (!policy.canViewPrices(user)) return undefined;
  const quote = (variantCode: string) =>
    adapters.pricing.getQuote({ variantCode, country: user.country, customerGroup: project.customerGroup }, budgetMs).then(valueOf);
  const [from, to] = await Promise.all([quote(fromVariant), quote(toVariant)]);
  if (!from || !to) return { status: 'unavailable' };
  return { status: 'ok', amount: Math.round((to.unitPrice - from.unitPrice) * 100) / 100, currency: to.currency };
}
