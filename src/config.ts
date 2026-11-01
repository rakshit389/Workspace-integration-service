export interface RetryConfig {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface SystemConfig {
  baseUrl: string;
  /** Per-request timeout towards the system. */
  timeoutMs: number;
  /** How long a value counts as fresh. */
  ttlMs: number;
  /** How long an expired value may still be served as `stale` when the system fails. */
  staleMaxMs: number;
  retry: RetryConfig;
}

export interface Config {
  port: number;
  auth: { secret: string; issuer: string; audience: string };
  budgets: { sidebarMs: number; bomMs: number; resizeMs: number };
  catalogue: SystemConfig;
  sizing: SystemConfig & { breaker: { failureThreshold: number; cooldownMs: number } };
  pricing: SystemConfig & { apiKey: string; ratePerSecond: number; maxQueueWaitMs: number };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    auth: {
      secret: env.JWT_SECRET ?? 'local-dev-secret-change-me-0123456789abcdef',
      issuer: env.JWT_ISSUER ?? 'https://idp.mock.local',
      audience: env.JWT_AUDIENCE ?? 'workspace-api',
    },
    budgets: {
      // The brief asks for useful sidebar content within 1 s; 600 ms leaves room for network and rendering.
      sidebarMs: Number(env.SIDEBAR_BUDGET_MS ?? 600),
      bomMs: Number(env.BOM_BUDGET_MS ?? 2_500),
      resizeMs: Number(env.RESIZE_BUDGET_MS ?? 8_000),
    },
    catalogue: {
      baseUrl: env.CATALOGUE_URL ?? 'http://127.0.0.1:4001',
      timeoutMs: 2 * SECOND,
      ttlMs: 10 * MINUTE,
      staleMaxMs: 24 * HOUR,
      retry: { retries: 2, baseDelayMs: 100, maxDelayMs: 1 * SECOND },
    },
    sizing: {
      baseUrl: env.SIZING_URL ?? 'http://127.0.0.1:4002',
      timeoutMs: 5 * SECOND,
      // Results depend only on the inputs and country, so they stay valid until the inputs change.
      ttlMs: 24 * HOUR,
      staleMaxMs: 72 * HOUR,
      retry: { retries: 2, baseDelayMs: 200, maxDelayMs: 2 * SECOND },
      breaker: { failureThreshold: 5, cooldownMs: 30 * SECOND },
    },
    pricing: {
      baseUrl: env.PRICING_URL ?? 'http://127.0.0.1:4003',
      apiKey: env.PRICING_API_KEY ?? 'local-pricing-service-account',
      timeoutMs: 2 * SECOND,
      // A quote is valid for 24 h; the adapter also caps this at the quote's own validUntil.
      ttlMs: 24 * HOUR,
      staleMaxMs: 72 * HOUR,
      retry: { retries: 2, baseDelayMs: 250, maxDelayMs: 2 * SECOND },
      ratePerSecond: 5,
      maxQueueWaitMs: 10 * SECOND,
    },
  };
}

export function mergeConfig<T>(base: T, overrides: DeepPartial<T> | undefined): T {
  if (!overrides) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    const current = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
        ? mergeConfig(current, value as DeepPartial<typeof current>)
        : value;
  }
  return out as T;
}
