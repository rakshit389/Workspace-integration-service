import { afterEach, describe, expect, it } from 'vitest';
import { ITEMS, sidebarUrl, startTestEnv, wait, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.close());

describe('sidebar: partial results', () => {
  it('returns every panel as ok when all systems are healthy', async () => {
    env = await startTestEnv();
    const res = await env.request('GET', sidebarUrl(ITEMS['DRV-03']));

    expect(res.statusCode).toBe(200);
    const { panels } = res.json();
    expect(panels.catalogue).toMatchObject({ status: 'ok', data: { variantCode: 'R7-IP54', model: { modelId: 'R7-v3' } } });
    expect(panels.sizing).toMatchObject({ status: 'ok', data: { frame: 'R7', loadPct: 88, matchesPlacedVariant: true } });
    expect(panels.pricing).toMatchObject({ status: 'ok', data: { currency: 'EUR', leadTimeDays: 42 } });
  });

  it('keeps catalogue and pricing when the sizing tool fails, and stays within the 1 s budget', async () => {
    env = await startTestEnv({ sizing: { failRate: 1 } });
    const started = Date.now();
    const res = await env.request('GET', sidebarUrl(ITEMS['DRV-03']));

    expect(Date.now() - started).toBeLessThan(1_000);
    const { panels } = res.json();
    expect(panels.sizing.status).toBe('unavailable');
    expect(panels.sizing.message).toMatch(/Sizing tool responded with 503/);
    expect(panels.catalogue.status).toBe('ok');
    expect(panels.pricing.status).toBe('ok');
  });

  it('returns pending within budget for a slow sizing run, then ok once it finishes (one call to the tool)', async () => {
    env = await startTestEnv({ sizing: { minLatencyMs: 900, maxLatencyMs: 900 }, config: { budgets: { sidebarMs: 300 } } });

    const started = Date.now();
    const first = (await env.request('GET', sidebarUrl(ITEMS['DRV-03']))).json();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(first.panels.sizing).toMatchObject({ status: 'pending', retryAfterMs: 1_000 });
    expect(first.panels.catalogue.status).toBe('ok');

    await wait(800);
    const second = (await env.request('GET', sidebarUrl(ITEMS['DRV-03']))).json();
    expect(second.panels.sizing.status).toBe('ok');
    expect(env.mocks.sizing.stats.calls).toBe(1);
  });

  it('serves the last good sizing result as stale when the cache has expired and the tool is down', async () => {
    env = await startTestEnv({ config: { sizing: { ttlMs: 50 } } });
    const fresh = (await env.request('GET', sidebarUrl(ITEMS['DRV-03']))).json();
    expect(fresh.panels.sizing.status).toBe('ok');

    await wait(80);
    env.mocks.sizing.options.failRate = 1;
    const res = (await env.request('GET', sidebarUrl(ITEMS['DRV-03']))).json();
    expect(res.panels.sizing).toMatchObject({ status: 'stale', data: { frame: 'R7' } });
    expect(res.panels.sizing.asOf).toBe(fresh.panels.sizing.asOf);
  });

  it('opens the circuit after repeated sizing failures and stops calling the tool', async () => {
    env = await startTestEnv({
      sizing: { failRate: 1 },
      config: { sizing: { retry: { retries: 0 }, breaker: { failureThreshold: 2, cooldownMs: 60_000 } } },
    });

    for (const itemId of [ITEMS['DRV-03'], ITEMS['DRV-04'], ITEMS['DRV-03'], ITEMS['DRV-04']]) {
      await env.request('GET', sidebarUrl(itemId));
    }

    expect(env.mocks.sizing.stats.calls).toBe(2);
    const res = (await env.request('GET', sidebarUrl(ITEMS['DRV-03']))).json();
    expect(res.panels.sizing).toMatchObject({ status: 'unavailable', message: expect.stringMatching(/circuit is open/) });
    expect(env.adapters.sizing.breaker.currentState).toBe('open');
  });

  it('retries a failing sizing call with backoff and succeeds when the tool recovers', async () => {
    let calls = 0;
    env = await startTestEnv({ sizing: { random: () => (calls++ < 2 ? 0 : 0.99), failRate: 0.5 } });
    const res = (await env.request('GET', sidebarUrl(ITEMS['DRV-04']))).json();

    expect(res.panels.sizing).toMatchObject({ status: 'ok', data: { frame: 'R6' } });
    expect(env.mocks.sizing.stats.failures).toBe(1);
    expect(env.mocks.sizing.stats.calls).toBe(2);
  });

  it('does not show a sizing panel for cabinets', async () => {
    env = await startTestEnv();
    const { panels } = (await env.request('GET', sidebarUrl(ITEMS['CAB-01']))).json();
    expect(Object.keys(panels)).toEqual(['catalogue', 'pricing']);
  });

  it('refreshes one panel through the per-panel endpoint', async () => {
    env = await startTestEnv();
    const res = await env.request('GET', `/projects/P-24117/items/${ITEMS['DRV-03']}/panels/pricing`);
    expect(res.json()).toMatchObject({ panel: 'pricing', status: 'ok' });
  });

  it('returns 404 for an unknown item', async () => {
    env = await startTestEnv();
    const res = await env.request('GET', sidebarUrl('does-not-exist'));
    expect(res.statusCode).toBe(404);
  });
});
