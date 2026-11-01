import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Adapters } from './adapters/index.js';
import { AuditLog } from './assistant/audit.js';
import { chatBodySchema, localToolRunner, runChat, type ChatTurn } from './assistant/chat.js';
import { OpenAICompatibleChatModel, type ChatModel } from './assistant/llm.js';
import { buildMcpServer } from './assistant/mcpServer.js';
import { requireKnownRole, requireProjectAccess, requireResize } from './auth/policy.js';
import type { CatalogueSearch } from './adapters/catalogue.js';
import { authenticate } from './auth/tokens.js';
import type { Config } from './config.js';
import type { Item, User } from './domain/types.js';
import { HttpError } from './errors.js';
import { EventHub, StreamTicketStore } from './events/eventHub.js';
import { buildBom } from './orchestration/bom.js';
import { IdempotencyStore } from './orchestration/idempotency.js';
import { ProposalStore } from './orchestration/proposals.js';
import { applyResize, resizeItem, resizeResponse, type ResizeBody } from './orchestration/resize.js';
import { buildPanel, buildSidebar, deliverLatePanels, type SidebarRequest } from './orchestration/sidebar.js';
import type { PanelDefinition } from './panels/types.js';
import type { InMemoryProjectRepository } from './store/projectRepository.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface AppDependencies {
  config: Config;
  repo: InMemoryProjectRepository;
  adapters: Adapters;
  panels: PanelDefinition[];
  events?: EventHub;
  proposals?: ProposalStore;
  audit?: AuditLog;
  chatModel?: ChatModel;
  logger?: boolean;
}

type ItemParams = { projectId: string; itemId: string };

const EVENTS_ROUTE = '/projects/:projectId/events';

const resizeBodySchema = {
  type: 'object',
  required: ['motorKw'],
  additionalProperties: false,
  properties: {
    motorKw: { type: 'number', exclusiveMinimum: 0, maximum: 2000 },
    voltage: { type: 'integer', enum: [230, 400, 480, 690] },
    baseRevision: { type: 'integer', minimum: 1 },
  },
} as const;

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { config, repo, adapters, panels } = deps;
  const events = deps.events ?? new EventHub();
  const proposals = deps.proposals ?? new ProposalStore(config.assistant.proposalTtlMs);
  const audit = deps.audit ?? new AuditLog();
  const chatModel = deps.chatModel ?? new OpenAICompatibleChatModel(config.llm);
  const tickets = new StreamTicketStore(config.events.ticketTtlMs);
  const idempotency = new IdempotencyStore();

  const app = Fastify({
    logger: deps.logger ? { redact: ['req.headers.authorization'] } : false,
    ajv: { customOptions: { removeAdditional: false } },
    // Open SSE streams must not keep the server from shutting down.
    forceCloseConnections: true,
  });

  app.decorateRequest('user', null);

  // Layer 1 runs on every route except the health check. The event stream also accepts a one-time ticket.
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.url === '/health') return;
    const { ticket } = request.query as { ticket?: string };
    if (request.routeOptions.url === EVENTS_ROUTE && typeof ticket === 'string') {
      const user = tickets.redeem(ticket, (request.params as { projectId: string }).projectId);
      if (!user) throw new HttpError(401, 'invalid_ticket', 'Stream ticket is invalid, expired or already used');
      request.user = user;
      return;
    }
    request.user = await authenticate(config.auth, request.headers.authorization);
  });

  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError) {
      if (error.statusCode === 401) reply.header('www-authenticate', 'Bearer');
      return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...error.details });
    }
    if ('validation' in error && error.validation) {
      return reply.code(400).send({ error: 'invalid_request', message: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'internal_error', message: 'Unexpected error' });
  });

  /** Panels that answered `pending` are pushed to this user's stream when their result lands. */
  const pushLatePanels = (request: SidebarRequest, panelResponses: Parameters<typeof deliverLatePanels>[1]) =>
    deliverLatePanels(request, panelResponses, config.budgets.latePanelMs, (panelId, response) =>
      events.publishToUser(request.project.projectId, request.user.id, 'panel.updated', {
        itemId: request.item.itemId,
        itemRevision: request.item.revision,
        panel: panelId,
        ...response,
      }),
    );

  /** Tells everyone viewing the project that an item changed. Carries no prices, so it is safe for every role. */
  const announceItem = (projectId: string, item: Item) =>
    events.publishToProject(projectId, 'item.updated', {
      itemId: item.itemId,
      tag: item.tag,
      revision: item.revision,
      variantCode: item.variantCode,
      modelRef: item.modelRef,
    });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get<{ Params: { projectId: string } }>('/projects/:projectId', async (request) => {
    const user = request.user!;
    const project = repo.getProject(request.params.projectId);
    requireProjectAccess(user, project);
    return {
      projectId: project.projectId,
      name: project.name,
      items: project.items.map(({ itemId, tag, kind, variantCode, modelRef, revision, placement }) => ({
        itemId, tag, kind, variantCode, modelRef, revision, placement,
      })),
    };
  });

  app.get<{ Params: ItemParams }>('/projects/:projectId/items/:itemId/sidebar', async (request) => {
    const user = request.user!;
    requireProjectAccess(user, repo.getProject(request.params.projectId));
    const { project, item } = repo.getItem(request.params.projectId, request.params.itemId);
    const sidebarRequest = { user, project, item, adapters, panels, budgetMs: config.budgets.sidebarMs };
    const sidebar = await buildSidebar(sidebarRequest);
    pushLatePanels(sidebarRequest, sidebar.panels);
    return sidebar;
  });

  app.get<{ Params: ItemParams & { panelId: string } }>('/projects/:projectId/items/:itemId/panels/:panelId', async (request) => {
    const user = request.user!;
    requireProjectAccess(user, repo.getProject(request.params.projectId));
    const { project, item } = repo.getItem(request.params.projectId, request.params.itemId);
    const sidebarRequest = { user, project, item, adapters, panels, budgetMs: config.budgets.sidebarMs };
    const result = await buildPanel(sidebarRequest, request.params.panelId);
    pushLatePanels(sidebarRequest, { [result.panel]: result });
    return result;
  });

  app.post<{ Params: ItemParams; Body: ResizeBody }>(
    '/projects/:projectId/items/:itemId/resize',
    { schema: { body: resizeBodySchema } },
    async (request) => {
      const user = request.user!;
      const { projectId, itemId } = request.params;
      requireProjectAccess(user, repo.getProject(projectId));
      const run = async () => {
        const result = await resizeItem({ user, projectId, itemId, body: request.body, adapters, repo, budgetMs: config.budgets.resizeMs });
        announceItem(projectId, repo.getItem(projectId, itemId).item);
        return result;
      };

      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length === 0) return run();
      return idempotency.run(`${user.id}:${key}`, JSON.stringify({ projectId, itemId, body: request.body }), run);
    },
  );

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/bom', async (request) => {
    const user = request.user!;
    const project = repo.getProject(request.params.projectId);
    requireProjectAccess(user, project);
    return buildBom(user, project, adapters, config.budgets.bomMs);
  });

  app.get<{ Querystring: CatalogueSearch & { q?: string } }>(
    '/catalogue/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 100 },
            kind: { type: 'string', enum: ['drive', 'cabinet', 'panel'] },
            minKw: { type: 'number', minimum: 0 },
            maxKw: { type: 'number', exclusiveMinimum: 0 },
            ipRating: { type: 'string', maxLength: 10 },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (request) => {
      requireKnownRole(request.user!);
      const { q, ...filters } = request.query;
      return adapters.catalogue.search({ ...filters, text: q });
    },
  );

  // ---- Server push (SSE) ----

  app.post<{ Params: { projectId: string } }>('/projects/:projectId/events/ticket', async (request) => {
    const user = request.user!;
    requireProjectAccess(user, repo.getProject(request.params.projectId));
    const ticket = tickets.issue(user, request.params.projectId);
    return { ticket, expiresInMs: config.events.ticketTtlMs, url: `/projects/${request.params.projectId}/events?ticket=${ticket}` };
  });

  app.get<{ Params: { projectId: string } }>(EVENTS_ROUTE, async (request, reply) => {
    const user = request.user!;
    const { projectId } = request.params;
    requireProjectAccess(user, repo.getProject(projectId));

    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    stream.write(`retry: 3000\n\nevent: ready\ndata: ${JSON.stringify({ projectId })}\n\n`);

    const unsubscribe = events.subscribe(projectId, user.id, (event) =>
      stream.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`),
    );
    const heartbeat = setInterval(() => stream.write(': keep-alive\n\n'), config.events.heartbeatMs);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---- AI assistant: MCP tools and user confirmation ----

  app.post('/mcp', async (request, reply) => {
    const server = buildMcpServer(request.user!, { config, repo, adapters, panels, proposals, audit });
    // Stateless: one server and transport per request, bound to the caller's identity.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  const methodNotAllowed = async () => {
    throw new HttpError(405, 'method_not_allowed', 'This MCP endpoint is stateless; use POST');
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // Chat: the language model answers by calling the same tools, each run as this user.
  app.post<{ Params: { projectId: string }; Body: { message: string; history?: ChatTurn[] } }>(
    '/projects/:projectId/assistant/messages',
    { schema: { body: chatBodySchema } },
    async (request) => {
      const user = request.user!;
      const project = repo.getProject(request.params.projectId);
      requireProjectAccess(user, project);

      const result = await runChat({
        projectId: project.projectId,
        projectName: project.name,
        message: request.body.message,
        history: request.body.history ?? [],
        model: chatModel,
        tools: localToolRunner({ config, repo, adapters, panels, proposals, audit, user }),
        maxToolRounds: config.llm.maxToolRounds,
      });
      audit.record(user, {
        action: 'assistant_message',
        input: { projectId: project.projectId, message: request.body.message, tools: result.toolCalls.map((call) => call.name) },
        outcome: 'ok',
      });
      return result;
    },
  );

  // The confirm call comes from the user's browser with the user's own token, never from the model.
  app.post<{ Params: { projectId: string; proposalId: string } }>(
    '/projects/:projectId/assistant/proposals/:proposalId/confirm',
    async (request) => {
      const user = request.user!;
      const { projectId, proposalId } = request.params;
      requireProjectAccess(user, repo.getProject(projectId));
      const proposal = proposals.take(proposalId, user.id, projectId);
      requireResize(user);

      const updated = applyResize(repo, proposal.plan);
      audit.record(user, { action: 'resize_item', input: { proposalId }, outcome: 'confirmed' });
      announceItem(projectId, updated);
      return resizeResponse(proposal.plan, updated);
    },
  );

  app.post<{ Params: { projectId: string; proposalId: string } }>(
    '/projects/:projectId/assistant/proposals/:proposalId/cancel',
    async (request) => {
      const user = request.user!;
      const { projectId, proposalId } = request.params;
      requireProjectAccess(user, repo.getProject(projectId));
      proposals.take(proposalId, user.id, projectId);
      audit.record(user, { action: 'resize_item', input: { proposalId }, outcome: 'cancelled' });
      return { status: 'cancelled' };
    },
  );

  return app;
}
