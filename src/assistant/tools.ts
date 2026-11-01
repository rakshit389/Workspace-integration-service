import { z } from 'zod';
import type { Adapters } from '../adapters/index.js';
import { requireKnownRole, requireProjectAccess } from '../auth/policy.js';
import type { Config } from '../config.js';
import type { Item, Project, User } from '../domain/types.js';
import { HttpError } from '../errors.js';
import { buildBom } from '../orchestration/bom.js';
import type { ProposalStore } from '../orchestration/proposals.js';
import { planResize } from '../orchestration/resize.js';
import { buildSidebar } from '../orchestration/sidebar.js';
import type { PanelDefinition } from '../panels/types.js';
import type { InMemoryProjectRepository } from '../store/projectRepository.js';
import type { AuditLog } from './audit.js';

export interface AssistantDependencies {
  config: Config;
  repo: InMemoryProjectRepository;
  adapters: Adapters;
  panels: PanelDefinition[];
  proposals: ProposalStore;
  audit: AuditLog;
}

export interface ToolContext extends AssistantDependencies {
  user: User;
}

interface ToolResult {
  outcome?: 'ok' | 'proposed';
  result: unknown;
}

export interface AssistantTool {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
  run: (args: never, context: ToolContext) => Promise<ToolResult>;
}

const defineTool = <S extends z.ZodRawShape>(tool: {
  name: string;
  title: string;
  description: string;
  shape: S;
  readOnly: boolean;
  run: (args: z.infer<z.ZodObject<S>>, context: ToolContext) => Promise<ToolResult>;
}): AssistantTool => tool as unknown as AssistantTool;

const projectId = z.string().describe('Project ID, for example P-24117');
const itemRef = z.string().describe('Item tag such as DRV-03, or the item ID');

const openProject = ({ repo, user }: ToolContext, id: string): Project => {
  const project = repo.getProject(id);
  requireProjectAccess(user, project);
  return project;
};

const findItem = (project: Project, ref: string): Item => {
  const item = project.items.find((candidate) => candidate.itemId === ref || candidate.tag.toLowerCase() === ref.toLowerCase());
  if (!item) throw new HttpError(404, 'not_found', `Item ${ref} not found in project ${project.projectId}`);
  return item;
};

/**
 * The assistant's tools, shared by the MCP server and the chat endpoint. Each runs as the calling user
 * through the same authorization, orchestration and adapters as the sidebar.
 */
export const assistantTools: AssistantTool[] = [
  defineTool({
    name: 'get_project_layout',
    title: 'Project layout',
    description: 'Lists the items placed in a project: tag, kind, variant and ID.',
    shape: { projectId },
    readOnly: true,
    run: async (args, context) => {
      const project = openProject(context, args.projectId);
      return {
        result: {
          projectId: project.projectId,
          name: project.name,
          items: project.items.map(({ itemId, tag, kind, variantCode, revision }) => ({ itemId, tag, kind, variantCode, revision })),
        },
      };
    },
  }),

  defineTool({
    name: 'get_item_details',
    title: 'Item details',
    description:
      'Catalogue data, sizing result and, if the user may see them, price and lead time for one placed item. ' +
      'Each section has a status: ok, stale, pending, unavailable or not_permitted.',
    shape: { projectId, item: itemRef },
    readOnly: true,
    run: async (args, context) => {
      const project = openProject(context, args.projectId);
      const item = findItem(project, args.item);
      const { user, adapters, panels, config } = context;
      return { result: await buildSidebar({ user, project, item, adapters, panels, budgetMs: config.budgets.assistantMs }) };
    },
  }),

  defineTool({
    name: 'get_bom_cost',
    title: 'BOM cost',
    description:
      'The bill of materials for a project with quantities. Prices, totals and the longest lead time are included only ' +
      'when the user may see prices; otherwise pricing.status is not_permitted.',
    shape: { projectId },
    readOnly: true,
    run: async (args, context) => {
      const project = openProject(context, args.projectId);
      return { result: await buildBom(context.user, project, context.adapters, context.config.budgets.assistantMs) };
    },
  }),

  defineTool({
    name: 'search_catalogue',
    title: 'Search the catalogue',
    description:
      'Browses the product catalogue, smallest rating first, for questions like "which cabinets exist?". Only set the filters ' +
      'the user asked for. Not for re-sizing a placed drive: use resize_item for that. No prices; use get_bom_cost for those.',
    shape: {
      text: z.string().max(100).optional().describe('Words that must appear in the code or description, e.g. "R8" or "cabinet"'),
      kind: z.enum(['drive', 'cabinet', 'panel']).optional(),
      minKw: z.number().nonnegative().optional().describe('Minimum rated power in kW'),
      maxKw: z.number().nonnegative().optional().describe('Maximum rated power in kW; leave out (or 0) for no limit'),
      ipRating: z.string().max(10).optional().describe('For example IP54'),
      limit: z.number().int().min(1).max(50).optional(),
    },
    readOnly: true,
    run: async (args, context) => {
      requireKnownRole(context.user);
      // A maximum of 0 kW matches nothing, so it is read as "no limit".
      return { result: await context.adapters.catalogue.search({ ...args, maxKw: args.maxKw || undefined }) };
    },
  }),

  defineTool({
    name: 'resize_item',
    title: 'Propose a re-size',
    description:
      'Use when the motor load of a placed drive changes, or the user asks which drive a placed item needs for a new load. ' +
      'Runs the sizing tool, which picks the drive, and proposes the change. It never changes the project: the user must ' +
      'confirm the proposal in the workspace. Tell the user what will change and ask them to confirm there.',
    shape: {
      projectId,
      item: itemRef,
      motorKw: z.number().positive().max(2000).describe('New motor load in kW'),
      voltage: z.union([z.literal(230), z.literal(400), z.literal(480), z.literal(690)]).optional(),
    },
    readOnly: false,
    run: async (args, context) => {
      const project = openProject(context, args.projectId);
      const item = findItem(project, args.item);
      const { user, adapters, proposals, config } = context;
      const plan = await planResize({ user, project, item, motorKw: args.motorKw, voltage: args.voltage, adapters, budgetMs: config.budgets.resizeMs });

      if (!plan.changed) {
        return { result: { status: 'no_change', message: `${item.tag} stays ${item.variantCode}; frame ${plan.sizing.frame} at ${plan.sizing.loadPct}% load` } };
      }
      const proposal = proposals.create(user.id, plan);
      const delta = plan.bomChange.priceDelta;
      const price = delta?.status === 'ok' ? ` Price change: ${delta.amount} ${delta.currency}.` : '';
      return {
        outcome: 'proposed',
        result: {
          status: 'confirmation_required',
          proposalId: proposal.proposalId,
          expiresAt: new Date(proposal.expiresAt).toISOString(),
          summary: `Change ${item.tag} from ${plan.previousVariant} to ${plan.variantCode} (frame ${plan.sizing.frame}, ${plan.sizing.loadPct}% load).${price}`,
          change: { previousVariant: plan.previousVariant, variantCode: plan.variantCode, model: plan.model, bomChange: plan.bomChange },
          confirmedBy: 'the user, in the workspace',
        },
      };
    },
  }),
];

export interface ToolCallOutcome {
  isError: boolean;
  /** What the model sees: the JSON result, or `code: message` on failure. */
  text: string;
  result?: unknown;
}

/** Validates the arguments, runs the tool as the context's user, and records it in the audit log. */
export async function runTool(name: string, rawArgs: unknown, context: ToolContext): Promise<ToolCallOutcome> {
  const { audit, user } = context;
  const tool = assistantTools.find((candidate) => candidate.name === name);
  if (!tool) {
    audit.record(user, { action: name, input: rawArgs, outcome: 'error', detail: 'unknown_tool' });
    return { isError: true, text: `unknown_tool: ${name} is not an available tool` };
  }

  const parsed = z.object(tool.shape).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    audit.record(user, { action: name, input: rawArgs, outcome: 'error', detail: 'invalid_arguments' });
    return { isError: true, text: `invalid_arguments: ${issue?.path.join('.') || 'arguments'}: ${issue?.message ?? 'invalid'}` };
  }

  try {
    const { outcome = 'ok', result } = await tool.run(parsed.data as never, context);
    audit.record(user, { action: name, input: parsed.data, outcome });
    return { isError: false, text: JSON.stringify(result, null, 2), result };
  } catch (error) {
    const known = error instanceof HttpError;
    const denied = known && (error.statusCode === 403 || error.statusCode === 404);
    audit.record(user, { action: name, input: parsed.data, outcome: denied ? 'denied' : 'error', detail: known ? error.code : 'internal_error' });
    return { isError: true, text: known ? `${error.code}: ${error.message}` : 'internal_error: the tool failed unexpectedly' };
  }
}
