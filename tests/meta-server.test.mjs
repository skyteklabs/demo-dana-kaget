import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../server.mjs';
import { createClaimStore } from '../lib/claims.mjs';
import { claimService } from '../lib/claim-service.mjs';
import { createMetaConversions, metaConfig } from '../lib/meta-conversions.mjs';
import { CONSENT_VERSION } from '../public/analytics/consent.js';

const env = { META_PIXEL_ID: '123456789012345', META_ACCESS_TOKEN: 'synthetic-private-access-token', META_TEST_EVENT_CODE: 'TEST_SYNTHETIC' };
const event = (name = 'dk_page_view', properties = {}) => ({
  name, id: randomUUID(), at: Date.now(),
  properties: { journey_id: randomUUID(), sequence: 1, step_id: 'email', step_number: 1, ...properties },
});
const store = { append: async events => events.map(event => event.id), all: () => [] };
async function request(handler, url, { body, cookie, headers = {}, ip = '192.0.2.10' } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { url, method: body === undefined ? 'GET' : 'POST', socket: { remoteAddress: ip }, headers: {
    host: 'localhost:4173', 'content-type': 'application/json', 'user-agent': 'Synthetic test browser/1.0',
    ...(cookie ? { cookie } : {}), ...headers,
  } });
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.text = body?.toString() || ''; } };
  await handler(req, res);
  res.body = JSON.parse(res.text);
  return res;
}
function recorder() {
  const calls = [];
  return { calls, send: (...args) => calls.push(args), snapshot: () => ({ enabled: true, attempted: calls.length, accepted: 0 }) };
}

test('public config exposes only the Meta availability flag and operator reports expose counters', async () => {
  const meta = recorder();
  const handler = createHandler({ env, store, meta });
  const config = await request(handler, '/api/config');
  assert.equal(config.body.metaConversionsEnabled, true);
  for (const value of Object.values(env)) assert.equal(config.text.includes(value), false);
  assert.equal((await request(createHandler({ env: {}, store }), '/api/config')).body.metaConversionsEnabled, false);
  assert.deepEqual((await request(handler, '/api/report')).body.meta, meta.snapshot());
  assert.deepEqual(meta.calls, []);
});

test('only explicitly consented current-version PageViews are forwarded, never claimed client conversions', async () => {
  const meta = recorder();
  const handler = createHandler({ env, store, meta });
  const batch = { consent: 'granted', events: [event()] };
  for (const extra of [{}, { metaConsent: true }, { metaConsent: true, consentVersion: 'old' }, { metaConsent: false, consentVersion: CONSENT_VERSION }]) {
    assert.equal((await request(handler, '/api/events', { body: { ...batch, ...extra } })).status, 200);
  }
  assert.equal((await request(handler, '/api/events', { body: { ...batch, consent: 'denied', metaConsent: true, consentVersion: CONSENT_VERSION } })).status, 403);
  const accepted = await request(handler, '/api/events', { body: {
    consent: 'granted', metaConsent: true, consentVersion: CONSENT_VERSION,
    events: [event('dk_claim_success', { state: 'new' }), event('dk_email_accepted'), event('dk_reward_open'), batch.events[0]],
  } });
  assert.equal(accepted.status, 200);
  assert.equal(meta.calls.length, 1);
  assert.deepEqual(meta.calls[0], [{ name: 'PageView', id: batch.events[0].id, at: batch.events[0].at }, { ip: '192.0.2.10', userAgent: 'Synthetic test browser/1.0' }]);
});

test('Meta PageViews deduplicate beacon retries and use trusted client IP with a canonical URL', async () => {
  const outgoing = [];
  const meta = createMetaConversions(metaConfig(env, 'http://localhost:4173'), { fetcher: async (url, options) => {
    outgoing.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ events_received: 1 }));
  } });
  const handler = createHandler({ env: { ...env, TRUSTED_PROXY_CIDRS: '10.0.0.2/32' }, store, meta });
  const page = event('dk_page_view', { email: 'private@example.test', value: 'private-reward', href: 'https://dana.id/private-reward' });
  const body = { consent: 'granted', consentVersion: CONSENT_VERSION, metaConsent: true, events: [page] };
  for (let i = 0; i < 2; i++) {
    const response = await request(handler, '/api/events?private=do-not-forward', { body, ip: '10.0.0.2', headers: {
      'x-forwarded-for': '203.0.113.55, 198.51.100.8', referer: 'https://example.test/?email=private@example.test',
    } });
    assert.equal(response.status, 200);
  }
  await meta.flush();
  assert.equal(outgoing.length, 1);
  assert.equal(meta.snapshot().duplicates, 1);
  assert.equal(outgoing[0].body.data[0].user_data.client_ip_address, '198.51.100.8');
  assert.equal(outgoing[0].body.data[0].event_source_url, 'http://localhost:4173/dana-kaget');
  assert.equal(JSON.stringify(outgoing).includes('private'), false);
});

test('first verified claim sends one conversion; retries, later OTPs and invalid claims send none', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dana-meta-claim-'));
  let now = Date.now();
  const inventory = await createClaimStore(directory, { clock: () => now, rewardLink: 'https://dana.id/synthetic-private-reward' });
  t.after(async () => { inventory.close(); await rm(directory, { recursive: true, force: true }); });
  const meta = recorder();
  const claims = claimService(inventory, { verify: async () => {}, send: async () => {} });
  const handler = createHandler({ env, store, meta, claims });
  const config = await request(handler, '/api/config');
  const cookie = config.headers['set-cookie'].split(';')[0];
  const session = cookie.split('=')[1];
  const pending = inventory.prepare('verified@example.test', session);
  inventory.sent(pending.id);
  const body = { requestId: pending.id, verificationCode: pending.code, analyticsConsent: 'granted', consentVersion: CONSENT_VERSION };
  assert.equal((await request(handler, '/api/claim', { body })).status, 401);
  assert.equal((await request(handler, '/api/claim', { cookie, body: { ...body, verificationCode: pending.code === '000000' ? '111111' : '000000' } })).status, 400);
  assert.equal(meta.calls.length, 0);
  const first = await request(handler, '/api/claim', { body, cookie });
  assert.equal(first.status, 200);
  assert.equal(first.body.recovered, false);
  assert.equal(meta.calls.length, 1);
  assert.equal(meta.calls[0][0].name, 'CompleteRegistration');
  assert.match(meta.calls[0][0].id, /^[a-f0-9-]{36}$/);
  assert.equal((await request(handler, '/api/claim', { body, cookie })).body.recovered, true);
  now += 61_000;
  const renewed = inventory.prepare('verified@example.test', session);
  inventory.sent(renewed.id);
  assert.equal((await request(handler, '/api/claim', { cookie, body: { ...body, requestId: renewed.id, verificationCode: renewed.code } })).body.recovered, true);
  assert.equal(meta.calls.length, 1);
  const payload = JSON.stringify(meta.calls);
  assert.equal(payload.includes('verified@example.test'), false);
  assert.equal(payload.includes('synthetic-private-reward'), false);
  assert.equal(payload.includes(pending.id), false);
});

test('claim consent and configuration are required; Meta failure never changes a successful claim', async () => {
  const meta = recorder();
  const result = { reward: { kind: 'link', value: 'https://dana.id/synthetic' }, recovered: false };
  const claims = { claim: async () => result };
  const cookie = 'dana_session=' + 'a'.repeat(64);
  const handler = createHandler({ env, store, meta, claims });
  for (const body of [{}, { analyticsConsent: 'granted' }, { analyticsConsent: 'denied', consentVersion: CONSENT_VERSION }, { analyticsConsent: 'granted', consentVersion: 'old' }]) {
    assert.deepEqual((await request(handler, '/api/claim', { body, cookie })).body, result);
  }
  const granted = { analyticsConsent: 'granted', consentVersion: CONSENT_VERSION };
  assert.equal((await request(createHandler({ env: {}, store, meta, claims }), '/api/claim', { body: granted, cookie })).status, 200);
  assert.equal(meta.calls.length, 0);
  const throwing = createHandler({ env, store, claims, meta: { send() { throw new Error('private-provider-error'); } } });
  assert.deepEqual((await request(throwing, '/api/claim', { body: granted, cookie })).body, result);
});

test('operator-only Meta counters stay behind report authentication in live mode', async () => {
  const live = { ...env, APP_MODE: 'live', PUBLIC_ORIGIN: 'https://dana.skytek.id',
    TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'fixture-secret', CLAIM_SECRET: 'fixture-secret-'.repeat(4),
    KIRIM_EMAIL_DOMAIN: 'example.test', KIRIM_EMAIL_USERNAME: 'fixture-user', KIRIM_EMAIL_PASSWORD: 'fixture-password', EMAIL_FROM: 'fixture@example.test',
    REPORTS_USER: 'operator', REPORTS_PASSWORD: 'fixture-report-password-'.repeat(3),
  };
  const handler = createHandler({ env: live, store });
  const headers = { host: 'dana.skytek.id' };
  assert.equal((await request(handler, '/api/report', { headers })).status, 401);
  const authorization = 'Basic ' + Buffer.from(`${live.REPORTS_USER}:${live.REPORTS_PASSWORD}`).toString('base64');
  const report = await request(handler, '/api/report', { headers: { ...headers, authorization } });
  assert.equal(report.status, 200);
  assert.equal(report.body.meta.enabled, true);
  assert.equal(report.body.meta.attempted, 0);
  for (const key of ['META_ACCESS_TOKEN', 'META_TEST_EVENT_CODE', 'REPORTS_PASSWORD']) assert.equal(report.text.includes(live[key]), false);
});
