import { afterEach, describe, expect, it } from 'vitest';
import { ITEMS, PROJECT, resizeUrl, sidebarUrl, startTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.close());

describe('re-size', () => {
  it('moves DRV-03 to a larger frame, swaps the 3D model and returns the BOM change', async () => {
    env = await startTestEnv();
    const res = await env.request('POST', resizeUrl(ITEMS['DRV-03']), { body: { motorKw: 110, baseRevision: 1 } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      changed: true,
      previousVariant: 'R7-IP54',
      variantCode: 'R8-IP54',
      modelRef: 'R8-v2',
      model: { lod: { low: 'models/r8_c42d_low.glb' } },
      revision: 2,
      sizing: { frame: 'R8', loadPct: 88, inputs: { motorKw: 110 } },
      bomChange: {
        lines: [
          { variantCode: 'R7-IP54', quantityBefore: 1, quantityAfter: 0 },
          { variantCode: 'R8-IP54', quantityBefore: 0, quantityAfter: 1 },
        ],
        priceDelta: { status: 'ok', amount: 2116, currency: 'EUR' },
      },
    });

    const { item } = env.repo.getItem(PROJECT, ITEMS['DRV-03']);
    expect(item).toMatchObject({ variantCode: 'R8-IP54', modelRef: 'R8-v2', revision: 2 });
    const sidebar = (await env.request('GET', sidebarUrl(ITEMS['DRV-03']))).json();
    expect(sidebar.panels.catalogue.data.variantCode).toBe('R8-IP54');
  });

  it('keeps the variant when the current frame is still large enough', async () => {
    env = await startTestEnv();
    const res = (await env.request('POST', resizeUrl(ITEMS['DRV-03']), { body: { motorKw: 70 } })).json();

    expect(res).toMatchObject({ changed: false, variantCode: 'R7-IP54', revision: 2, bomChange: { lines: [] } });
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item.sizingInputs?.motorKw).toBe(70);
  });

  it('returns a price delta to an administrator too', async () => {
    env = await startTestEnv();
    const res = (await env.request('POST', resizeUrl(ITEMS['DRV-03']), { role: 'admin', body: { motorKw: 110 } })).json();
    expect(res.bomChange.priceDelta.status).toBe('ok');
  });

  it('rejects a re-size based on an old revision and leaves the item unchanged', async () => {
    env = await startTestEnv();
    const res = await env.request('POST', resizeUrl(ITEMS['DRV-03']), { body: { motorKw: 110, baseRevision: 5 } });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'revision_conflict', currentRevision: 1 });
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item.variantCode).toBe('R7-IP54');
  });

  it('does not change the item when the sizing tool fails', async () => {
    env = await startTestEnv({ sizing: { failRate: 1 } });
    const res = await env.request('POST', resizeUrl(ITEMS['DRV-03']), { body: { motorKw: 110 } });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('sizing_unavailable');
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item).toMatchObject({ variantCode: 'R7-IP54', revision: 1 });
  });

  it('runs once for repeated requests with the same idempotency key', async () => {
    env = await startTestEnv();
    const send = () =>
      env.request('POST', resizeUrl(ITEMS['DRV-03']), { body: { motorKw: 110 }, headers: { 'idempotency-key': 'resize-42' } });

    const [first, second] = await Promise.all([send(), send()]);
    const third = await send();

    expect(first.json()).toEqual(second.json());
    expect(third.json()).toEqual(first.json());
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item.revision).toBe(2);
    expect(env.mocks.sizing.stats.calls).toBe(1);
  });

  it('rejects an idempotency key reused for a different request', async () => {
    env = await startTestEnv();
    const headers = { 'idempotency-key': 'resize-7' };
    await env.request('POST', resizeUrl(ITEMS['DRV-03']), { body: { motorKw: 110 }, headers });
    const res = await env.request('POST', resizeUrl(ITEMS['DRV-03']), { body: { motorKw: 150 }, headers });
    expect(res.statusCode).toBe(422);
  });

  it('validates the request body', async () => {
    env = await startTestEnv();
    const res = await env.request('POST', resizeUrl(ITEMS['DRV-03']), { body: { motorKw: -5 } });
    expect(res.statusCode).toBe(400);
  });

  it('creates a proposal without changing the item (used by the MCP service)', async () => {
    env = await startTestEnv();
    const res = await env.request('POST', `/projects/${PROJECT}/items/${ITEMS['DRV-03']}/resize-proposals`, { body: { motorKw: 110 } });

    expect(res.json()).toMatchObject({ status: 'confirmation_required', change: { variantCode: 'R8-IP54' } });
    expect(env.repo.getItem(PROJECT, ITEMS['DRV-03']).item).toMatchObject({ variantCode: 'R7-IP54', revision: 1 });
    expect((await env.request('POST', `/projects/${PROJECT}/items/${ITEMS['DRV-03']}/resize-proposals`, { role: 'channel_partner', body: { motorKw: 110 } })).statusCode).toBe(403);
  });

  it('only re-sizes drives', async () => {
    env = await startTestEnv();
    const res = await env.request('POST', resizeUrl(ITEMS['CAB-01']), { body: { motorKw: 110 } });
    expect(res.statusCode).toBe(422);
  });
});
