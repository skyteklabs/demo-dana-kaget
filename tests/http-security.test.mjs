import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../server.mjs';
import { claimConfig } from '../lib/delivery.mjs';
import { createHttpSecurity, createRequestLimiter } from '../lib/http-security.mjs';

const live = {
  APP_MODE: 'live', PUBLIC_ORIGIN: 'https://claim.example.test',
  TURNSTILE_SITE_KEY: 'fixture-site', TURNSTILE_SECRET_KEY: 'fixture-secret',
  KIRIM_EMAIL_DOMAIN: 'example.test', KIRIM_EMAIL_USERNAME: 'fixture-user', KIRIM_EMAIL_PASSWORD: 'fixture-password',
  EMAIL_FROM: 'claim@example.test', CLAIM_SECRET: 'fixture-claim-secret-'.repeat(3),
};
async function request(handler, url, { method = 'GET', body, headers = {}, ip = '192.0.2.10' } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { url, method, headers: { host: 'claim.example.test', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: ip } });
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, fields) { this.status = status; Object.assign(this.headers, fields); }, end(data) { this.body = data?.toString() || ''; } };
  await handler(req, res);
  return res;
}
const event = () => ({ name: 'dk_page_view', id: randomUUID(), at: Date.now(), properties: { journey_id: randomUUID(), sequence: 1, step_id: 'email', step_number: 1 } });

test('live reports and export deny direct and encoded requests even without Traefik', async () => {
  let reads = 0;
  const handler = createHandler({ env: live, store: { all: () => { reads++; return []; } } });
  for (const path of ['/analytics', '/analytics/', '/report.html', '/%72eport.html', '/a/../report.html', '/api/report', '/api/%72eport', '/api/events/export', '/api/events%2fexport']) {
    for (const method of ['GET', 'HEAD']) assert.equal((await request(handler, path, { method })).status, 404, `${method} ${path}`);
  }
  assert.equal(reads, 0);
  assert.equal((await request(handler, '/analytics/tracker.js')).status, 200);
  const config = JSON.parse((await request(handler, '/api/config')).body);
  assert.equal(config.reportsAvailable, false);
});

test('operator Basic authentication protects report pages and data without exposing credentials', async () => {
  const env = { ...live, REPORTS_USER: 'operator', REPORTS_PASSWORD: 'operator-private-password-'.repeat(3) };
  const handler = createHandler({ env, store: { all: () => [] } });
  const authorization = 'Basic ' + Buffer.from(`${env.REPORTS_USER}:${env.REPORTS_PASSWORD}`).toString('base64');
  for (const path of ['/analytics', '/report.html', '/api/report', '/api/events/export']) {
    const denied = await request(handler, path);
    assert.equal(denied.status, 401);
    assert.match(denied.headers['www-authenticate'], /^Basic /);
    assert.equal((await request(handler, path, { headers: { authorization: 'Basic ' + Buffer.from('operator:wrong').toString('base64') } })).status, 401);
    const response = await request(handler, path, { headers: { authorization } });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const config = await request(handler, '/api/config');
  assert.equal(JSON.parse(config.body).reportsAvailable, true);
  assert.equal(config.body.includes(env.REPORTS_PASSWORD), false);
  assert.throws(() => createHandler({ env: { ...live, REPORTS_USER: 'operator' } }), { code: 'invalid_reports_configuration' });
  assert.throws(() => createHandler({ env: { ...live, REPORTS_USER: 'operator', REPORTS_PASSWORD: 'short' } }), { code: 'invalid_reports_configuration' });
});

test('live sessions use host-only secure cookie names and reject an unprefixed cookie', async () => {
  const seen = [];
  const handler = createHandler({ env: live, claims: { request: async (_body, session, ip) => { seen.push({ session, ip }); return {}; } } });
  const config = await request(handler, '/api/config', { headers: { cookie: 'dana_session=' + 'a'.repeat(64) } });
  assert.match(config.headers['set-cookie'], /^__Host-dana_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=86400; Secure$/);
  const post = { method: 'POST', body: {}, headers: { origin: live.PUBLIC_ORIGIN, cookie: 'dana_session=' + 'a'.repeat(64) } };
  assert.equal((await request(handler, '/api/code/request', post)).status, 401);
  post.headers.cookie = config.headers['set-cookie'].split(';')[0];
  assert.equal((await request(handler, '/api/code/request', post)).status, 200);
  assert.equal(seen.length, 1);
});

test('host and origin validation block DNS rebinding, malformed origins, and cross-origin POSTs', async () => {
  const local = createHandler({ env: {}, store: { append: async () => [] } });
  assert.equal((await request(local, '/api/report', { headers: { host: 'attacker.example' } })).status, 403);
  assert.equal((await request(local, '/api/config', { headers: { host: '127.0.0.1:4173' } })).status, 200);
  const handler = createHandler({ env: live, store: { append: async () => [] } });
  const payload = { consent: 'granted', events: [event()] };
  for (const origin of [undefined, 'null', 'https://other.example.test', 'https://claim.example.test/path', 'not-a-url']) {
    assert.equal((await request(handler, '/api/events', { method: 'POST', body: payload, headers: { origin } })).status, 403, origin);
  }
  assert.equal((await request(handler, '/api/events', { method: 'POST', body: payload, headers: { origin: live.PUBLIC_ORIGIN } })).status, 200);
  assert.equal((await request(handler, '/api/events', { method: 'POST', body: payload, headers: { origin: live.PUBLIC_ORIGIN, 'content-type': 'application/jsonp' } })).status, 415);
  assert.equal((await request(handler, '/healthz', { headers: { host: '127.0.0.1:4173' } })).status, 200);
});

test('forwarded addresses are accepted only from configured proxy hops, walking from the right', () => {
  const security = createHttpSecurity({ TRUSTED_PROXY_CIDRS: '10.0.0.2/32,2001:db8::2/128' }, claimConfig({}));
  const req = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwarded } });
  assert.equal(security.clientIP(req('192.0.2.10', '198.51.100.1')), '192.0.2.10');
  assert.equal(security.clientIP(req('::ffff:10.0.0.2', '203.0.113.99, 198.51.100.1')), '198.51.100.1');
  assert.equal(security.clientIP(req('2001:db8::2', '198.51.100.1, 10.0.0.2')), '198.51.100.1');
  assert.throws(() => security.clientIP(req('10.0.0.2', 'not-an-ip')), { code: 'invalid_forwarded_address' });
  for (const cidr of ['0.0.0.0/0', '::/0', '10.0.0.2/33', 'example.test', '10.0.0.2/32/extra']) assert.throws(() => createHttpSecurity({ TRUSTED_PROXY_CIDRS: cidr }, claimConfig({})), { code: 'invalid_proxy_configuration' });
});

test('claim limits receive the actual client IP through a trusted proxy', async () => {
  const peers = [];
  const handler = createHandler({ env: { ...live, TRUSTED_PROXY_CIDRS: '10.0.0.2/32' }, claims: { request: async (_body, _session, ip) => { peers.push(ip); return {}; } } });
  const headers = { origin: live.PUBLIC_ORIGIN, cookie: '__Host-dana_session=' + 'a'.repeat(64) };
  for (const ip of ['198.51.100.1', '198.51.100.2']) {
    const response = await request(handler, '/api/code/request', { method: 'POST', body: {}, ip: '10.0.0.2', headers: { ...headers, 'x-forwarded-for': ip } });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(peers, ['198.51.100.1', '198.51.100.2']);
});

test('event floods are limited before persistence and spoofed headers cannot reset the budget', async () => {
  let count = 0;
  const handler = createHandler({ env: live, store: { append: async events => { count += events.length; return events.map(e => e.id); } } });
  const body = { consent: 'granted', events: Array.from({ length: 20 }, event) };
  const headers = { origin: live.PUBLIC_ORIGIN };
  for (let i = 0; i < 30; i++) assert.equal((await request(handler, '/api/events', { method: 'POST', body, headers })).status, 200);
  const limited = await request(handler, '/api/events', { method: 'POST', body, headers: { ...headers, 'x-forwarded-for': '203.0.113.22' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(count, 600);
  assert.equal((await request(handler, '/api/events', { method: 'POST', body, headers, ip: '192.0.2.11' })).status, 200);
});

test('request limiter bounds identities and releases expired capacity', () => {
  let now = 0;
  const limiter = createRequestLimiter({ maxKeys: 2, clock: () => now });
  assert.equal(limiter.check('one', 2), 0);
  assert.equal(limiter.check('one', 2), 0);
  assert.equal(limiter.check('one', 2), 60);
  assert.equal(limiter.check('two', 2), 0);
  assert.equal(limiter.check('three', 2), 60);
  now = 60_000;
  assert.equal(limiter.check('three', 2), 0);
});

test('responses prevent framing and script injection and use HSTS in live mode', async () => {
  const response = await request(createHandler({ env: live }), '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(response.headers['content-security-policy'], /script-src 'self' https:\/\/challenges.cloudflare.com/);
  assert.equal(response.headers['content-security-policy'].includes("'unsafe-eval'"), false);
  assert.match(response.headers['strict-transport-security'], /max-age=31536000/);
});
