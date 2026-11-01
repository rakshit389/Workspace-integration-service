import { z } from 'zod';
import type { AuditLog } from '../assistant/audit.js';
import { toolDefinitions, type ToolArgs, type ToolName } from '../assistant/toolDefinitions.js';
import type { User } from '../domain/types.js';
import { ApiError, type WorkspaceApiClient } from './apiClient.js';

interface ProjectSummary {
  projectId: string;
  name: string;
  items: Array<{ itemId: string; tag: string; kind: string; variantCode: string; revision: number }>;
}

interface ToolResult {
  outcome?: 'ok' | 'proposed';
  result: unknown;
}

const path = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

async function findItem(api: WorkspaceApiClient, projectId: string, ref: string) {
  const project = await api.get<ProjectSummary>(path(projectId));
  const item = project.items.find((candidate) => candidate.itemId === ref || candidate.tag.toLowerCase() === ref.toLowerCase());
  if (!item) throw new ApiError(404, 'not_found', `Item ${ref} not found in project ${projectId}`);
  return item;
}

/**
 * Each tool is a thin call to the workspace API with the user's token. The MCP service holds no data and
 * no business rules, so permissions, rate limits and proposals all stay in the API.
 */
const runners: { [N in ToolName]: (args: ToolArgs<N>, api: WorkspaceApiClient) => Promise<ToolResult> } = {
  get_project_layout: async (args, api) => {
    const project = await api.get<ProjectSummary>(path(args.projectId));
    return {
      result: {
        projectId: project.projectId,
        name: project.name,
        items: project.items.map(({ itemId, tag, kind, variantCode, revision }) => ({ itemId, tag, kind, variantCode, revision })),
      },
    };
  },
  get_item_details: async (args, api) => {
    const item = await findItem(api, args.projectId, args.item);
    return { result: await api.get(`${path(args.projectId)}/items/${encodeURIComponent(item.itemId)}/sidebar`) };
  },
  get_bom_cost: async (args, api) => ({ result: await api.get(`${path(args.projectId)}/bom`) }),
  search_catalogue: async (args, api) => {
    const query = new URLSearchParams();
    if (args.text) query.set('q', args.text);
    if (args.kind) query.set('kind', args.kind);
    if (args.minKw !== undefined) query.set('minKw', String(args.minKw));
    // A maximum of 0 kW matches nothing, so it is read as "no limit".
    if (args.maxKw) query.set('maxKw', String(args.maxKw));
    if (args.ipRating) query.set('ipRating', args.ipRating);
    if (args.limit) query.set('limit', String(args.limit));
    return { result: await api.get(`/catalogue/search?${query}`) };
  },
  resize_item: async (args, api) => {
    const item = await findItem(api, args.projectId, args.item);
    const result = await api.post<{ status: string }>(`${path(args.projectId)}/items/${encodeURIComponent(item.itemId)}/resize-proposals`, {
      motorKw: args.motorKw,
      ...(args.voltage ? { voltage: args.voltage } : {}),
    });
    return { outcome: result.status === 'confirmation_required' ? 'proposed' : 'ok', result };
  },
};

/** Validates the arguments, calls the API as the user, and records the call in the MCP service's audit log. */
export async function runMcpTool(name: string, rawArgs: unknown, api: WorkspaceApiClient, user: User, audit: AuditLog) {
  const definition = toolDefinitions.find((candidate) => candidate.name === name);
  if (!definition) return { isError: true, text: `unknown_tool: ${name} is not an available tool` };

  const parsed = z.object(definition.shape).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { isError: true, text: `invalid_arguments: ${issue?.path.join('.') || 'arguments'}: ${issue?.message ?? 'invalid'}` };
  }

  try {
    const run = runners[name as ToolName] as (args: unknown, api: WorkspaceApiClient) => Promise<ToolResult>;
    const { outcome = 'ok', result } = await run(parsed.data, api);
    audit.record(user, { action: name, input: parsed.data, outcome });
    return { isError: false, text: JSON.stringify(result, null, 2) };
  } catch (error) {
    const known = error instanceof ApiError;
    const denied = known && (error.statusCode === 403 || error.statusCode === 404);
    audit.record(user, { action: name, input: parsed.data, outcome: denied ? 'denied' : 'error', detail: known ? error.code : 'internal_error' });
    return { isError: true, text: known ? `${error.code}: ${error.message}` : 'internal_error: the tool failed unexpectedly' };
  }
}
