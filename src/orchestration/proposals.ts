import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.js';
import { planResize, type PlanRequest, type ResizePlan } from './resize.js';

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

/**
 * Works out a re-size without applying it and, if the drive would change, stores it as a proposal for the
 * user to confirm. Used by the REST endpoint (and so the MCP service) and by the API's own chat.
 */
export async function proposeResize(request: PlanRequest & { proposals: ProposalStore }) {
  const plan = await planResize(request);
  const { item } = request;
  if (!plan.changed) {
    return { status: 'no_change' as const, message: `${item.tag} stays ${item.variantCode}; frame ${plan.sizing.frame} at ${plan.sizing.loadPct}% load` };
  }
  const proposal = request.proposals.create(request.user.id, plan);
  const delta = plan.bomChange.priceDelta;
  const price = delta?.status === 'ok' ? ` Price change: ${delta.amount} ${delta.currency}.` : '';
  return {
    status: 'confirmation_required' as const,
    proposalId: proposal.proposalId,
    expiresAt: new Date(proposal.expiresAt).toISOString(),
    summary: `Change ${item.tag} from ${plan.previousVariant} to ${plan.variantCode} (frame ${plan.sizing.frame}, ${plan.sizing.loadPct}% load).${price}`,
    change: { previousVariant: plan.previousVariant, variantCode: plan.variantCode, model: plan.model, bomChange: plan.bomChange },
    confirmedBy: 'the user, in the workspace',
  };
}
