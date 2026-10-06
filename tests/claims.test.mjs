import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createClaimStore, parseInventory, OTP_TTL, normalizeEmail, fail } from '../lib/claims.mjs';
import { claimService } from '../lib/claim-service.mjs';
import { claimConfig, delivery } from '../lib/delivery.mjs';
import { createHandler } from '../server.mjs';
import { createEventStore } from '../lib/event-store.mjs';
import { isRewardLink } from '../public/reward.js';

const liveEnv = {
  APP_MODE: 'live', TURNSTILE_SITE_KEY: 'live-public', TURNSTILE_SECRET_KEY: 'live-private',
  KIRIM_EMAIL_DOMAIN: 'example.test', KIRIM_EMAIL_USERNAME: 'key_example', KIRIM_EMAIL_PASSWORD: 'example-secret',
  EMAIL_FROM: 'Dana Kaget <claim@example.test>', PUBLIC_ORIGIN: 'https://claim.example.test', CLAIM_SECRET: 'a'.repeat(64),
};

async function fixture(t, count = 3) {
  const directory = await mkdtemp(join(tmpdir(), 'dana-claims-'));
  let now = Date.now();
  const options = { clock: () => now };
  const store = await createClaimStore(directory, options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  if (count) store.import(parseInventory(Array.from({ length: count }, (_, i) => 'DEMO-NOT-REDEEMABLE-' + i).join('\n')));
  const mails = [];
  const provider = { verify: async token => { if (token !== 'test') throw fail('captcha_invalid'); }, send: async data => { mails.push(data); } };
  const service = claimService(store, provider);
  const issue = async (email = 'person@example.test', session = 'session') => {
    const result = await service.request({ email, turnstileToken: 'test' }, session, 'ip');
    return { requestId: result.requestId, verificationCode: mails.at(-1).code };
  };
  return { directory, options, store, mails, service, issue, provider, advance: ms => { now += ms; } };
}
async function request(handler, url, { body, cookie, origin, host = 'localhost:4173' } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.url = url; req.method = body === undefined ? 'GET' : 'POST';
  req.headers = { host, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) };
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(value) { this.text = value?.toString(); } };
  await handler(req, res);
  res.body = JSON.parse(res.text);
  return res;
}

test('claim API requires CAPTCHA and cookie binding, never returns OTP, and retries reuse allocation', async t => {
  const f = await fixture(t);
  const events = await createEventStore(f.directory);
  const handler = createHandler({ store: events, claims: f.service, env: { KIRIM_EMAIL_USERNAME: 'secret-kirim-user', KIRIM_EMAIL_PASSWORD: 'secret-kirim-password', TURNSTILE_SECRET_KEY: 'secret-turnstile' } });
  const cfg = await request(handler, '/api/config');
  const cookie = cfg.headers['set-cookie'].split(';')[0];
  assert.match(cfg.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  assert.equal(cfg.text.includes('secret-'), false);
  const payload = { email: 'person@example.test', turnstileToken: 'test' };
  assert.equal((await request(handler, '/api/code/request', { body: payload })).status, 401);
  assert.equal((await request(handler, '/api/code/request', { body: payload, cookie, origin: 'https://foreign.test' })).status, 403);
  assert.equal((await request(handler, '/api/code/request', { body: { ...payload, turnstileToken: 'bad' }, cookie })).status, 400);
  assert.equal(f.mails.length, 0);
  const sent = await request(handler, '/api/code/request', { body: payload, cookie });
  assert.equal(sent.status, 200);
  assert.deepEqual(Object.keys(sent.body).sort(), ['expiresAt', 'requestId', 'resendAt']);
  assert.equal(f.store.stock(), 3);
  const body = { requestId: sent.body.requestId, verificationCode: f.mails[0].code };
  assert.equal((await request(handler, '/api/claim', { body, cookie: 'dana_session=' + 'a'.repeat(64) })).status, 400);
  const first = await request(handler, '/api/claim', { body, cookie });
  const again = await request(handler, '/api/claim', { body, cookie });
  assert.equal(first.status, 200); assert.equal(first.body.recovered, false);
  assert.deepEqual(again.body.reward, first.body.reward); assert.equal(again.body.recovered, true);
  assert.equal(f.store.stock(), 2);
  const report = await request(handler, '/api/report');
  assert.equal(report.text.includes('person@example.test'), false);
  assert.equal(report.text.includes(first.body.reward.value), false);
});

test('invalid attempts persist, lock after five, and expired codes allocate nothing', async t => {
  const f = await fixture(t);
  const challenge = await f.issue();
  const incorrect = challenge.verificationCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.throws(() => f.service.claim({ ...challenge, verificationCode: incorrect }, 'session', 'ip'), { code: i === 4 ? 'attempts_exhausted' : 'invalid_code' });
  assert.throws(() => f.service.claim(challenge, 'session', 'ip'), { code: 'attempts_exhausted' });
  f.advance(61_000);
  const fresh = await f.issue();
  assert.throws(() => f.service.claim(challenge, 'session', 'ip'), { code: 'invalid_request' });
  f.advance(OTP_TTL);
  assert.throws(() => f.service.claim(fresh, 'session', 'ip'), { code: 'code_expired' });
  assert.equal(f.store.stock(), 3);
});

test('resend cooldown and hourly limits survive connections and provider failures do not allocate', async t => {
  const f = await fixture(t);
  await f.issue();
  await assert.rejects(f.issue(), { code: 'resend_wait' });
  f.advance(61_000); await f.issue(); f.advance(61_000); await f.issue(); f.advance(61_000);
  await assert.rejects(f.issue(), { code: 'rate_limited' });
  f.provider.send = async () => { throw fail('email_unavailable', 503); };
  await assert.rejects(f.issue('failed@example.test'), { code: 'email_unavailable' });
  assert.equal(f.store.stock(), 3);
  const other = await createClaimStore(f.directory, f.options);
  try { assert.throws(() => other.prepare('person@example.test', 'session'), { code: 'rate_limited' }); }
  finally { other.close(); }
});

test('cross-session cooldown responses keep pending, sent, claimed, and failed requests private', async t => {
  for (const status of ['pending', 'sent', 'claimed', 'failed']) {
    await t.test(status, async t => {
      const f = await fixture(t, 1);
      const challenge = f.store.prepare('person@example.test', 'original');
      if (status === 'sent' || status === 'claimed') f.store.sent(challenge.id);
      if (status === 'claimed') f.store.claim(challenge.id, challenge.code, 'original');
      if (status === 'failed') f.store.failed(challenge.id);
      const reply = await f.service.request({ email: 'person@example.test', turnstileToken: 'test' }, 'other-browser', 'ip');
      assert.deepEqual(Object.keys(reply).sort(), ['expiresAt', 'requestId', 'resendAt']);
      assert.notEqual(reply.requestId, challenge.id);
      assert.equal(reply.expiresAt, challenge.expiresAt);
      assert.equal(reply.resendAt, challenge.resendAt);
      assert.equal(f.mails.length, 0);
      assert.throws(() => f.service.claim({ requestId: reply.requestId, verificationCode: challenge.code }, 'other-browser', 'ip'), { code: 'invalid_code' });
      await assert.rejects(f.service.request({ email: 'person@example.test', turnstileToken: 'test' }, 'original', 'ip'), { code: 'resend_wait', status: 429 });
    });
  }
});

test('cross-session hourly suppression preserves email quotas without revealing other browsers', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) { await f.issue('person@example.test', 'original'); f.advance(61_000); }
  const reply = await f.service.request({ email: 'person@example.test', turnstileToken: 'test' }, 'other-browser', 'ip');
  assert.deepEqual(Object.keys(reply).sort(), ['expiresAt', 'requestId', 'resendAt']);
  assert.equal(f.mails.length, 3);
  await assert.rejects(f.issue('person@example.test', 'original'), { code: 'rate_limited', status: 429 });
  assert.throws(() => f.service.claim({ requestId: reply.requestId, verificationCode: f.mails.at(-1).code }, 'other-browser', 'ip'), { code: 'invalid_code' });
  f.advance(3_600_000);
  await f.issue('person@example.test', 'other-browser');
  assert.equal(f.mails.length, 4);
});

test('a browser that sent the most recent code cannot infer requests made by earlier browsers', async t => {
  const f = await fixture(t);
  for (const session of ['other-browser', 'other-browser', 'current']) { await f.issue('person@example.test', session); f.advance(61_000); }
  const reply = await f.service.request({ email: 'person@example.test', turnstileToken: 'test' }, 'current', 'ip');
  assert.deepEqual(Object.keys(reply).sort(), ['expiresAt', 'requestId', 'resendAt']);
  assert.equal(f.mails.length, 3);
});

test('suppressed and delivered challenges have the same incorrect-code, session, lockout, and expiry behavior', async t => {
  const f = await fixture(t);
  await f.issue('throttled@example.test', 'original');
  const suppressed = await f.service.request({ email: 'throttled@example.test', turnstileToken: 'test' }, 'current', 'ip');
  const delivered = await f.issue('fresh@example.test', 'current');
  const incorrect = delivered.verificationCode === '000000' ? '111111' : '000000';
  for (const requestId of [suppressed.requestId, delivered.requestId]) {
    assert.throws(() => f.service.claim({ requestId, verificationCode: incorrect }, 'wrong-session', 'ip'), { code: 'invalid_request' });
    for (let i = 0; i < 5; i++) {
      assert.throws(() => f.service.claim({ requestId, verificationCode: incorrect }, 'current', 'ip'), { code: i === 4 ? 'attempts_exhausted' : 'invalid_code' });
    }
    assert.throws(() => f.service.claim({ requestId, verificationCode: incorrect }, 'current', 'ip'), { code: 'attempts_exhausted' });
  }
  f.advance(OTP_TTL);
  for (const requestId of [suppressed.requestId, delivered.requestId]) {
    assert.throws(() => f.service.claim({ requestId, verificationCode: incorrect }, 'current', 'ip'), { code: 'code_expired' });
  }
  assert.equal(f.mails.length, 2);
  assert.equal(f.store.stock(), 3);
});

test('repeating requests cannot distinguish suppressed and delivered email through cooldown or hourly errors', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) { await f.issue('throttled@example.test', 'original'); f.advance(61_000); }
  const emails = ['throttled@example.test', 'fresh@example.test'];
  const first = [];
  for (const email of emails) first.push(await f.service.request({ email, turnstileToken: 'test' }, 'current', 'ip'));
  for (const email of emails) await assert.rejects(f.issue(email, 'current'), { code: 'resend_wait', status: 429 });
  for (let i = 0; i < 2; i++) {
    f.advance(61_000);
    for (const email of emails) await f.service.request({ email, turnstileToken: 'test' }, 'current', 'ip');
  }
  for (const email of emails) await assert.rejects(f.issue(email, 'current'), { code: 'rate_limited', status: 429 });
  for (const challenge of first) assert.throws(() => f.service.claim({ requestId: challenge.requestId, verificationCode: '000000' }, 'current', 'ip'), { code: 'invalid_request' });
  assert.equal(f.mails.length, 6);
  assert.equal(f.store.stock(), 3);
});

test('resends supersede earlier challenges consistently when switching between suppressed and delivered email', async t => {
  const f = await fixture(t);
  const original = await f.issue('person@example.test', 'original');
  const first = await f.service.request({ email: 'person@example.test', turnstileToken: 'test' }, 'current', 'ip');
  f.advance(61_000);
  const delivered = await f.issue('person@example.test', 'current');
  assert.throws(() => f.service.claim({ requestId: first.requestId, verificationCode: '000000' }, 'current', 'ip'), { code: 'invalid_request' });
  f.advance(61_000);
  await f.issue('person@example.test', 'third-browser');
  const last = await f.service.request({ email: 'person@example.test', turnstileToken: 'test' }, 'current', 'ip');
  assert.throws(() => f.service.claim(delivered, 'current', 'ip'), { code: 'invalid_request' });
  assert.throws(() => f.service.claim({ requestId: last.requestId, verificationCode: delivered.verificationCode }, 'current', 'ip'), { code: 'invalid_code' });
  assert.equal(f.store.stock(), 3);
  assert.equal(f.service.claim(original, 'original', 'ip').recovered, false);
  assert.equal(f.mails.length, 3);
});

test('two connections cannot allocate the same last reward and same email recovers after restart', async t => {
  const f = await fixture(t, 1);
  const a = await f.issue('first@example.test', 'a');
  const b = await f.issue('second@example.test', 'b');
  const other = await createClaimStore(f.directory, f.options);
  try {
    const first = f.service.claim(a, 'a', 'ip');
    assert.throws(() => other.claim(b.requestId, b.verificationCode, 'b'), { code: 'sold_out' });
    f.advance(61_000);
    const recover = await f.issue(' FIRST@example.test ', 'new-session');
    const again = other.claim(recover.requestId, recover.verificationCode, 'new-session');
    assert.deepEqual(again.reward, first.reward); assert.equal(again.recovered, true);
    assert.equal(other.stock(), 0);
    const third = await f.issue('third@example.test');
    assert.throws(() => f.service.claim(third, 'session', 'ip'), { code: 'sold_out' });
  } finally { other.close(); }
});

test('requesting a code after stock runs out does not reveal previous participation', async t => {
  const f = await fixture(t, 1);
  const first = await f.issue('claimed@example.test', 'original');
  f.service.claim(first, 'original', 'ip');
  f.advance(61_000);
  const handler = createHandler({ claims: f.service, env: { APP_MODE: 'local' } });
  const cfg = await request(handler, '/api/config');
  const cookie = cfg.headers['set-cookie'].split(';')[0];
  const known = await request(handler, '/api/code/request', { cookie, body: { email: 'claimed@example.test', turnstileToken: 'test' } });
  const unknown = await request(handler, '/api/code/request', { cookie, body: { email: 'new@example.test', turnstileToken: 'test' } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(Object.keys(known.body).sort(), Object.keys(unknown.body).sort());
  assert.equal(known.body.expiresAt, unknown.body.expiresAt);
  assert.equal(known.body.resendAt, unknown.body.resendAt);
  const unavailable = await request(handler, '/api/claim', { cookie, body: { requestId: unknown.body.requestId, verificationCode: f.mails.at(-1).code } });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.body.error, 'sold_out');
  const recovered = await request(handler, '/api/claim', { cookie, body: { requestId: known.body.requestId, verificationCode: f.mails.at(-2).code } });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.recovered, true);
  assert.equal(f.store.stock(), 0);
});

test('inventory validates all entries before import and keeps private state out of public data', async t => {
  const f = await fixture(t, 0);
  assert.deepEqual(f.store.import(parseInventory('ABC123\nABC123\nhttps://link.dana.id/kaget?c=fixture')), { added: 2, duplicates: 1 });
  for (const value of ['javascript:alert(1)', 'https://evil.example/x', 'https://link.dana.id.evil.test/x', 'https://user:pass@link.dana.id/x', '["ABC", 12]', 'https://dana.id/<random_code>', 'https://dana.id/%3Crandom_code%3E', 'https://dana.id/', 'https://dana.id.evil.test/code']) assert.throws(() => parseInventory(value));
  const link = 'https://dana.id/test-inventory-entry';
  assert.deepEqual(parseInventory(link), [{ value: link, kind: 'link' }]);
  assert.equal(isRewardLink(link), true);
  assert.equal(isRewardLink('https://dana.id.evil.test/code'), false);
  assert.equal(normalizeEmail(' Test@Example.test '), 'test@example.test');
  assert.throws(() => normalizeEmail('test@example.test\nBcc:other@example.test'));
  const c = await f.issue();
  const db = Buffer.concat([await readFile(join(f.directory, 'dana-local.sqlite')), await readFile(join(f.directory, 'dana-local.sqlite-wal'))]).toString();
  assert.equal(db.includes('person@example.test'), false);
  assert.equal(db.includes(c.verificationCode), false);
});

test('live mode refuses dummy CAPTCHA, missing credentials and non-HTTPS origins', () => {
  assert.throws(() => claimConfig({ APP_MODE: 'live' }), { code: 'live_configuration_missing' });
  const config = claimConfig(liveEnv);
  assert.equal(config.local, false);
  assert.equal(config.kirimDomain, liveEnv.KIRIM_EMAIL_DOMAIN);
  assert.equal(config.kirimUsername, liveEnv.KIRIM_EMAIL_USERNAME);
  assert.equal(config.kirimPassword, liveEnv.KIRIM_EMAIL_PASSWORD);
  for (const key of ['KIRIM_EMAIL_DOMAIN', 'KIRIM_EMAIL_USERNAME', 'KIRIM_EMAIL_PASSWORD', 'EMAIL_FROM', 'CLAIM_SECRET']) {
    assert.throws(() => claimConfig({ ...liveEnv, [key]: '' }), { code: 'live_configuration_missing', status: 503 }, key);
  }
  assert.throws(() => claimConfig({ ...liveEnv, PUBLIC_ORIGIN: 'http://claim.example.test' }));
  assert.throws(() => claimConfig({ ...liveEnv, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' }));
});

test('live public configuration exposes the Turnstile site key but keeps email settings and credentials private', async () => {
  const response = await request(createHandler({ env: liveEnv }), '/api/config', { host: 'claim.example.test' });
  assert.equal(response.status, 200);
  assert.equal(response.body.localMode, false);
  assert.equal(response.body.turnstileSiteKey, liveEnv.TURNSTILE_SITE_KEY);
  for (const key of ['KIRIM_EMAIL_DOMAIN', 'KIRIM_EMAIL_USERNAME', 'KIRIM_EMAIL_PASSWORD', 'EMAIL_FROM', 'TURNSTILE_SECRET_KEY', 'CLAIM_SECRET']) {
    assert.equal(response.text.includes(liveEnv[key]), false, key);
  }
});

test('Turnstile is checked server-side including live action and hostname', async () => {
  const config = claimConfig(liveEnv);
  let answer = { success: true, hostname: config.hostname, action: 'request_code' };
  const calls = [];
  const provider = delivery(config, { fetcher: async (url, options) => { calls.push({ url, options }); return Response.json(answer); } });
  await provider.verify('test-token');
  assert.equal(JSON.parse(calls[0].options.body).secret, liveEnv.TURNSTILE_SECRET_KEY);
  assert.equal(calls[0].options.redirect, 'error');
  answer = { ...answer, hostname: 'evil.test' }; await assert.rejects(provider.verify('test-token'), { code: 'captcha_invalid' });
  answer = { ...answer, hostname: config.hostname, action: 'other' }; await assert.rejects(provider.verify('test-token'), { code: 'captcha_invalid' });
  answer = { success: false }; await assert.rejects(provider.verify('used-token'), { code: 'captcha_invalid' });
});

test('Turnstile malformed, oversized, and unreadable replies fail closed with redacted errors', async t => {
  const config = claimConfig(liveEnv);
  const replies = [
    ['null', () => Response.json(null)],
    ['array', () => Response.json([{ success: true }])],
    ['string success', () => Response.json({ success: 'false', hostname: config.hostname, action: 'request_code' })],
    ['missing success', () => Response.json({ hostname: config.hostname, action: 'request_code' })],
    ['missing hostname', () => Response.json({ success: true, action: 'request_code' })],
    ['missing action', () => Response.json({ success: true, hostname: config.hostname })],
    ['invalid JSON', () => new Response('private provider detail')],
    ['HTTP error', () => new Response('private provider detail', { status: 502 })],
    ['oversized JSON', () => Response.json({ success: true, hostname: config.hostname, action: 'request_code', extra: 'x'.repeat(16_384) })],
    ['unreadable body', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private stream detail')); } }))],
    ['network', () => { throw new Error('private connection detail'); }],
  ];
  for (const [name, response] of replies) {
    await t.test(name, async () => {
      const provider = delivery(config, { fetcher: async () => response() });
      await assert.rejects(provider.verify('test-token'), { message: 'captcha_unavailable', code: 'captcha_unavailable', status: 503 });
    });
  }
});

test('Turnstile cancels the response stream when its JSON exceeds the size limit', async () => {
  let canceled = false;
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(8192)); },
    cancel() { canceled = true; },
  });
  const provider = delivery(claimConfig(liveEnv), { fetcher: async () => new Response(stream) });
  await assert.rejects(provider.verify('test-token'), { code: 'captcha_unavailable', status: 503 });
  assert.equal(canceled, true);
  assert.ok(pulls <= 4);
});

test('live email form-encodes Kirim.Email requests with Basic authentication and a bounded timeout', async t => {
  const config = claimConfig({ ...liveEnv, EMAIL_FROM: 'Dana & Kaget <claim@example.test>', KIRIM_EMAIL_USERNAME: 'key_demo+with/slash', KIRIM_EMAIL_PASSWORD: 'secret:p+ss/=&?' });
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const calls = [];
  const provider = delivery(config, { fetcher: async (url, options) => { calls.push({ url, options }); return { ok: true }; } });
  await provider.send({ email: 'first+offer&test@example.test', code: '012345', id: 'test-id' });
  assert.equal(calls.length, 1);
  const mail = calls[0];
  const headers = new Headers(mail.options.headers);
  assert.equal(mail.url, 'https://smtp-app.kirim.email/api/v4/transactional/message');
  assert.equal(mail.options.method, 'POST');
  assert.equal(mail.options.redirect, 'error');
  assert.equal(mail.options.signal, controller.signal);
  assert.deepEqual(timeout.mock.calls.map(call => call.arguments), [[15_000]]);
  assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(headers.get('domain'), liveEnv.KIRIM_EMAIL_DOMAIN);
  assert.equal(headers.get('authorization'), `Basic ${Buffer.from(`${config.kirimUsername}:${config.kirimPassword}`).toString('base64')}`);
  assert.equal(headers.has('idempotency-key'), false);
  const payload = new URLSearchParams(mail.options.body);
  assert.deepEqual([...payload.keys()].sort(), ['from', 'subject', 'text', 'to']);
  assert.equal(payload.get('from'), config.from);
  assert.equal(payload.get('to'), 'first+offer&test@example.test');
  assert.equal(payload.get('subject'), 'Kode verifikasi Dana Kaget');
  assert.match(payload.get('text'), /012345\n\nBerlaku selama 10 menit/);
});

test('Kirim.Email HTTP and transport failures return only a redacted email_unavailable error', async t => {
  const config = claimConfig(liveEnv);
  const failures = [
    ...[401, 429, 500].map(status => [String(status), async () => ({ ok: false, status, text: async () => 'private provider response' })]),
    ['network', async () => { throw new Error(`private provider detail ${config.kirimPassword}`); }],
    ['timeout', async () => { throw new DOMException('private timeout detail', 'TimeoutError'); }],
    ['redirect', async () => { throw new TypeError('private redirect detail'); }],
  ];
  for (const [name, fetcher] of failures) {
    await t.test(name, async () => {
      const provider = delivery(config, { fetcher });
      await assert.rejects(provider.send({ email: 'person@example.test', code: '012345', id: 'test-id' }), error => {
        assert.equal(error.code, 'email_unavailable');
        assert.equal(error.status, 503);
        assert.equal(error.message, 'email_unavailable');
        assert.equal(error.cause, undefined);
        assert.equal(JSON.stringify(error).includes('private'), false);
        return true;
      });
    });
  }
});

test('simultaneous workers claim the final reward exactly once', async t => {
  const f = await fixture(t, 1);
  const a = await f.issue('a@example.test', 'a');
  const b = await f.issue('b@example.test', 'b');
  const workers = [a, b].map((data, index) => new Worker(new URL('./claim-worker.mjs', import.meta.url), { workerData: { ...data, directory: f.directory, session: index ? 'b' : 'a' } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(worker => once(worker, 'message')));
  const responses = workers.map(worker => once(worker, 'message'));
  workers.forEach(worker => worker.postMessage('claim'));
  const results = (await Promise.all(responses)).map(([result]) => result);
  assert.equal(results.filter(r => r.success).length, 1);
  assert.equal(results.find(r => !r.success).error, 'sold_out');
  assert.equal(f.store.stock(), 0);
});

test('private stdin import is idempotent and outputs counts without codes', async t => {
  const f = await fixture(t, 0);
  const options = { input: 'PRIVATE-TEST-CODE\nPRIVATE-TEST-CODE\n', encoding: 'utf8', env: { ...process.env, APP_MODE: 'local', DATA_DIR: f.directory, CLAIM_SECRET: '' } };
  const first = execFileSync(process.execPath, ['scripts/import-codes.mjs', '-'], options);
  assert.match(first, /Imported 1; duplicates skipped 1/);
  assert.equal(first.includes('PRIVATE-TEST-CODE'), false);
  assert.match(execFileSync(process.execPath, ['scripts/import-codes.mjs', '-'], options), /Imported 0; duplicates skipped 2/);
  assert.equal(f.store.stock(), 1);
});

test('local email uses Mailpit without sending configured Kirim.Email credentials', async () => {
  const config = claimConfig({ ...liveEnv, APP_MODE: 'local' });
  const calls = [];
  const provider = delivery(config, { fetcher: async (url, options) => { calls.push({ url, options }); return { ok: true }; } });
  await provider.send({ email: 'test@example.test', code: '123456', id: 'local-test' });
  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.url, 'http://127.0.0.1:8025/api/v1/send');
  const payload = JSON.parse(sent.options.body);
  assert.equal(payload.From.Email, 'noreply@example.test');
  assert.equal(payload.To[0].Email, 'test@example.test');
  assert.match(payload.Text, /123456/);
  const headers = new Headers(sent.options.headers);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.has('authorization'), false);
  assert.equal(headers.has('domain'), false);
  assert.equal(sent.options.body.includes(liveEnv.KIRIM_EMAIL_PASSWORD), false);
});

test('Mailpit failures never fall back to Kirim.Email', async () => {
  const config = claimConfig({ ...liveEnv, APP_MODE: 'local' });
  const calls = [];
  const provider = delivery(config, { fetcher: async url => { calls.push(url); return { ok: false }; } });
  await assert.rejects(provider.send({ email: 'test@example.test', code: '123456', id: 'local-test' }), { code: 'email_unavailable', status: 503 });
  assert.deepEqual(calls, ['http://127.0.0.1:8025/api/v1/send']);
});
