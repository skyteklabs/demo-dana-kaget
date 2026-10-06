import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalyticsTracker } from '../public/analytics/tracker.js';
import { localProvider } from '../public/analytics/collector.js';
import { CONSENT_KEY, CONSENT_VERSION, QUEUE_KEY, claimAnalyticsConsent } from '../public/analytics/consent.js';

function memory(entries = []) {
  const values = new Map(entries);
  return {
    values, getItem: key => values.get(key), setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

function collectorFixture({ storage = memory(), consentStorage = memory(), metaEnabled = true } = {}) {
  const requests = [];
  const beacons = [];
  const provider = localProvider({
    storage, consentStorage, metaEnabled, schedule: () => 1, cancel() {},
    fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return { ok: true, json: async () => ({ accepted: body.events.map(event => event.id) }) };
    },
    beacon: (url, blob) => { beacons.push(blob); return true; },
  });
  return { provider, requests, beacons, storage, consentStorage };
}

test('earlier analytics permission cannot enable Meta and pre-permission events are not replayed', async () => {
  const storage = memory([['dana.analytics.consent.v1', JSON.stringify({ state: 'granted', at: 1000 })]]);
  let initialized = 0;
  const sent = [];
  const tracker = new AnalyticsTracker({
    storage, clock: () => 1000, metaEnabled: true,
    providers: [{ id: 'fixture', configured: true, initialize: async () => { initialized++; return true; }, send: e => sent.push(e), stop() {} }],
  });
  await tracker.start();
  tracker.track('dk_page_view');
  assert.equal(tracker.consent, 'pending');
  assert.equal(initialized, 0);
  assert.equal(sent.length, 0);
  await tracker.setConsent('granted');
  assert.equal(initialized, 1);
  assert.deepEqual(sent.map(e => e.name), ['dk_consent_update']);
  assert.equal(JSON.parse(storage.getItem(CONSENT_KEY)).state, 'granted');
});

test('collector sends current consent scope on fetch and beacon and keeps entered values out', async () => {
  const f = collectorFixture();
  const tracker = new AnalyticsTracker({ storage: f.consentStorage, providers: [f.provider], metaEnabled: true });
  await tracker.start();
  tracker.track('dk_page_view');
  await tracker.flush();
  assert.equal(f.requests.length, 0);
  await tracker.setConsent('granted');
  tracker.track('dk_reward_open', { email: 'private@example.invalid', url: 'https://link.dana.id/private', verificationCode: '123456' });
  await f.provider.flush({ urgent: true });
  await tracker.flush();
  const beacon = JSON.parse(await f.beacons[0].text());
  for (const payload of [...f.requests, beacon]) {
    assert.equal(payload.consent, 'granted');
    assert.equal(payload.consentVersion, CONSENT_VERSION);
    assert.equal(payload.metaConsent, true);
    assert.equal(JSON.stringify(payload).includes('private'), false);
    assert.equal(JSON.stringify(payload).includes('123456'), false);
    assert.equal(payload.events.some(e => e.name === 'dk_page_view'), false);
  }
  assert.deepEqual(beacon.events.map(e => e.id), f.requests[0].events.map(e => e.id));
});

test('collector defaults Meta consent to false unless explicitly enabled', async () => {
  for (const metaEnabled of [undefined, false, 'true']) {
    const requests = [];
    const provider = localProvider({
      metaEnabled, schedule: () => 1, cancel() {},
      fetcher: async (url, options) => {
        requests.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ accepted: ['fixture'] }) };
      },
    });
    await provider.initialize(() => true);
    provider.send({ id: 'fixture', name: 'dk_page_view' });
    await provider.flush();
    assert.equal(requests[0].metaConsent, false);
  }
});

test('previous queues, renewed permission and changed Meta scope cannot replay stored events', async () => {
  const old = { id: 'old-fixture', name: 'dk_page_view' };
  const grantId = crypto.randomUUID();
  for (const saved of [
    [old],
    { consentAt: 999, consentGrantId: grantId, metaConsent: true, events: [old] },
    { consentAt: 1000, consentGrantId: grantId, metaConsent: false, events: [old] },
    { consentAt: 1000, consentGrantId: crypto.randomUUID(), metaConsent: true, events: [old] },
  ]) {
    const consentStorage = memory([[CONSENT_KEY, JSON.stringify({ state: 'granted', at: 1000, metaConsent: true, grantId })]]);
    const storage = memory([
      ['dana.analytics.queue.v1', JSON.stringify([old])],
      [QUEUE_KEY, JSON.stringify(saved)],
    ]);
    const f = collectorFixture({ storage, consentStorage });
    const tracker = new AnalyticsTracker({ storage: consentStorage, providers: [f.provider], clock: () => 1000, metaEnabled: true });
    await tracker.start();
    await tracker.flush();
    assert.equal(f.requests.length, 0);
    assert.equal(f.provider.snapshot().pending, 0);
    assert.equal(storage.getItem('dana.analytics.queue.v1'), undefined);
    assert.equal(storage.getItem(QUEUE_KEY), undefined);
  }
});

test('reload can retry the same consented queue with unchanged event IDs', async () => {
  const consentStorage = memory([[CONSENT_KEY, JSON.stringify({ state: 'granted', at: 1000, metaConsent: true, grantId: crypto.randomUUID() })]]);
  const storage = memory();
  const first = collectorFixture({ storage, consentStorage });
  const tracker = new AnalyticsTracker({ storage: consentStorage, providers: [first.provider], clock: () => 1000, metaEnabled: true });
  await tracker.start();
  const event = tracker.track('dk_page_view');
  const second = collectorFixture({ storage, consentStorage });
  const reloaded = new AnalyticsTracker({ storage: consentStorage, providers: [second.provider], clock: () => 1100, metaEnabled: true });
  await reloaded.start();
  await reloaded.flush();
  assert.deepEqual(second.requests[0].events.map(e => e.id), [event.id]);
  assert.equal(second.requests[0].metaConsent, true);
  assert.equal(storage.getItem(QUEUE_KEY), undefined);
});

test('cross-tab withdrawal stops collector beacons and claim consent snapshots', async () => {
  const f = collectorFixture();
  const tracker = new AnalyticsTracker({ storage: f.consentStorage, providers: [f.provider], clock: () => 1000, metaEnabled: true });
  await tracker.setConsent('granted');
  tracker.track('dk_page_view');
  assert.equal(claimAnalyticsConsent(tracker, true).analyticsConsent, 'granted');
  f.consentStorage.setItem(CONSENT_KEY, JSON.stringify({ state: 'denied', at: 1000 }));
  await f.provider.flush({ urgent: true });
  await tracker.flush();
  assert.deepEqual(claimAnalyticsConsent(tracker, true), { analyticsConsent: 'denied', consentVersion: CONSENT_VERSION });
  assert.equal(f.requests.length, 0);
  assert.equal(f.beacons.length, 0);
  assert.equal(f.provider.snapshot().pending, 0);
  assert.equal(f.storage.getItem(QUEUE_KEY), undefined);
});

test('claim metadata fails closed for disabled integration, cleared or expired consent', async () => {
  const storage = memory();
  let now = 1000;
  const tracker = new AnalyticsTracker({ storage, clock: () => now, metaEnabled: true });
  await tracker.setConsent('granted');
  assert.equal(claimAnalyticsConsent(tracker, false).analyticsConsent, 'denied');
  assert.equal(claimAnalyticsConsent(tracker, 'true').analyticsConsent, 'denied');
  now += 181 * 24 * 60 * 60 * 1000;
  assert.equal(claimAnalyticsConsent(tracker, true).analyticsConsent, 'denied');
  await tracker.setConsent('granted');
  storage.removeItem(CONSENT_KEY);
  assert.equal(claimAnalyticsConsent(tracker, true).analyticsConsent, 'denied');
});

test('a newer cross-tab grant discards events from a missed withdrawal', async () => {
  const f = collectorFixture();
  let now = 1000;
  const tracker = new AnalyticsTracker({ storage: f.consentStorage, providers: [f.provider], clock: () => now, metaEnabled: true });
  await tracker.setConsent('granted');
  tracker.track('dk_page_view');
  f.consentStorage.setItem(CONSENT_KEY, JSON.stringify({ state: 'denied', at: now }));
  f.consentStorage.setItem(CONSENT_KEY, JSON.stringify({ state: 'granted', at: now, metaConsent: true, grantId: crypto.randomUUID() }));
  await f.provider.flush({ urgent: true });
  assert.equal(tracker.consent, 'pending');
  assert.equal(f.provider.snapshot().pending, 0);
  assert.equal(f.beacons.length, 0);
  assert.equal(claimAnalyticsConsent(tracker, true).analyticsConsent, 'denied');
  now = 3000;
  await tracker.setConsent('granted');
  await tracker.flush();
  assert.deepEqual(f.requests[0].events.map(e => e.name), ['dk_consent_update']);
});

test('enabling Meta requires renewed permission and cannot send the analytics-only queue', async () => {
  const consentStorage = memory();
  const storage = memory();
  let now = 1000;
  const first = collectorFixture({ storage, consentStorage, metaEnabled: false });
  const initial = new AnalyticsTracker({ storage: consentStorage, providers: [first.provider], clock: () => now });
  await initial.setConsent('granted');
  const previous = initial.track('dk_page_view');
  assert.equal(JSON.parse(consentStorage.getItem(CONSENT_KEY)).metaConsent, false);
  const second = collectorFixture({ storage, consentStorage });
  const reloaded = new AnalyticsTracker({ storage: consentStorage, providers: [second.provider], clock: () => now, metaEnabled: true });
  await reloaded.start();
  await reloaded.flush();
  assert.equal(reloaded.consent, 'pending');
  assert.equal(second.requests.length, 0);
  assert.equal(claimAnalyticsConsent(reloaded, true).analyticsConsent, 'denied');
  now = 2000;
  await reloaded.setConsent('granted');
  await reloaded.flush();
  assert.equal(JSON.parse(consentStorage.getItem(CONSENT_KEY)).metaConsent, true);
  assert.equal(second.requests[0].metaConsent, true);
  assert.equal(second.requests[0].events.some(e => e.id === previous.id), false);
  assert.deepEqual(second.requests[0].events.map(e => e.name), ['dk_consent_update']);
});

test('cross-tab analytics-only permission stops an existing Meta-enabled tab', async () => {
  const f = collectorFixture();
  const tracker = new AnalyticsTracker({ storage: f.consentStorage, providers: [f.provider], clock: () => 1000, metaEnabled: true });
  await tracker.setConsent('granted');
  tracker.track('dk_page_view');
  const analyticsOnly = new AnalyticsTracker({ storage: f.consentStorage, clock: () => 1000 });
  await analyticsOnly.setConsent('granted');
  await f.provider.flush({ urgent: true });
  assert.equal(tracker.consent, 'pending');
  assert.equal(f.provider.snapshot().pending, 0);
  assert.equal(f.beacons.length, 0);
  assert.equal(claimAnalyticsConsent(tracker, true).analyticsConsent, 'denied');
});
