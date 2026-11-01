import type { Adapters } from '../adapters/index.js';
import type { Item, Project, User } from '../domain/types.js';
import { HttpError } from '../errors.js';
import type { PanelDefinition, PanelResponse } from '../panels/types.js';

export interface SidebarRequest {
  user: User;
  project: Project;
  item: Item;
  adapters: Adapters;
  panels: PanelDefinition[];
  budgetMs: number;
}

/** Runs every applicable panel in parallel within one budget; each panel reports its own status. */
export async function buildSidebar(request: SidebarRequest) {
  const { item, project } = request;
  const applicable = request.panels.filter((panel) => panel.appliesTo(item));
  const entries = await Promise.all(applicable.map(async (panel) => [panel.id, await runPanel(panel, request)] as const));
  return {
    projectId: project.projectId,
    itemId: item.itemId,
    tag: item.tag,
    variantCode: item.variantCode,
    itemRevision: item.revision,
    panels: Object.fromEntries(entries),
  };
}

export async function buildPanel(request: SidebarRequest, panelId: string) {
  const panel = request.panels.find((candidate) => candidate.id === panelId && candidate.appliesTo(request.item));
  if (!panel) throw new HttpError(404, 'not_found', `Panel ${panelId} does not apply to item ${request.item.tag}`);
  return { itemId: request.item.itemId, itemRevision: request.item.revision, panel: panel.id, ...(await runPanel(panel, request)) };
}

async function runPanel(panel: PanelDefinition, request: SidebarRequest): Promise<PanelResponse> {
  if (!panel.isPermitted(request.user)) return { status: 'not_permitted' };
  try {
    return await panel.load({ user: request.user, project: request.project, item: request.item, adapters: request.adapters, budgetMs: request.budgetMs });
  } catch {
    // A bug in one panel must cost that panel only, never the whole sidebar.
    return { status: 'unavailable', message: 'This panel failed unexpectedly' };
  }
}
