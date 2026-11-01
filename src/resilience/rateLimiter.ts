import { sleep } from './retry.js';

export class RateLimitWaitError extends Error {
  constructor(readonly system: string, waitMs: number) {
    super(`${system} rate limit: next slot in ${waitMs} ms exceeds the allowed wait`);
    this.name = 'RateLimitWaitError';
  }
}

/**
 * Sliding-window limiter: at most `perSecond` calls start in any one-second window. Callers wait for
 * the next free slot instead of being rejected. Production shares this budget across replicas in Redis.
 */
export class RateLimiter {
  private readonly grants: number[] = [];
  // A small margin so network jitter cannot push two windows' worth of calls into the system's window.
  private readonly windowMs = 1_050;

  constructor(
    private readonly system: string,
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(maxWaitMs: number): Promise<void> {
    const now = this.now();
    while (this.grants.length > 0 && this.grants[0]! <= now - this.windowMs) this.grants.shift();

    const slot = this.grants.length < this.perSecond ? now : this.grants[this.grants.length - this.perSecond]! + this.windowMs;
    const waitMs = Math.max(0, slot - now);
    if (waitMs > maxWaitMs) throw new RateLimitWaitError(this.system, waitMs);

    this.grants.push(slot);
    if (waitMs > 0) await sleep(waitMs);
  }
}
