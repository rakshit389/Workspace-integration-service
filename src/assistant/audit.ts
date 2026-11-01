import type { User } from '../domain/types.js';

export interface AuditEntry {
  at: string;
  userId: string;
  role: string;
  action: string;
  input?: unknown;
  outcome: 'ok' | 'denied' | 'error' | 'proposed' | 'confirmed' | 'cancelled';
  detail?: string;
}

/**
 * Who asked the assistant for what, and what our authorization decided. Only references are kept,
 * never price lists or document text. Production writes this to an append-only PostgreSQL table.
 */
export class AuditLog {
  readonly entries: AuditEntry[] = [];

  record(user: User, entry: Omit<AuditEntry, 'at' | 'userId' | 'role'>): void {
    this.entries.push({ at: new Date().toISOString(), userId: user.id, role: user.role, ...entry });
  }
}
