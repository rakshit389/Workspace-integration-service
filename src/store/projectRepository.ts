import { readFileSync } from 'node:fs';
import type { Item, Project } from '../domain/types.js';
import { HttpError } from '../errors.js';

export type ItemChanges = Partial<Pick<Item, 'variantCode' | 'modelRef' | 'sizingInputs'>>;

/**
 * Working copy of projects. Production keeps this in PostgreSQL and saves layouts to the host app with
 * If-Match; here it is in memory. Updates are synchronous, so the revision check and the write are atomic.
 */
export class InMemoryProjectRepository {
  private readonly projects = new Map<string, Project>();

  constructor(projects: Project[]) {
    for (const project of projects) this.projects.set(project.projectId, structuredClone(project));
  }

  static fromFile(path: string): InMemoryProjectRepository {
    return new InMemoryProjectRepository(JSON.parse(readFileSync(path, 'utf8')) as Project[]);
  }

  getProject(projectId: string): Project {
    const project = this.projects.get(projectId);
    if (!project) throw new HttpError(404, 'not_found', `Project ${projectId} not found`);
    return structuredClone(project);
  }

  getItem(projectId: string, itemId: string): { project: Project; item: Item } {
    const project = this.getProject(projectId);
    const item = project.items.find((candidate) => candidate.itemId === itemId);
    if (!item) throw new HttpError(404, 'not_found', `Item ${itemId} not found in project ${projectId}`);
    return { project, item };
  }

  /** Applies changes only if the item is still at `expectedRevision`, then bumps the revision. */
  updateItem(projectId: string, itemId: string, expectedRevision: number, changes: ItemChanges): Item {
    const project = this.projects.get(projectId);
    const item = project?.items.find((candidate) => candidate.itemId === itemId);
    if (!project || !item) throw new HttpError(404, 'not_found', `Item ${itemId} not found in project ${projectId}`);
    if (item.revision !== expectedRevision) {
      throw new HttpError(409, 'revision_conflict', 'The item changed while this request was running', {
        expectedRevision,
        currentRevision: item.revision,
      });
    }
    Object.assign(item, structuredClone(changes), { revision: item.revision + 1 });
    return structuredClone(item);
  }
}
