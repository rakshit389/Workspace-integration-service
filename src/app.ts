import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Adapters } from './adapters/index.js';
import { requireProjectAccess } from './auth/policy.js';
import { authenticate } from './auth/tokens.js';
import type { Config } from './config.js';
import type { User } from './domain/types.js';
import { HttpError } from './errors.js';
import { buildBom } from './orchestration/bom.js';
import { IdempotencyStore } from './orchestration/idempotency.js';
import { resizeItem, type ResizeBody } from './orchestration/resize.js';
import { buildPanel, buildSidebar } from './orchestration/sidebar.js';
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
  logger?: boolean;
}

type ItemParams = { projectId: string; itemId: string };

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
  const idempotency = new IdempotencyStore();
  const app = Fastify({
    logger: deps.logger ? { redact: ['req.headers.authorization'] } : false,
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.decorateRequest('user', null);

  // Layer 1 runs on every route except the health check.
  app.addHook('onRequest', async (request) => {
    if (request.url === '/health') return;
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

  app.get('/health', async () => ({ status: 'ok' }));

  app.get<{ Params: { projectId: string } }>('/projects/:projectId', async (request) => {
    const user = request.user!;
    requireProjectAccess(user);
    const project = repo.getProject(request.params.projectId);
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
    requireProjectAccess(user);
    const { project, item } = repo.getItem(request.params.projectId, request.params.itemId);
    return buildSidebar({ user, project, item, adapters, panels, budgetMs: config.budgets.sidebarMs });
  });

  app.get<{ Params: ItemParams & { panelId: string } }>('/projects/:projectId/items/:itemId/panels/:panelId', async (request) => {
    const user = request.user!;
    requireProjectAccess(user);
    const { project, item } = repo.getItem(request.params.projectId, request.params.itemId);
    return buildPanel({ user, project, item, adapters, panels, budgetMs: config.budgets.sidebarMs }, request.params.panelId);
  });

  app.post<{ Params: ItemParams; Body: ResizeBody }>(
    '/projects/:projectId/items/:itemId/resize',
    { schema: { body: resizeBodySchema } },
    async (request) => {
      const user = request.user!;
      requireProjectAccess(user);
      const { projectId, itemId } = request.params;
      const run = () => resizeItem({ user, projectId, itemId, body: request.body, adapters, repo, budgetMs: config.budgets.resizeMs });

      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length === 0) return run();
      return idempotency.run(`${user.id}:${key}`, JSON.stringify({ projectId, itemId, body: request.body }), run);
    },
  );

  app.get<{ Params: { projectId: string } }>('/projects/:projectId/bom', async (request) => {
    const user = request.user!;
    requireProjectAccess(user);
    return buildBom(user, repo.getProject(request.params.projectId), adapters, config.budgets.bomMs);
  });

  return app;
}
