import type { User } from '../domain/types.js';
import { HttpError } from '../errors.js';

/**
 * Layer 2: one place for every permission decision. Unknown roles get nothing (deny by default).
 * Sidebar panels, the BOM, re-size and any future AI tool all ask these functions.
 */
const KNOWN_ROLES = new Set(['sales_engineer', 'channel_partner', 'admin']);
const PRICE_ROLES = new Set(['sales_engineer', 'admin']);
const EDIT_ROLES = new Set(['sales_engineer', 'admin']);

export const policy = {
  canViewProject: (user: User) => KNOWN_ROLES.has(user.role),
  /** Prices and lead times come from the ERP and are hidden together. */
  canViewPrices: (user: User) => PRICE_ROLES.has(user.role),
  canResize: (user: User) => EDIT_ROLES.has(user.role),
};

export function requireProjectAccess(user: User): void {
  if (!policy.canViewProject(user)) throw new HttpError(403, 'forbidden', 'Your role does not have access to projects');
}

export function requireResize(user: User): void {
  if (!policy.canResize(user)) throw new HttpError(403, 'forbidden', 'Your role cannot change items');
}
