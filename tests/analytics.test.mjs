import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsTracker, CONSENT_KEY } from '../public/analytics/tracker.js';
import { sanitizeProperties } from '../public/analytics/events.js';
import { googleProvider, grovsProvider } from '../public/analytics/providers.js';
import { localProvider } from '../public/analytics/collector.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function fixture(overrides = {}) {
  const sent = [];
  let initialized = 0;
  let stopped = 0;
  let counter = 0;
  const data = new Map();
  const adapter = {
    id: 'test', configured: true,
    initialize: async () => { initialized++; return true; },
    send: event => sent.push(event),
    stop: () => { stopped++; },
    ...overrides,
  };
  const tracker = new AnalyticsTracker({
    providers: [adapter], clock: () => 1000, uuid: () => `test-id-${++counter}`,
    storage: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) },
  });
  return { tracker, sent, data, get initialized() { return initialized; }, get stopped() { return stopped; } };
}

test('PII, free text, URLs, nested payloads and unexpected enum values are excluded', () => {
  const safe = sanitizeProperties({
    field_id: 'email', step_id: 'email', step_number: 1, state: 'filled',
    nik: '0000000000000000', phone: '0000000000', email: 'fixture@example.invalid',
    name: 'SYNTHETIC TEST USER', value: 'private fixture',
    target_id: 'fixture@example.invalid', option_id: 'private fixture',
    href: 'https://example.invalid/?nik=0000000000000000',
    attributes: { name: 'private fixture' }, duration_ms: Infinity,
    input_count: -1, scroll_percent: '100',
  });
  assert.deepEqual(safe, { field_id: 'email', step_id: 'email', state: 'filled', step_number: 1 });
});

test('no SDK initialization or remote events before consent, and no retroactive replay', async () => {
  const f = fixture();
  await f.tracker.start();
  f.tracker.track('dk_page_view');
  f.tracker.track('dk_field_input', { field_id: 'email', value: 'private fixture' });
  assert.equal(f.initialized, 0);
  assert.equal(f.sent.length, 0);
  await f.tracker.setConsent('granted');
  assert.equal(f.initialized, 1);
  assert.deepEqual(f.sent.map(e => e.name), ['dk_consent_update']);
  assert.equal(f.tracker.snapshot().records[0].delivery.test, 'local_only');
});

test('events arriving during SDK load are handed off exactly once', async () => {
  const gate = deferred();
  const f = fixture({ initialize: () => gate.promise });
  const enabling = f.tracker.setConsent('granted');
  f.tracker.track('dk_form_start');
  f.tracker.track('dk_step_submit');
  const again = f.tracker.setConsent('granted');
  gate.resolve(true);
  await Promise.all([enabling, again]);
  assert.deepEqual(f.sent.map(e => e.name), ['dk_consent_update', 'dk_form_start', 'dk_step_submit']);
  assert.equal(new Set(f.sent.map(e => e.id)).size, 3);
});

test('withdrawal during initialization drops queued events and cannot re-enable delivery', async () => {
  const gate = deferred();
  const f = fixture({ initialize: () => gate.promise });
  const enabling = f.tracker.setConsent('granted');
  await Promise.resolve();
  f.tracker.track('dk_field_change', { field_id: 'email' });
  await f.tracker.setConsent('denied');
  gate.resolve(true);
  await enabling;
  f.tracker.track('dk_step_submit');
  assert.equal(f.sent.length, 0);
  assert.equal(f.stopped, 1);
  assert.equal(f.tracker.snapshot().providers[0].status, 'disabled');
  assert.equal(f.tracker.snapshot().records[1].delivery.test, 'discarded');
});

test('regrant creates a fresh provider initialization and never replays denied events', async () => {
  const first = deferred();
  let calls = 0;
  const f = fixture({ initialize: () => ++calls === 1 ? first.promise : Promise.resolve(true) });
  const initial = f.tracker.setConsent('granted');
  await Promise.resolve();
  await f.tracker.setConsent('denied');
  f.tracker.track('dk_form_start');
  const resumed = f.tracker.setConsent('granted');
  first.resolve(true);
  await Promise.all([initial, resumed]);
  assert.equal(calls, 2);
  assert.deepEqual(f.sent.map(e => e.name), ['dk_consent_update']);
});

test('a broken provider or diagnostic subscriber does not interrupt the form', async () => {
  const f = fixture({ send: () => { throw new Error('network unavailable'); } });
  await f.tracker.setConsent('granted');
  f.tracker.subscribe(() => {});
  assert.doesNotThrow(() => f.tracker.track('dk_step_submit'));
  assert.equal(f.tracker.snapshot().providers[0].status, 'error');
});

test('unknown event names are rejected and record storage is bounded', () => {
  const tracker = new AnalyticsTracker({ uuid: () => 'test', limit: 3 });
  assert.equal(tracker.track('private fixture', { value: 'private fixture' }), null);
  for (let i = 0; i < 10; i++) tracker.track('dk_click');
  assert.equal(tracker.snapshot().records.length, 3);
});

test('storage failures and expired consent default to pending', () => {
  const blocked = new AnalyticsTracker({ storage: { getItem() { throw new Error(); } }, uuid: () => 'test' });
  assert.equal(blocked.consent, 'pending');
  const expired = new AnalyticsTracker({
    storage: { getItem: () => JSON.stringify({ state: 'granted', at: 1 }) },
    clock: () => 200 * 24 * 60 * 60 * 1000, uuid: () => 'test',
  });
  assert.equal(expired.consent, 'pending');
});

test('withdrawal in another tab stops delivery and discards the pending local retry', async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let requests = 0;
  const provider = localProvider({
    storage, schedule: () => 1, cancel() {},
    fetcher: async () => { requests++; throw new Error('offline'); },
    beacon: () => { requests++; return true; },
  });
  const first = new AnalyticsTracker({ storage });
  await first.setConsent('granted');
  const second = new AnalyticsTracker({ storage, providers: [provider] });
  await second.start();
  second.track('dk_page_view');
  await second.flush();
  assert.equal(requests, 1);
  assert.equal(provider.snapshot().pending, 1);
  await first.setConsent('denied');
  await provider.flush({ urgent: true });
  second.track('dk_heartbeat');
  await second.flush();
  assert.equal(second.consent, 'denied');
  assert.equal(provider.snapshot().pending, 0);
  assert.equal(requests, 1);
});

test('another tab can revoke consent while a provider is initializing', async () => {
  const gate = deferred();
  const f = fixture({ initialize: () => gate.promise });
  const loading = f.tracker.setConsent('granted');
  await Promise.resolve();
  f.tracker.track('dk_page_view');
  f.data.set(CONSENT_KEY, JSON.stringify({ state: 'denied', at: 1000 }));
  gate.resolve(true);
  await loading;
  assert.equal(f.tracker.consent, 'denied');
  assert.equal(f.sent.length, 0);
  assert.equal(f.stopped, 1);
});

test('cleared, malformed or expired shared consent fails closed in an existing tab', async () => {
  for (const value of [undefined, '{invalid', JSON.stringify({ state: 'granted', at: -180 * 24 * 60 * 60 * 1000 })]) {
    const f = fixture();
    await f.tracker.setConsent('granted');
    f.sent.length = 0;
    f.data.set(CONSENT_KEY, value);
    f.tracker.track('dk_heartbeat');
    assert.equal(f.tracker.consent, 'pending');
    assert.equal(f.sent.length, 0);
    assert.equal(f.stopped, 1);
  }
});

test('only consent is stored, never the form or event payloads', async () => {
  const f = fixture();
  await f.tracker.setConsent('granted');
  f.tracker.track('dk_field_change', { field_id: 'email', value: 'private fixture' });
  assert.deepEqual([...f.data.keys()], [CONSENT_KEY]);
  assert.equal([...f.data.values()].join('').includes('private fixture'), false);
});

test('GA4 excludes current query/hash/referrer and disables automatic page views', async () => {
  const window = { location: { origin: 'https://demo.example', hostname: 'demo.example', href: 'https://demo.example/?nik=private' } };
  const document = { cookie: '' };
  const adapter = googleProvider({ ga4MeasurementId: 'G-TESTONLY' }, { window, document, loadScript: async () => {} });
  assert.equal(await adapter.initialize(() => true), true);
  adapter.send({ name: 'dk_field_change', id: 'test', properties: { field_id: 'email' } });
  const commands = window.dataLayer.map(args => [...args]);
  const config = commands.find(args => args[0] === 'config')[2];
  assert.equal(config.send_page_view, false);
  assert.equal(config.allow_google_signals, false);
  assert.equal(config.allow_ad_personalization_signals, false);
  const consent = commands.filter(args => args[0] === 'consent').reduce((state, args) => ({ ...state, ...args[2] }), {});
  assert.deepEqual(consent, {
    analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
  });
  assert.equal(config.page_location, 'https://demo.example/dana-kaget');
  assert.equal(config.page_referrer, '');
  assert.equal(JSON.stringify(commands).includes('private'), false);
  adapter.stop();
  assert.equal(window['ga-disable-G-TESTONLY'], true);
});

test('Grovs adapter uses the real v2 call contract with consent and explicit screen tracking', async () => {
  const calls = [];
  const sdk = {
    configure: async config => { calls.push(['configure', config]); return false; },
    grantConsent: async () => { calls.push(['grant']); return true; },
    track: (...args) => calls.push(['track', ...args]),
    trackScreenView: (...args) => calls.push(['screen', ...args]),
    reset: () => calls.push(['reset']), flush: async () => calls.push(['flush']),
  };
  const adapter = grovsProvider({ grovsApiKey: 'test-fixture' }, { loadSDK: async () => ({ default: sdk }) });
  assert.equal(await adapter.initialize(() => true), true);
  adapter.send({ name: 'dk_step_view', id: 'test', properties: { step_id: 'profile' } });
  await adapter.flush();
  adapter.stop();
  assert.equal(calls[0][1].requireConsent, true);
  assert.equal(calls[0][1].autoTrackScreenViews, false);
  assert.equal(calls[0][1].captureDeepLinks, false);
  assert.deepEqual(calls.map(c => c[0]), ['configure', 'grant', 'screen', 'track', 'flush', 'reset']);
});

test('vendored official SDK exposes v2 tracking and consent methods without initializing', async () => {
  const { default: sdk } = await import('../public/vendor/grovs/grovs.js');
  for (const method of ['configure', 'track', 'trackScreenView', 'grantConsent', 'reset', 'flush']) {
    assert.equal(typeof sdk[method], 'function', method);
  }
  assert.equal(sdk.isAuthenticated(), false);
});

test('patched Grovs SDK excludes URL and persisted attribution from actual outgoing payloads', async t => {
  const descriptors = new Map(['window', 'document', 'localStorage', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = new Map([
    ['Grovs_path:test_fixture-only', 'stored-private@example.invalid'],
    ['grovs_events:test_fixture-only', JSON.stringify([{
      id: crypto.randomUUID(), sessionId: crypto.randomUUID(), createdAt: Date.now(),
      eventName: 'dk_queued_fixture', path: 'queued-private@example.invalid',
    }])],
  ]);
  const location = new URL('https://dana.example/dana-kaget?Grovs=url-private%40example.invalid');
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), key: i => [...values.keys()][i], get length() { return values.size; } };
  globalThis.window = { location, addEventListener() {}, removeEventListener() {}, screen: { width: 100, height: 100 } };
  globalThis.document = { cookie: '', location, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: () => ({ getContext: () => null }) };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ path: new URL(url).pathname, body: options.body ? JSON.parse(options.body) : null });
    const body = url.endsWith('/authenticate') ? { linksquared: 'synthetic-fixture' }
      : url.endsWith('/notifications_to_display_automatically') ? { notifications: [] } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: new Headers() };
  };
  const adapter = grovsProvider({ grovsApiKey: 'fixture-only' });
  t.after(() => {
    adapter.stop();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  assert.equal(await adapter.initialize(() => true), true);
  adapter.send({ name: 'dk_step_view', id: crypto.randomUUID(), properties: { step_id: 'email' } });
  await adapter.flush();
  assert.equal(requests.some(request => request.path.endsWith('/data_for_device')), true);
  assert.equal(requests.some(request => request.path.endsWith('/data_for_device_and_path')), false);
  assert.equal(JSON.stringify(requests).includes('-private@example.invalid'), false);
  const events = requests.flatMap(request => request.body?.events || []);
  assert.equal(events.some(event => event.event_name === 'dk_queued_fixture'), true);
  assert.equal(events.some(event => Object.hasOwn(event, 'path')), false);
  assert.equal(location.search, '?Grovs=url-private%40example.invalid');
  for (const query of ['?linksquared=url-private%40example.invalid', '']) {
    adapter.stop();
    requests.length = 0;
    values.set('Grovs_path:test_fixture-only', 'stored-private@example.invalid');
    window.location = new URL(`https://dana.example/dana-kaget${query}`);
    document.location = window.location;
    assert.equal(await adapter.initialize(() => true), true);
    adapter.send({ name: 'dk_page_view', id: crypto.randomUUID(), properties: { step_id: 'email' } });
    await adapter.flush();
    assert.equal(requests.some(request => request.path.endsWith('/data_for_device_and_path')), false);
    assert.equal(JSON.stringify(requests).includes('-private@example.invalid'), false);
    assert.equal(window.location.search, query);
  }
});

test('vendored Grovs bundle matches the reviewed privacy patch fingerprint', async () => {
  const root = new URL('../public/vendor/grovs/', import.meta.url);
  const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
  const bundle = await readFile(new URL('grovs.js', root));
  assert.equal(createHash('sha256').update(bundle).digest('hex'), provenance.sha256);
});
