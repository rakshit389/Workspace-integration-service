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
  budgets: { sidebarMs: number; bomMs: number; resizeMs: number; assistantMs: number; latePanelMs: number };
  assistant: { proposalTtlMs: number };
  events: { ticketTtlMs: number; heartbeatMs: number };
  llm: { baseUrl: string; model: string; apiKey?: string; timeoutMs: number; maxToolRounds: number };
  catalogue: SystemConfig;
  sizing: SystemConfig & { breaker: { failureThreshold: number; cooldownMs: number } };
  pricing: SystemConfig & { apiKey: string; ratePerSecond: number; maxQueueWaitMs: number };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export function defaultConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  // An empty value (e.g. `PORT=` copied from .env.example) means "not set", so the default applies.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(rawEnv).filter(([, value]) => value !== undefined && value.trim() !== ''));
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
      // The assistant is not on the 1 s click path, so it may wait longer for a complete answer.
      assistantMs: Number(env.ASSISTANT_BUDGET_MS ?? 3_000),
      // How long a panel that answered `pending` keeps waiting before its result is pushed over SSE.
      latePanelMs: Number(env.LATE_PANEL_MS ?? 10_000),
    },
    assistant: {
      // A re-size proposed by the assistant must be confirmed by the user within this time.
      proposalTtlMs: 10 * MINUTE,
    },
    events: {
      // Browsers cannot send headers with EventSource, so they exchange their token for a short-lived ticket.
      ticketTtlMs: 60 * SECOND,
      heartbeatMs: 15 * SECOND,
    },
    llm: {
      // Any OpenAI-compatible endpoint. The default is a local Ollama model, so no data leaves the machine;
      // production points this at the private Azure OpenAI endpoint inside the customer's tenant.
      baseUrl: env.LLM_BASE_URL ?? 'http://127.0.0.1:11434/v1',
      model: env.LLM_MODEL ?? 'qwen2.5:3b',
      apiKey: env.LLM_API_KEY,
      timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60_000),
      maxToolRounds: 5,
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
