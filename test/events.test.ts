import { afterEach, describe, expect, it } from 'vitest';
import { ITEMS, PROJECT, openStream, resizeUrl, sidebarUrl, startTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
const streams: Array<{ close: () => void }> = [];

afterEach(async () => {
  streams.splice(0).forEach((stream) => stream.close());
  await env?.close();
});

const eventsUrl = (base: string, projectId = PROJECT) => `${base}/projects/${projectId}/events`;

async function subscribe(base: string, role = 'sales_engineer') {
  const stream = await openStream(eventsUrl(base), { authorization: `Bearer ${await env.token(role)}` });
  streams.push(stream);
  await stream.waitFor((event) => event.event === 'ready');
  return stream;
}

describe('server push (SSE)', () => {
  it('pushes a slow sizing result to the panel when it completes', async () => {
    env = await startTestEnv({ sizing: { minLatencyMs: 500, maxLatencyMs: 500 }, config: { budgets: { sidebarMs: 150 } } });
    const stream = await subscribe(await env.listen());

    const sidebar = (await env.request('GET', sidebarUrl(ITEMS['DRV-03']))).json();
    expect(sidebar.panels.sizing.status).toBe('pending');

    const pushed = await stream.waitFor((event) => event.event === 'panel.updated' && event.data.panel === 'sizing');
    expect(pushed.data).toMatchObject({ itemId: ITEMS['DRV-03'], status: 'ok', data: { frame: 'R7', loadPct: 88 } });
    expect(env.mocks.sizing.stats.calls).toBe(1);
  });

  it('sends panel updates only to the user who asked, because they carry that user’s prices', async () => {
    env = await startTestEnv({ sizing: { minLatencyMs: 400, maxLatencyMs: 400 }, config: { budgets: { sidebarMs: 100 } } });
    const base = await env.listen();
    const asker = await subscribe(base, 'sales_engineer');
    const partner = await subscribe(base, 'channel_partner');

    await env.request('GET', sidebarUrl(ITEMS['DRV-03']));
    await asker.waitFor((event) => event.event === 'panel.updated');
    expect(partner.received.some((event) => event.event === 'panel.updated')).toBe(false);
  });

  it('tells every viewer of the project about a re-size, without prices', async () => {
    env = await startTestEnv();
    const base = await env.listen();
    const partner = await subscribe(base, 'channel_partner');

    await env.request('POST', resizeUrl(ITEMS['DRV-03']), { body: { motorKw: 110 } });
    const update = await partner.waitFor((event) => event.event === 'item.updated');
    expect(update.data).toEqual({ itemId: ITEMS['DRV-03'], tag: 'DRV-03', revision: 2, variantCode: 'R8-IP54', modelRef: 'R8-v2' });
  });

  it('lets a browser subscribe with a one-time ticket instead of a header', async () => {
    env = await startTestEnv();
    const base = await env.listen();
    const { url } = (await env.request('POST', `/projects/${PROJECT}/events/ticket`)).json();

    const stream = await openStream(`${base}${url}`);
    streams.push(stream);
    expect(stream.status).toBe(200);
    await stream.waitFor((event) => event.event === 'ready');

    const reused = await openStream(`${base}${url}`);
    expect(reused.status).toBe(401);
  });

  it('does not open a stream for a project the user is not a member of', async () => {
    env = await startTestEnv();
    const stream = await openStream(eventsUrl(await env.listen(), 'P-30002'), { authorization: `Bearer ${await env.token()}` });
    expect(stream.status).toBe(404);
  });

  it('requires a token or a ticket', async () => {
    env = await startTestEnv();
    const stream = await openStream(eventsUrl(await env.listen()));
    expect(stream.status).toBe(401);
  });
});
