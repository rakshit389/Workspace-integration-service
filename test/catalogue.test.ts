import { afterEach, describe, expect, it } from 'vitest';
import { startTestEnv, wait, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.close());

const codes = (body: { results: Array<{ variantCode: string }> }) => body.results.map((variant) => variant.variantCode);

describe('catalogue search', () => {
  it('matches every word of the text in the code or description', async () => {
    env = await startTestEnv();
    const body = (await env.request('GET', '/catalogue/search?q=r8')).json();
    expect(codes(body)).toEqual(['R8-IP21', 'R8-IP54']);
    expect(body.total).toBe(2);
  });

  it('filters by kind, power and IP rating, smallest first', async () => {
    env = await startTestEnv();
    const body = (await env.request('GET', '/catalogue/search?kind=drive&minKw=60&maxKw=130&ipRating=IP54')).json();
    expect(codes(body)).toEqual(['R6-IP54', 'R7-IP54', 'R8-IP54']);
  });

  it('loads the read model once from the export and searches it without calling the catalogue again', async () => {
    env = await startTestEnv();
    await env.request('GET', '/catalogue/search?q=cabinet');
    await env.request('GET', '/catalogue/search?kind=panel');
    await env.request('GET', '/catalogue/search?minKw=100');

    expect(env.mocks.catalogue.stats.exports).toBe(1);
    expect(env.mocks.catalogue.stats.calls).toBe(0);
  });

  it('keeps serving the last read model when a refresh fails', async () => {
    env = await startTestEnv({ config: { catalogue: { ttlMs: 30 } } });
    expect((await env.request('GET', '/catalogue/search?q=r7')).statusCode).toBe(200);

    await wait(50);
    env.mocks.catalogue.options.failRate = 1;
    const res = await env.request('GET', '/catalogue/search?q=r7');
    expect(res.statusCode).toBe(200);
    expect(codes(res.json())).toEqual(['R7-IP21', 'R7-IP54']);
  });

  it('answers 503 when the catalogue has never loaded and the export is down', async () => {
    env = await startTestEnv({ catalogue: { failRate: 1 } });
    const res = await env.request('GET', '/catalogue/search?q=r7');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('catalogue_unavailable');
  });

  it('rejects unknown filters and unknown roles', async () => {
    env = await startTestEnv();
    expect((await env.request('GET', '/catalogue/search?colour=red')).statusCode).toBe(400);
    expect((await env.request('GET', '/catalogue/search?q=r7', { role: 'intern' })).statusCode).toBe(403);
  });
});
