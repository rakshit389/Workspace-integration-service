import { z } from 'zod';
import type { Adapters } from '../adapters/index.js';
import { requireKnownRole, requireProjectAccess } from '../auth/policy.js';
import type { Config } from '../config.js';
import type { Item, Project, User } from '../domain/types.js';
import { HttpError } from '../errors.js';
import { buildBom } from '../orchestration/bom.js';
import { proposeResize, type ProposalStore } from '../orchestration/proposals.js';
import { buildSidebar } from '../orchestration/sidebar.js';
import type { PanelDefinition } from '../panels/types.js';
import type { InMemoryProjectRepository } from '../store/projectRepository.js';
import type { AuditLog } from './audit.js';
import { toolDefinitions, type ToolArgs, type ToolName } from './toolDefinitions.js';

export interface ToolContext {
  config: Config;
  repo: InMemoryProjectRepository;
  adapters: Adapters;
  panels: PanelDefinition[];
  proposals: ProposalStore;
  audit: AuditLog;
  user: User;
}

interface ToolResult {
  outcome?: 'ok' | 'proposed';
  result: unknown;
}

const openProject = ({ repo, user }: ToolContext, id: string): Project => {
  const project = repo.getProject(id);
  requireProjectAccess(user, project);
  return project;
};

export const findItem = (project: Project, ref: string): Item => {
  const item = project.items.find((candidate) => candidate.itemId === ref || candidate.tag.toLowerCase() === ref.toLowerCase());
  if (!item) throw new HttpError(404, 'not_found', `Item ${ref} not found in project ${project.projectId}`);
  return item;
};

/**
 * In-process implementations, used by the API's own chat. Each runs as the context's user through the
 * same authorization, orchestration and adapters as the sidebar.
 */
const runners: { [N in ToolName]: (args: ToolArgs<N>, context: ToolContext) => Promise<ToolResult> } = {
  get_project_layout: async (args, context) => {
    const project = openProject(context, args.projectId);
    return {
      result: {
        projectId: project.projectId,
        name: project.name,
        items: project.items.map(({ itemId, tag, kind, variantCode, revision }) => ({ itemId, tag, kind, variantCode, revision })),
      },
    };
  },
  get_item_details: async (args, context) => {
    const project = openProject(context, args.projectId);
    const item = findItem(project, args.item);
    const { user, adapters, panels, config } = context;
    return { result: await buildSidebar({ user, project, item, adapters, panels, budgetMs: config.budgets.assistantMs }) };
  },
  get_bom_cost: async (args, context) => {
    const project = openProject(context, args.projectId);
    return { result: await buildBom(context.user, project, context.adapters, context.config.budgets.assistantMs) };
  },
  search_catalogue: async (args, context) => {
    requireKnownRole(context.user);
    // A maximum of 0 kW matches nothing, so it is read as "no limit".
    return { result: await context.adapters.catalogue.search({ ...args, maxKw: args.maxKw || undefined }) };
  },
  resize_item: async (args, context) => {
    const project = openProject(context, args.projectId);
    const item = findItem(project, args.item);
    const { user, adapters, proposals, config } = context;
    const result = await proposeResize({ user, project, item, motorKw: args.motorKw, voltage: args.voltage, adapters, proposals, budgetMs: config.budgets.resizeMs });
    return { outcome: result.status === 'confirmation_required' ? 'proposed' : 'ok', result };
  },
};

export interface ToolCallOutcome {
  isError: boolean;
  /** What the model sees: the JSON result, or `code: message` on failure. */
  text: string;
}

/** Validates the arguments, runs the tool as the context's user, and records it in the audit log. */
export async function runTool(name: string, rawArgs: unknown, context: ToolContext): Promise<ToolCallOutcome> {
  const { audit, user } = context;
  const definition = toolDefinitions.find((candidate) => candidate.name === name);
  if (!definition) {
    audit.record(user, { action: name, input: rawArgs, outcome: 'error', detail: 'unknown_tool' });
    return { isError: true, text: `unknown_tool: ${name} is not an available tool` };
  }

  const parsed = z.object(definition.shape).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    audit.record(user, { action: name, input: rawArgs, outcome: 'error', detail: 'invalid_arguments' });
    return { isError: true, text: `invalid_arguments: ${issue?.path.join('.') || 'arguments'}: ${issue?.message ?? 'invalid'}` };
  }

  try {
    const run = runners[name as ToolName] as (args: unknown, context: ToolContext) => Promise<ToolResult>;
    const { outcome = 'ok', result } = await run(parsed.data, context);
    audit.record(user, { action: name, input: parsed.data, outcome });
    return { isError: false, text: JSON.stringify(result, null, 2) };
  } catch (error) {
    const known = error instanceof HttpError;
    const denied = known && (error.statusCode === 403 || error.statusCode === 404);
    audit.record(user, { action: name, input: parsed.data, outcome: denied ? 'denied' : 'error', detail: known ? error.code : 'internal_error' });
    return { isError: true, text: known ? `${error.code}: ${error.message}` : 'internal_error: the tool failed unexpectedly' };
  }
}
