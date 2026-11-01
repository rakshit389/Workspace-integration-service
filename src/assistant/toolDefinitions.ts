import { z } from 'zod';

/**
 * What the assistant's tools are called, what they do and what they take. Shared by the API (used by its
 * chat, in-process) and the MCP service (calls the API over REST), so every AI client sees the same tools.
 */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
}

const projectId = z.string().describe('Project ID, for example P-24117');
const itemRef = z.string().describe('Item tag such as DRV-03, or the item ID');

export const toolShapes = {
  get_project_layout: { projectId },
  get_item_details: { projectId, item: itemRef },
  get_bom_cost: { projectId },
  search_catalogue: {
    text: z.string().max(100).optional().describe('Words that must appear in the code or description, e.g. "R8" or "cabinet"'),
    kind: z.enum(['drive', 'cabinet', 'panel']).optional(),
    minKw: z.number().nonnegative().optional().describe('Minimum rated power in kW'),
    maxKw: z.number().nonnegative().optional().describe('Maximum rated power in kW; leave out (or 0) for no limit'),
    ipRating: z.string().max(10).optional().describe('For example IP54'),
    limit: z.number().int().min(1).max(50).optional(),
  },
  resize_item: {
    projectId,
    item: itemRef,
    motorKw: z.number().positive().max(2000).describe('New motor load in kW'),
    voltage: z.union([z.literal(230), z.literal(400), z.literal(480), z.literal(690)]).optional(),
  },
} satisfies Record<string, z.ZodRawShape>;

export type ToolName = keyof typeof toolShapes;
export type ToolArgs<N extends ToolName> = z.infer<z.ZodObject<(typeof toolShapes)[N]>>;

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'get_project_layout',
    title: 'Project layout',
    description: 'Lists the items placed in a project: tag, kind, variant and ID.',
    shape: toolShapes.get_project_layout,
    readOnly: true,
  },
  {
    name: 'get_item_details',
    title: 'Item details',
    description:
      'Catalogue data, sizing result and, if the user may see them, price and lead time for one placed item. ' +
      'Each section has a status: ok, stale, pending, unavailable or not_permitted.',
    shape: toolShapes.get_item_details,
    readOnly: true,
  },
  {
    name: 'get_bom_cost',
    title: 'BOM cost',
    description:
      'The bill of materials for a project with quantities. Prices, totals and the longest lead time are included only ' +
      'when the user may see prices; otherwise pricing.status is not_permitted.',
    shape: toolShapes.get_bom_cost,
    readOnly: true,
  },
  {
    name: 'search_catalogue',
    title: 'Search the catalogue',
    description:
      'Browses the product catalogue, smallest rating first, for questions like "which cabinets exist?". Only set the filters ' +
      'the user asked for. Not for re-sizing a placed drive: use resize_item for that. No prices; use get_bom_cost for those.',
    shape: toolShapes.search_catalogue,
    readOnly: true,
  },
  {
    name: 'resize_item',
    title: 'Propose a re-size',
    description:
      'Use when the motor load of a placed drive changes, or the user asks which drive a placed item needs for a new load. ' +
      'Runs the sizing tool, which picks the drive, and proposes the change. It never changes the project: the user must ' +
      'confirm the proposal in the workspace. Tell the user what will change and ask them to confirm there.',
    shape: toolShapes.resize_item,
    readOnly: false,
  },
];
