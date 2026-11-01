import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.js';
import type { ResizePlan } from './resize.js';

export interface Proposal {
  proposalId: string;
  userId: string;
  plan: ResizePlan;
  expiresAt: number;
}

/**
 * Write actions requested by the assistant wait here until the user confirms them in the workspace.
 * A proposal belongs to one user, is used at most once, and expires. Production keeps this in Redis.
 */
export class ProposalStore {
  private readonly proposals = new Map<string, Proposal>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(userId: string, plan: ResizePlan): Proposal {
    const proposal: Proposal = { proposalId: randomUUID(), userId, plan, expiresAt: this.now() + this.ttlMs };
    this.proposals.set(proposal.proposalId, proposal);
    return proposal;
  }

  /** Removes and returns the proposal. Another user's proposal looks exactly like a missing one. */
  take(proposalId: string, userId: string, projectId: string): Proposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.userId !== userId || proposal.plan.projectId !== projectId) {
      throw new HttpError(404, 'not_found', 'Proposal not found');
    }
    this.proposals.delete(proposalId);
    if (this.now() >= proposal.expiresAt) throw new HttpError(410, 'proposal_expired', 'This proposal has expired; ask the assistant again');
    return proposal;
  }
}
