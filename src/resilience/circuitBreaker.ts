export type BreakerState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  constructor(readonly system: string) {
    super(`${system} circuit is open; not calling it until it recovers`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

/**
 * Opens after `failureThreshold` consecutive failures, fails fast while open, and lets one trial call
 * through after `cooldownMs`. Production keeps this state in Redis so every replica agrees.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(
    private readonly system: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get currentState(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.options.cooldownMs) return 'half_open';
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;
    if (state === 'open') throw new CircuitOpenError(this.system);
    const isTrial = state === 'half_open';
    if (isTrial) {
      if (this.trialInFlight) throw new CircuitOpenError(this.system);
      this.trialInFlight = true;
      this.state = 'half_open';
    }
    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      this.state = 'closed';
      return result;
    } catch (error) {
      this.consecutiveFailures++;
      if (this.state === 'half_open' || this.consecutiveFailures >= this.options.failureThreshold) {
        this.state = 'open';
        this.openedAt = this.now();
      }
      throw error;
    } finally {
      if (isTrial) this.trialInFlight = false;
    }
  }
}
