import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/assistant/audit.js';
import { mergeConfig } from '../src/config.js';
import { buildMcpApp } from '../src/mcp/app.js';
import { ITEMS, PROJECT, startTestEnv, type TestEnv, type TestOptions } from './helpers.js';

let env: TestEnv;
let mcpApp: FastifyInstance | undefined;
let clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients = [];
  await mcpApp?.close();
  mcpApp = undefined;
  await env?.close();
});

/** Starts the API and, as a separate server, the MCP service pointed at it. */
async function startServices(options: TestOptions = {}, apiUrlOverride?: string) {
  env = await startTestEnv(options);
  const apiUrl = await env.listen();
  const mcpAudit = new AuditLog();
  mcpApp = await buildMcpApp({ config: mergeConfig(env.config, { mcp: { apiUrl: apiUrlOverride ?? apiUrl } }), audit: mcpAudit });
  await mcpApp.listen({ host: '127.0.0.1', port: 0 });
  return { apiUrl, mcpUrl: `http://127.0.0.1:${(mcpApp.server.address() as AddressInfo).port}/mcp`, mcpAudit };
}

/** An MCP client that calls the MCP service as the given user, exactly as an external AI app would. */
async function connect(mcpUrl: string, role = 'sales_engineer', sub?: string) {
  const token = await env.token(role, 'DE', '1h', sub);
  const client = new Client({ name: 'test-assistant', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return { isError: result.isError === true, text, json: () => JSON.parse(text) };
}

describe('MCP service', () => {
  it('exposes the assistant tools', async () => {
    const { mcpUrl } = await startServices();
    const { tools } = await (await connect(mcpUrl)).listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['get_bom_cost', 'get_item_details', 'get_project_layout', 'resize_item', 'search_catalogue']);
  });

  it('get_bom_cost answers cost and longest lead time for a sales engineer', async () => {
    const { mcpUrl } = await startServices();
    const bom = (await callTool(await connect(mcpUrl), 'get_bom_cost', { projectId: PROJECT })).json();
    expect(bom.totals).toMatchObject({ amount: 18952, currency: 'EUR', longestLeadTime: { days: 42, itemTags: ['DRV-03'] } });
  });

  it('get_bom_cost gives a channel partner no prices or lead times, and the ERP is never called', async () => {
    const { mcpUrl } = await startServices();
    const result = await callTool(await connect(mcpUrl, 'channel_partner'), 'get_bom_cost', { projectId: PROJECT });

    expect(result.json().pricing).toEqual({ status: 'not_permitted' });
    expect(result.text).not.toMatch(/unitPrice|leadTimeDays|currency|totals/);
    expect(env.mocks.pricing.stats.calls).toBe(0);
  });

  it('get_item_details follows the same entitlements as the sidebar', async () => {
    const { mcpUrl } = await startServices();
    const details = (await callTool(await connect(mcpUrl, 'channel_partner'), 'get_item_details', { projectId: PROJECT, item: 'DRV-03' })).json();
    expect(details.panels.pricing).toEqual({ status: 'not_permitted' });
    expect(details.panels.catalogue.status).toBe('ok');
  });

  it('search_catalogue works for any role and returns no prices', async () => {
    const { mcpUrl } = await startServices();
    const result = await callTool(await connect(mcpUrl, 'channel_partner'), 'search_catalogue', { kind: 'drive', minKw: 90, ipRating: 'IP54' });
    expect(result.json().results.map((variant: { variantCode: string }) => variant.variantCode)).toEqual(['R8-IP54', 'R9-IP54']);
    expect(result.text).not.toMatch(/unitPrice|currency/);
  });

  it('cannot open a project the user is not a member of', async () => {
    const { mcpUrl, mcpAudit } = await startServices();
    const result = await callTool(await connect(mcpUrl), 'get_bom_cost', { projectId: 'P-30002' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not_found/);
    expect(mcpAudit.entries.at(-1)).toMatchObject({ action: 'get_bom_cost', outcome: 'denied' });
  });

  it('rejects calls without a valid token before reaching the API', async () => {
    const { mcpUrl } = await startServices();
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('reports a clear error when the API is down', async () => {
    const { mcpUrl } = await startServices({}, 'http://127.0.0.1:9');
    const result = await callTool(await connect(mcpUrl), 'get_bom_cost', { projectId: PROJECT });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('api_unavailable: The workspace API is not reachable');
  });
});

describe('resize_item needs the user to confirm', () => {
  const confirm = (apiUrl: string, token: string, proposalId: string) =>
    fetch(`${apiUrl}/projects/${PROJECT}/assistant/proposals/${proposalId}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

  it('only proposes; the item changes when the user confirms in the workspace, and only once', async () => {
    const { mcpUrl, apiUrl, mcpAudit } = await startServices();
    const proposal = (await callTool(await connect(mcpUrl), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 110 })).json();
    expect(proposal).toMatchObject({ status: 'confirmation_required', change: { previousVariant: 'R7-IP54', variantCode: 'R8-IP54' } });
    expect(proposal.summary).toMatch(/Change DRV-03 from R7-IP54 to R8-IP54/);
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item).toMatchObject({ variantCode: 'R7-IP54', revision: 1 });

    const token = await env.token('sales_engineer');
    const confirmed = await confirm(apiUrl, token, proposal.proposalId);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ variantCode: 'R8-IP54', modelRef: 'R8-v2', revision: 2 });
    expect((await confirm(apiUrl, token, proposal.proposalId)).status).toBe(404);

    expect(mcpAudit.entries.map((entry) => entry.outcome)).toEqual(['proposed']);
    expect(env.audit.entries.map((entry) => entry.outcome)).toEqual(['proposed', 'confirmed']);
  });

  it('does not let another user confirm the proposal', async () => {
    const { mcpUrl, apiUrl } = await startServices();
    const proposal = (await callTool(await connect(mcpUrl), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 110 })).json();
    expect((await confirm(apiUrl, await env.token('admin'), proposal.proposalId)).status).toBe(404);
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item.variantCode).toBe('R7-IP54');
  });

  it('refuses a proposal that has expired', async () => {
    const { mcpUrl, apiUrl } = await startServices({ config: { assistant: { proposalTtlMs: 30 } } });
    const proposal = (await callTool(await connect(mcpUrl), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 110 })).json();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await confirm(apiUrl, await env.token('sales_engineer'), proposal.proposalId)).status).toBe(410);
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item.revision).toBe(1);
  });

  it('refuses to confirm when the item changed after the proposal was made', async () => {
    const { mcpUrl, apiUrl } = await startServices();
    const proposal = (await callTool(await connect(mcpUrl), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 110 })).json();
    await env.request('POST', `/projects/${PROJECT}/items/${ITEMS['DRV-03']}/resize`, { body: { motorKw: 150 } });
    expect((await confirm(apiUrl, await env.token('sales_engineer'), proposal.proposalId)).status).toBe(409);
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item.variantCode).toBe('R9-IP54');
  });

  it('does not let a channel partner propose a re-size', async () => {
    const { mcpUrl } = await startServices();
    const result = await callTool(await connect(mcpUrl, 'channel_partner'), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 110 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/forbidden/);
    expect(env.mocks.sizing.stats.calls).toBe(0);
  });

  it('reports no change when the current drive is still large enough', async () => {
    const { mcpUrl } = await startServices();
    const result = (await callTool(await connect(mcpUrl), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 70 })).json();
    expect(result.status).toBe('no_change');
  });
});
