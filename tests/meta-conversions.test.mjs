import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { metaConfig, createMetaConversions } from '../lib/meta-conversions.mjs';

const env = { META_PIXEL_ID: '123456789012345', META_ACCESS_TOKEN: 'synthetic-private-token' };
const origin = 'https://claim.example.test';
const identity = { ip: '192.0.2.10', userAgent: 'Synthetic browser/1.0' };
const event = (extra = {}) => ({ name: 'PageView', id: randomUUID(), at: Date.now(), ...extra });
const accepted = () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 });

test('Meta configuration requires the private token and Pixel ID together and redacts invalid values', () => {
  assert.equal(metaConfig({}, origin).enabled, false);
  assert.deepEqual(metaConfig(env, origin), {
    enabled: true, pixelId: env.META_PIXEL_ID, accessToken: env.META_ACCESS_TOKEN,
    apiVersion: 'v26.0', testEventCode: '', sourceUrl: origin + '/dana-kaget',
  });
  for (const change of [
    { META_PIXEL_ID: '' }, { META_ACCESS_TOKEN: '' }, { META_PIXEL_ID: '123/../../private' },
    { META_PIXEL_ID: '1'.repeat(33) }, { META_ACCESS_TOKEN: 'token\nAuthorization: private' },
    { META_ACCESS_TOKEN: 'x'.repeat(8193) }, { META_API_VERSION: 'https://attacker.test' },
    { META_TEST_EVENT_CODE: 'test?token=private' }, { META_TEST_EVENT_CODE: 'x'.repeat(101) },
  ]) {
    assert.throws(() => metaConfig({ ...env, ...change }, origin), error => {
      assert.equal(error.code, 'invalid_meta_configuration');
      assert.equal(error.message, 'invalid_meta_configuration');
      assert.equal(error.status, 503);
      return true;
    });
  }
  for (const value of ['https://user:password@claim.example.test', origin + '?secret=private', origin + '/path', 'file:///private', undefined]) {
    assert.throws(() => metaConfig(env, value), { code: 'invalid_meta_configuration' });
  }
});

test('CAPI sends only the allowed event and request identity with private Bearer auth', async () => {
  const calls = [];
  const sender = createMetaConversions(metaConfig({ ...env, META_TEST_EVENT_CODE: 'TEST12345' }, origin), {
    fetcher: async (...args) => { calls.push(args); return accepted(); },
  });
  const input = event({ name: 'CompleteRegistration', email: 'private@example.test', value: 'https://link.dana.id/private', properties: { code: '123456' } });
  assert.equal(sender.send(input, { ...identity, referrer: 'https://private.test', cookie: 'secret', session: 'private' }), true);
  await sender.flush();
  const [url, options] = calls[0];
  assert.equal(url, `https://graph.facebook.com/v26.0/${env.META_PIXEL_ID}/events`);
  assert.equal(url.includes(env.META_ACCESS_TOKEN), false);
  assert.equal(options.headers.authorization, `Bearer ${env.META_ACCESS_TOKEN}`);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), {
    data: [{ event_name: input.name, event_time: Math.floor(input.at / 1000), event_id: input.id,
      action_source: 'website', event_source_url: origin + '/dana-kaget', user_data: { client_ip_address: identity.ip, client_user_agent: identity.userAgent } }],
    test_event_code: 'TEST12345',
  });
  assert.deepEqual(sender.snapshot(), { enabled: true, attempted: 1, accepted: 1, failed: 0, dropped: 0, duplicates: 0, inflight: 0, retainedIds: 1 });
});

test('disabled integration never uses the transport', async () => {
  const sender = createMetaConversions(metaConfig({}, origin), { fetcher: () => { assert.fail('Unexpected Meta request'); } });
  assert.equal(sender.send(event(), identity), false);
  await sender.flush();
  assert.equal(sender.snapshot().attempted, 0);
});

test('arbitrary events, stale timestamps and invalid request identity never leave the process', async () => {
  const sender = createMetaConversions(metaConfig(env, origin), { fetcher: () => { assert.fail('Unexpected Meta request'); } });
  for (const input of [null, event({ name: 'Purchase' }), event({ name: 'dk_claim_success' }), event({ id: 'private' }), event({ at: Date.now() - 8 * 86400_000 }), event({ at: Date.now() + 120_000 })]) {
    assert.equal(sender.send(input, identity), false);
  }
  for (const context of [null, {}, { ...identity, ip: 'unknown' }, { ...identity, ip: '192.0.2.10, 198.51.100.1' }, { ...identity, userAgent: '' }, { ...identity, userAgent: 'test\r\nprivate' }]) {
    assert.equal(sender.send(event(), context), false);
  }
  await sender.flush();
  assert.equal(sender.snapshot().attempted, 0);
});

test('User-Agent is bounded and no test event code is included unless configured', async () => {
  let body;
  const sender = createMetaConversions(metaConfig(env, origin), { fetcher: async (_url, options) => { body = JSON.parse(options.body); return accepted(); } });
  sender.send(event(), { ip: '2001:db8::1', userAgent: 'a'.repeat(1000) });
  await sender.flush();
  assert.equal(body.data[0].user_data.client_user_agent.length, 512);
  assert.equal(body.data[0].user_data.client_ip_address, '2001:db8::1');
  assert.equal(Object.hasOwn(body, 'test_event_code'), false);
});

test('duplicate event names and IDs are suppressed even after failed requests', async () => {
  let calls = 0;
  const sender = createMetaConversions(metaConfig(env, origin), { fetcher: async () => { calls++; throw new Error('private response token'); } });
  const input = event();
  assert.equal(sender.send(input, identity), true);
  assert.equal(sender.send({ ...input, id: input.id.toUpperCase() }, identity), false);
  await sender.flush();
  assert.equal(sender.send(input, identity), false);
  assert.equal(sender.send({ ...input, name: 'CompleteRegistration' }, identity), true);
  await sender.flush();
  assert.equal(calls, 2);
  assert.equal(sender.snapshot().failed, 2);
  assert.equal(sender.snapshot().duplicates, 2);
  assert.equal(JSON.stringify(sender.snapshot()).includes('private'), false);
});

test('deduplication memory fails closed at capacity and expires after 48 hours', async () => {
  let now = Date.now();
  const sender = createMetaConversions(metaConfig(env, origin), { clock: () => now, maxSeen: 1, fetcher: async () => accepted() });
  assert.equal(sender.send(event({ at: now }), identity), true);
  await sender.flush();
  assert.equal(sender.send(event({ at: now }), identity), false);
  now += 48 * 60 * 60 * 1000;
  assert.equal(sender.send(event({ at: now }), identity), true);
  await sender.flush();
  assert.equal(sender.snapshot().retainedIds, 1);
});

test('concurrency is bounded and overflow is dropped without a delayed retry queue', async () => {
  let release;
  let calls = 0;
  const sender = createMetaConversions(metaConfig(env, origin), {
    maxInflight: 1, fetcher: async () => { calls++; await new Promise(resolve => { release = resolve; }); return accepted(); },
  });
  assert.equal(sender.send(event(), identity), true);
  assert.equal(sender.send(event(), identity), false);
  assert.equal(sender.snapshot().inflight, 1);
  release();
  await sender.flush();
  assert.equal(calls, 1);
  assert.equal(sender.snapshot().dropped, 1);
  assert.equal(sender.snapshot().inflight, 0);
});

test('upstream failures, malformed bodies and mismatched acknowledgement remain private', async () => {
  for (const response of [
    new Response('private token', { status: 500 }), new Response('private redirect', { status: 302 }),
    new Response('not json'), new Response(JSON.stringify({ error: { message: 'private token' } })),
    new Response(JSON.stringify({ events_received: 0 })), new Response(JSON.stringify({ events_received: '1' })),
    new Response(JSON.stringify([{ events_received: 1 }])), new Response('x'.repeat(16385)),
  ]) {
    const sender = createMetaConversions(metaConfig(env, origin), { fetcher: async () => response });
    assert.equal(sender.send(event(), identity), true);
    await sender.flush();
    assert.equal(sender.snapshot().failed, 1);
    assert.equal(sender.snapshot().accepted, 0);
  }
});

test('upstream stream is cancelled once the response exceeds its size limit', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16_385)); },
    cancel() { cancelled = true; },
  });
  const sender = createMetaConversions(metaConfig(env, origin), { fetcher: async () => new Response(body) });
  sender.send(event(), identity);
  await sender.flush();
  assert.equal(cancelled, true);
  assert.equal(sender.snapshot().failed, 1);
});

test('outbound requests time out without rejecting the caller or exposing errors', async () => {
  const sender = createMetaConversions(metaConfig(env, origin), {
    timeoutMs: 10,
    fetcher: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private timeout details')), { once: true })),
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal(sender.send(event(), identity), true);
    await sender.flush();
    assert.equal(sender.snapshot().failed, 1);
    assert.equal(sender.snapshot().inflight, 0);
  } finally { clearTimeout(keepAlive); }
});
