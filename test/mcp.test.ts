import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ITEMS, PROJECT, startTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients = [];
  await env?.close();
});

/** An MCP client that calls our server as the given user, exactly as the assistant would. */
async function connect(base: string, role = 'sales_engineer', sub?: string) {
  const token = await env.token(role, 'DE', '1h', sub);
  const client = new Client({ name: 'test-assistant', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  return { isError: result.isError === true, text, json: () => JSON.parse(text) };
}

describe('MCP assistant tools', () => {
  it('exposes the assistant tools', async () => {
    env = await startTestEnv();
    const client = await connect(await env.listen());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['get_bom_cost', 'get_item_details', 'get_project_layout', 'resize_item', 'search_catalogue']);
  });

  it('search_catalogue finds drives from the read model, for any role, without prices', async () => {
    env = await startTestEnv();
    const client = await connect(await env.listen(), 'channel_partner');
    const result = await callTool(client, 'search_catalogue', { kind: 'drive', minKw: 90, ipRating: 'IP54' });

    expect(result.json().results.map((variant: { variantCode: string }) => variant.variantCode)).toEqual(['R8-IP54', 'R9-IP54']);
    expect(result.text).not.toMatch(/unitPrice|currency/);
  });

  it('get_bom_cost answers cost and longest lead time for a sales engineer', async () => {
    env = await startTestEnv();
    const client = await connect(await env.listen());
    const bom = (await callTool(client, 'get_bom_cost', { projectId: PROJECT })).json();
    expect(bom.totals).toMatchObject({ amount: 18952, currency: 'EUR', longestLeadTime: { days: 42, itemTags: ['DRV-03'] } });
  });

  it('get_bom_cost gives a channel partner no prices or lead times, and never calls the ERP', async () => {
    env = await startTestEnv();
    const client = await connect(await env.listen(), 'channel_partner');
    const result = await callTool(client, 'get_bom_cost', { projectId: PROJECT });

    expect(result.json().pricing).toEqual({ status: 'not_permitted' });
    expect(result.text).not.toMatch(/unitPrice|leadTimeDays|currency|totals/);
    expect(env.mocks.pricing.stats.calls).toBe(0);
  });

  it('get_item_details follows the same entitlements as the sidebar', async () => {
    env = await startTestEnv();
    const client = await connect(await env.listen(), 'channel_partner');
    const details = (await callTool(client, 'get_item_details', { projectId: PROJECT, item: 'DRV-03' })).json();
    expect(details.panels.pricing).toEqual({ status: 'not_permitted' });
    expect(details.panels.catalogue.status).toBe('ok');
  });

  it('cannot open a project the user is not a member of', async () => {
    env = await startTestEnv();
    const client = await connect(await env.listen());
    const result = await callTool(client, 'get_bom_cost', { projectId: 'P-30002' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not_found/);
    expect(env.audit.entries.at(-1)).toMatchObject({ action: 'get_bom_cost', outcome: 'denied' });
  });

  it('rejects calls without a valid token', async () => {
    env = await startTestEnv();
    const base = await env.listen();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('resize_item needs the user to confirm', () => {
  const confirm = (base: string, token: string, proposalId: string) =>
    fetch(`${base}/projects/${PROJECT}/assistant/proposals/${proposalId}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

  it('only proposes; the item changes when the user confirms, and only once', async () => {
    env = await startTestEnv();
    const base = await env.listen();
    const client = await connect(base);

    const proposal = (await callTool(client, 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 110 })).json();
    expect(proposal).toMatchObject({ status: 'confirmation_required', change: { previousVariant: 'R7-IP54', variantCode: 'R8-IP54' } });
    expect(proposal.summary).toMatch(/Change DRV-03 from R7-IP54 to R8-IP54/);
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item).toMatchObject({ variantCode: 'R7-IP54', revision: 1 });

    const token = await env.token('sales_engineer');
    const confirmed = await confirm(base, token, proposal.proposalId);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ variantCode: 'R8-IP54', modelRef: 'R8-v2', revision: 2 });

    expect((await confirm(base, token, proposal.proposalId)).status).toBe(404);
    expect(env.audit.entries.map((entry) => entry.outcome)).toEqual(['proposed', 'confirmed']);
  });

  it('does not let another user confirm the proposal', async () => {
    env = await startTestEnv();
    const base = await env.listen();
    const proposal = (await callTool(await connect(base), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 110 })).json();

    const res = await confirm(base, await env.token('admin'), proposal.proposalId);
    expect(res.status).toBe(404);
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item.variantCode).toBe('R7-IP54');
  });

  it('refuses a proposal that has expired', async () => {
    env = await startTestEnv({ config: { assistant: { proposalTtlMs: 30 } } });
    const base = await env.listen();
    const proposal = (await callTool(await connect(base), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 110 })).json();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await confirm(base, await env.token('sales_engineer'), proposal.proposalId)).status).toBe(410);
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item.revision).toBe(1);
  });

  it('refuses to confirm when the item changed after the proposal was made', async () => {
    env = await startTestEnv();
    const base = await env.listen();
    const proposal = (await callTool(await connect(base), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 110 })).json();
    await env.request('POST', `/projects/${PROJECT}/items/${ITEMS['DRV-03']}/resize`, { body: { motorKw: 150 } });

    expect((await confirm(base, await env.token('sales_engineer'), proposal.proposalId)).status).toBe(409);
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item.variantCode).toBe('R9-IP54');
  });

  it('does not let a channel partner propose a re-size', async () => {
    env = await startTestEnv();
    const result = await callTool(await connect(await env.listen(), 'channel_partner'), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 110 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/forbidden/);
    expect(env.mocks.sizing.stats.calls).toBe(0);
  });

  it('reports no change when the current drive is still large enough', async () => {
    env = await startTestEnv();
    const result = (await callTool(await connect(await env.listen()), 'resize_item', { projectId: PROJECT, item: 'DRV-03', motorKw: 70 })).json();
    expect(result.status).toBe('no_change');
  });
});
