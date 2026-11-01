import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createAdapters } from '../src/adapters/index.js';
import { AuditLog } from '../src/assistant/audit.js';
import type { ChatMessage, ChatModel, ToolSpec } from '../src/assistant/llm.js';
import { EventHub } from '../src/events/eventHub.js';
import { ProposalStore } from '../src/orchestration/proposals.js';
import { buildApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { defaultConfig, mergeConfig, type Config, type DeepPartial } from '../src/config.js';
import { loadCatalogueData } from '../src/mocks/catalogueData.js';
import { createCatalogueMock, type CatalogueMockOptions } from '../src/mocks/catalogueMock.js';
import { createPricingMock, type PricingMockOptions } from '../src/mocks/pricingMock.js';
import { createSizingMock, type SizingMockOptions } from '../src/mocks/sizingMock.js';
import { loadPanels } from '../src/panels/registry.js';
import { InMemoryProjectRepository } from '../src/store/projectRepository.js';

const dataDir = fileURLToPath(new URL('../data', import.meta.url));

export const PROJECT = 'P-24117';
export const ITEMS = {
  'DRV-03': '3f6c1d2e-0a41-4b8e-9d1e-2b7c1f0a9e03',
  'DRV-04': '8a2d4f61-5c0b-4e3a-b7f2-6d9e1c4a8b04',
  'CAB-01': 'c41e9b7a-2f3d-4d8c-a0e5-7b1f6c2d9a01',
} as const;

export interface TestOptions {
  config?: DeepPartial<Config>;
  chatModel?: ChatModel;
  sizing?: Partial<SizingMockOptions>;
  pricing?: Partial<PricingMockOptions>;
  catalogue?: Partial<CatalogueMockOptions>;
}

const address = (app: FastifyInstance) => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

/** Starts the three mocks on random ports (fast and healthy by default) and builds the API against them. */
export async function startTestEnv(options: TestOptions = {}) {
  const data = loadCatalogueData(dataDir);
  const catalogue = createCatalogueMock(data, options.catalogue);
  const sizing = createSizingMock(data, { minLatencyMs: 5, maxLatencyMs: 5, failRate: 0, ...options.sizing });
  const pricing = createPricingMock(data, options.pricing);
  await Promise.all([catalogue, sizing, pricing].map((mock) => mock.app.listen({ host: '127.0.0.1', port: 0 })));

  const testDefaults: DeepPartial<Config> = {
    catalogue: { baseUrl: address(catalogue.app) },
    sizing: { baseUrl: address(sizing.app), retry: { baseDelayMs: 10, maxDelayMs: 20 } },
    pricing: { baseUrl: address(pricing.app), retry: { baseDelayMs: 10, maxDelayMs: 20 } },
  };
  const config = mergeConfig(mergeConfig(defaultConfig({}), testDefaults), options.config);

  const repo = InMemoryProjectRepository.fromFile(resolve(dataDir, 'projects.json'));
  const adapters = createAdapters(config);
  const events = new EventHub();
  const proposals = new ProposalStore(config.assistant.proposalTtlMs);
  const audit = new AuditLog();
  const app = await buildApp({ config, repo, adapters, panels: await loadPanels(), events, proposals, audit, chatModel: options.chatModel });

  /** Real HTTP listener, for the MCP client and SSE streams. Returns the base URL. */
  const listen = async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    return address(app);
  };

  // Same subject as `npm run token`, so test users are members of the seed project P-24117.
  const token = (role = 'sales_engineer', country = 'DE', expiresIn: string | number = '1h', sub = `user-${role}`) =>
    signToken(config.auth, { sub, role, country }, expiresIn);

  const request = async (
    method: 'GET' | 'POST',
    url: string,
    opts: { role?: string; country?: string; sub?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${await token(opts.role, opts.country, '1h', opts.sub)}`, ...opts.headers },
      ...(opts.body === undefined ? {} : { payload: opts.body as object }),
    });

  const close = async () => {
    await app.close();
    await Promise.all([catalogue, sizing, pricing].map((mock) => mock.app.close()));
  };

  return { app, config, repo, adapters, events, proposals, audit, mocks: { catalogue, sizing, pricing }, token, request, listen, close };
}

/**
 * A scripted language model. `script` decides each reply from the conversation so far, and every call is
 * recorded, so tests can check exactly what the model was given (for example, that no prices reached it).
 */
export class FakeChatModel implements ChatModel {
  readonly calls: Array<{ messages: ChatMessage[]; tools: ToolSpec[] }> = [];

  constructor(private readonly script: (messages: ChatMessage[], round: number) => ChatMessage) {}

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
    this.calls.push({ messages: structuredClone(messages), tools });
    return this.script(messages, this.calls.length - 1);
  }

  /** Everything the model was shown as tool results, across all rounds. */
  toolResultsSeen(): string {
    return this.calls.flatMap((call) => call.messages.filter((message) => message.role === 'tool').map((message) => message.content ?? '')).join('\n');
  }
}

export const callTool = (name: string, args: Record<string, unknown> = {}): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

export const say = (content: string): ChatMessage => ({ role: 'assistant', content });

export interface ReceivedEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Opens an SSE stream with fetch and collects its events, so tests can wait for one. */
export async function openStream(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const received: ReceivedEvent[] = [];

  if (response.ok && response.body) {
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event && data) received.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          }
        }
      } catch {
        // aborted by close()
      }
    })();
  }

  const waitFor = async (match: (event: ReceivedEvent) => boolean, timeoutMs = 3_000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = received.find(match);
      if (found) return found;
      await wait(20);
    }
    throw new Error(`No matching event within ${timeoutMs} ms; received: ${received.map((event) => event.event).join(', ')}`);
  };

  return { status: response.status, received, waitFor, close: () => controller.abort() };
}

export type TestEnv = Awaited<ReturnType<typeof startTestEnv>>;

export const sidebarUrl = (itemId: string) => `/projects/${PROJECT}/items/${itemId}/sidebar`;
export const resizeUrl = (itemId: string) => `/projects/${PROJECT}/items/${itemId}/resize`;
export const bomUrl = `/projects/${PROJECT}/bom`;
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
