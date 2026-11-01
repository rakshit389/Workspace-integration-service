import { afterEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { bomUrl, ITEMS, resizeUrl, sidebarUrl, startTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.close());

describe('authentication', () => {
  const call = (authorization?: string) =>
    env.app.inject({ method: 'GET', url: bomUrl, headers: authorization ? { authorization } : {} });

  it('rejects a missing token', async () => {
    env = await startTestEnv();
    const res = await call();
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects a token signed with another key', async () => {
    env = await startTestEnv();
    const forged = await new SignJWT({ role: 'admin', country: 'DE' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('attacker')
      .setIssuer(env.config.auth.issuer)
      .setAudience(env.config.auth.audience)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('some-other-secret-that-is-long-enough'));
    expect((await call(`Bearer ${forged}`)).statusCode).toBe(401);
  });

  it('rejects a token for another audience', async () => {
    env = await startTestEnv();
    const other = await new SignJWT({ role: 'admin', country: 'DE' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user')
      .setIssuer(env.config.auth.issuer)
      .setAudience('some-other-api')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(env.config.auth.secret));
    expect((await call(`Bearer ${other}`)).statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    env = await startTestEnv();
    const expired = await env.token('sales_engineer', 'DE', Math.floor(Date.now() / 1000) - 60);
    const res = await call(`Bearer ${expired}`);
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Token has expired');
  });
});

describe('project access', () => {
  const OTHER = 'P-30002';
  const OTHER_DRIVE = 'a7c2e9f4-3b1d-4e8a-9f6c-0d2b5e8a1c07';

  it('answers 404 on every route of a project the user is not a member of', async () => {
    env = await startTestEnv();
    const urls = [`/projects/${OTHER}`, `/projects/${OTHER}/bom`, `/projects/${OTHER}/items/${OTHER_DRIVE}/sidebar`, `/projects/${OTHER}/items/${OTHER_DRIVE}/panels/pricing`];

    for (const url of urls) {
      const res = await env.request('GET', url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().message).toBe(`Project ${OTHER} not found`);
    }
    const resize = await env.request('POST', `/projects/${OTHER}/items/${OTHER_DRIVE}/resize`, { body: { motorKw: 50 } });
    expect(resize.statusCode).toBe(404);
    expect(env.mocks.sizing.stats.calls + env.mocks.pricing.stats.calls + env.mocks.catalogue.stats.calls).toBe(0);
  });

  it('lets a member open their own project', async () => {
    env = await startTestEnv();
    const res = await env.request('GET', `/projects/${OTHER}/bom`, { sub: 'user-other-engineer' });
    expect(res.statusCode).toBe(200);
    expect(res.json().lines[0]).toMatchObject({ variantCode: 'R5-IP21', quantity: 1 });
  });

  it('lets an administrator open any project', async () => {
    env = await startTestEnv();
    const res = await env.request('GET', `/projects/${OTHER}`, { role: 'admin' });
    expect(res.statusCode).toBe(200);
  });
});

describe('price entitlements', () => {
  it('marks pricing not_permitted for a channel partner and never calls the ERP', async () => {
    env = await startTestEnv();
    const res = await env.request('GET', sidebarUrl(ITEMS['DRV-03']), { role: 'channel_partner' });

    const { panels } = res.json();
    expect(panels.pricing).toEqual({ status: 'not_permitted' });
    expect(panels.catalogue.status).toBe('ok');
    expect(env.mocks.pricing.stats.calls).toBe(0);
  });

  it('returns the BOM without any price or lead-time fields for a channel partner', async () => {
    env = await startTestEnv();
    const bom = (await env.request('GET', bomUrl, { role: 'channel_partner' })).json();

    expect(bom.pricing).toEqual({ status: 'not_permitted' });
    expect(bom.totals).toBeUndefined();
    expect(bom.lines).toHaveLength(4);
    for (const line of bom.lines) {
      expect(Object.keys(line).sort()).toEqual(['description', 'itemTags', 'quantity', 'variantCode']);
    }
    expect(JSON.stringify(bom)).not.toMatch(/unitPrice|leadTimeDays|currency/);
    expect(env.mocks.pricing.stats.calls).toBe(0);
  });

  it('prices the BOM in the currency of the country in the token', async () => {
    env = await startTestEnv();
    const de = (await env.request('GET', bomUrl, { country: 'DE' })).json();
    const us = (await env.request('GET', bomUrl, { country: 'US' })).json();

    expect(de.pricing.status).toBe('ok');
    expect(de.totals.currency).toBe('EUR');
    expect(us.totals.currency).toBe('USD');
    expect(de.totals.longestLeadTime).toMatchObject({ days: 42, variantCode: 'R7-IP54', itemTags: ['DRV-03'] });
    const cabinets = de.lines.find((line: { variantCode: string }) => line.variantCode === 'CAB-800');
    expect(cabinets).toMatchObject({ quantity: 2, itemTags: ['CAB-01', 'CAB-02'], unitPrice: 1564, lineTotal: 3128 });
  });

  it('ignores a country supplied in the request instead of the token', async () => {
    env = await startTestEnv();
    const bom = (await env.request('GET', `${bomUrl}?country=US`, { country: 'DE' })).json();
    expect(bom.totals.currency).toBe('EUR');
  });

  it('denies an unknown role by default', async () => {
    env = await startTestEnv();
    const res = await env.request('GET', bomUrl, { role: 'intern' });
    expect(res.statusCode).toBe(403);
  });

  it('does not let a channel partner re-size', async () => {
    env = await startTestEnv();
    const res = await env.request('POST', resizeUrl(ITEMS['DRV-03']), { role: 'channel_partner', body: { motorKw: 110 } });
    expect(res.statusCode).toBe(403);
    expect(env.mocks.sizing.stats.calls).toBe(0);
  });
});
