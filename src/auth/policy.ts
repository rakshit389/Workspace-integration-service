import type { Project, User } from '../domain/types.js';
import { HttpError } from '../errors.js';

/**
 * Layer 2: one place for every permission decision. Unknown roles get nothing (deny by default).
 * Sidebar panels, the BOM, re-size and any future AI tool all ask these functions.
 */
const KNOWN_ROLES = new Set(['sales_engineer', 'channel_partner', 'admin']);
const PRICE_ROLES = new Set(['sales_engineer', 'admin']);
const EDIT_ROLES = new Set(['sales_engineer', 'admin']);

export const policy = {
  hasKnownRole: (user: User) => KNOWN_ROLES.has(user.role),
  /** Members only, so a valid token cannot open someone else's project by guessing its ID. */
  canViewProject: (user: User, project: Project) =>
    KNOWN_ROLES.has(user.role) && (user.role === 'admin' || project.memberIds.includes(user.id)),
  /** Prices and lead times come from the ERP and are hidden together. */
  canViewPrices: (user: User) => PRICE_ROLES.has(user.role),
  canResize: (user: User) => EDIT_ROLES.has(user.role),
};

/** Unknown role → 403. Not a member → 404, so the response does not reveal that the project exists. */
export function requireProjectAccess(user: User, project: Project): void {
  if (!policy.hasKnownRole(user)) throw new HttpError(403, 'forbidden', 'Your role does not have access to projects');
  if (!policy.canViewProject(user, project)) throw new HttpError(404, 'not_found', `Project ${project.projectId} not found`);
}

/** Catalogue data is open to every known role; unknown roles still get nothing. */
export function requireKnownRole(user: User): void {
  if (!policy.hasKnownRole(user)) throw new HttpError(403, 'forbidden', 'Your role does not have access to the workspace');
}

export function requireResize(user: User): void {
  if (!policy.canResize(user)) throw new HttpError(403, 'forbidden', 'Your role cannot change items');
}
