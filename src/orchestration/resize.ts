import type { Adapters } from '../adapters/index.js';
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

export interface ResizeRequest {
  user: User;
  projectId: string;
  itemId: string;
  body: ResizeBody;
  adapters: Adapters;
  repo: InMemoryProjectRepository;
  budgetMs: number;
}

interface BomChangeLine {
  variantCode: string;
  quantityBefore: number;
  quantityAfter: number;
}

/**
 * Re-size flow: run sizing with the new inputs; if the recommended variant differs, update the item's
 * variant and 3D model reference in one revision-checked write and return how the BOM changed.
 */
export async function resizeItem(request: ResizeRequest) {
  const { user, adapters, repo, budgetMs } = request;
  requireResize(user);

  const { project, item } = repo.getItem(request.projectId, request.itemId);
  if (item.kind !== 'drive' || !item.sizingInputs) {
    throw new HttpError(422, 'not_resizable', `${item.tag} is a ${item.kind}; only drives can be re-sized`);
  }
  if (request.body.baseRevision !== undefined && request.body.baseRevision !== item.revision) {
    throw new HttpError(409, 'revision_conflict', 'The item has changed since you loaded it', {
      expectedRevision: request.body.baseRevision,
      currentRevision: item.revision,
    });
  }

  const inputs: SizingInputs = { ...item.sizingInputs, motorKw: request.body.motorKw, voltage: request.body.voltage ?? item.sizingInputs.voltage };
  const sizing = await adapters.sizing.size(inputs, user, budgetMs);
  // A re-size needs a fresh answer for these inputs; a stale or missing one is not good enough to change the BOM.
  if (sizing.status !== 'ok') {
    throw new HttpError(503, 'sizing_unavailable', `Re-size not applied: ${sizing.reason}`, { sizingStatus: sizing.status });
  }
  const result = sizing.value;

  if (result.variantCode === item.variantCode) {
    const updated = repo.updateItem(project.projectId, item.itemId, item.revision, { sizingInputs: inputs });
    return response(updated, item, result, { changed: false, lines: [] });
  }

  const variant = await adapters.catalogue.getVariant(result.variantCode, budgetMs);
  const catalogueEntry = valueOf(variant);
  if (!catalogueEntry) {
    throw new HttpError(503, 'catalogue_unavailable', `Re-size not applied: no catalogue data for ${result.variantCode}`);
  }

  const before = quantities(project.items);
  const updated = repo.updateItem(project.projectId, item.itemId, item.revision, {
    variantCode: result.variantCode,
    modelRef: catalogueEntry.model.modelId,
    sizingInputs: inputs,
  });
  const after = quantities(repo.getProject(project.projectId).items);

  const lines: BomChangeLine[] = [...new Set([...before.keys(), ...after.keys()])]
    .map((variantCode) => ({ variantCode, quantityBefore: before.get(variantCode) ?? 0, quantityAfter: after.get(variantCode) ?? 0 }))
    .filter((line) => line.quantityBefore !== line.quantityAfter);

  return response(updated, item, result, {
    changed: true,
    lines,
    model: catalogueEntry.model,
    priceDelta: await priceDelta(user, project, item.variantCode, result.variantCode, adapters, budgetMs),
  });
}

function response(
  updated: Item,
  previous: Item,
  sizing: { frame: string; variantCode: string; loadPct: number },
  change: { changed: boolean; lines: BomChangeLine[]; model?: unknown; priceDelta?: unknown },
) {
  return {
    itemId: updated.itemId,
    tag: updated.tag,
    changed: change.changed,
    previousVariant: previous.variantCode,
    variantCode: updated.variantCode,
    modelRef: updated.modelRef,
    model: change.model,
    revision: updated.revision,
    sizing: { frame: sizing.frame, loadPct: sizing.loadPct, inputs: updated.sizingInputs },
    bomChange: { lines: change.lines, priceDelta: change.priceDelta },
  };
}

function quantities(items: Item[]): Map<string, number> {
  return new Map([...groupByVariant(items)].map(([code, group]) => [code, group.length]));
}

async function priceDelta(user: User, project: Project, fromVariant: string, toVariant: string, adapters: Adapters, budgetMs: number) {
  if (!policy.canViewPrices(user)) return undefined;
  const quote = (variantCode: string) =>
    adapters.pricing.getQuote({ variantCode, country: user.country, customerGroup: project.customerGroup }, budgetMs).then(valueOf);
  const [from, to] = await Promise.all([quote(fromVariant), quote(toVariant)]);
  if (!from || !to) return { status: 'unavailable' };
  return { status: 'ok', amount: Math.round((to.unitPrice - from.unitPrice) * 100) / 100, currency: to.currency };
}
