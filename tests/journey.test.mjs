import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AnalyticsTracker, CONSENT_KEY, JOURNEY_KEY } from '../public/analytics/tracker.js';
import { Journey } from '../public/analytics/journey.js';
import { localProvider } from '../public/analytics/collector.js';
import { FIELDS, STEPS, validateField } from '../public/form-schema.js';
import { buildReport, DROPOFF_MS } from '../lib/report.mjs';

const memory = () => {
  const data = new Map();
  return { data, getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
};
function fixture() {
  let now = 1000;
  const tracker = new AnalyticsTracker({ clock: () => now, uuid: randomUUID });
  const journey = new Journey(tracker, { clock: () => now });
  const records = () => tracker.snapshot().records.map(r => ({ ...r.event, received_at: r.event.at }));
  return { tracker, journey, records, advance: ms => { now += ms; } };
}

test('focus, typing, validation and step continuation identify exactly where a user progressed', () => {
  const f = fixture();
  f.journey.enter(0);
  f.journey.hover('email');
  f.journey.focus('email', { filled: false, valid: false }, 'keyboard');
  f.advance(1200);
  f.journey.input('email', { filled: true, valid: false });
  f.journey.edited('email');
  f.journey.validated('email', 'invalid_format');
  f.journey.submit(1);
  assert.equal(f.records().some(e => e.name === 'dk_step_complete'), false);
  f.journey.focus('email', { filled: true, valid: false });
  f.journey.input('email', { filled: true, valid: false });
  f.journey.validated('email', null);
  f.journey.submit(0); f.journey.continued();
  f.journey.enter(1);
  const report = buildReport(f.records(), 2500);
  assert.equal(report.totals.started, 1);
  assert.equal(report.steps[0].viewed, 1);
  assert.equal(report.steps[0].continued, 1);
  assert.equal(report.fields[0].focused, 1);
  assert.equal(report.fields[0].errors, 1);
  assert.equal(report.fields[0].typed, 1);
  const focus = f.records().find(e => e.name === 'dk_field_focus');
  assert.equal(focus.properties.interaction, 'keyboard');
  const blur = f.records().find(e => e.name === 'dk_field_blur');
  assert.equal(blur.properties.duration_ms, 1200);
  assert.equal(blur.properties.input_count, 1);
  assert.equal(report.journeys[0].lastField, null);
});

test('a hidden tab is away, and only inactivity beyond the threshold implies drop-off', () => {
  const f = fixture();
  f.journey.enter(0);
  f.journey.focus('email', { filled: false }, 'pointer');
  f.advance(5000);
  f.journey.visibility(true);
  assert.equal(buildReport(f.records(), 6100).journeys[0].state, 'away');
  let report = buildReport(f.records(), 6000 + DROPOFF_MS);
  assert.equal(report.journeys[0].state, 'dropoff');
  assert.equal(report.fields.find(x => x.id === 'email').lastAtDrop, 1);
  f.advance(10 * 60_000);
  f.journey.visibility(false);
  f.journey.submit(0); f.journey.continued();
  const complete = f.records().find(e => e.name === 'dk_step_complete');
  assert.equal(complete.properties.duration_ms, 5000, 'hidden time is excluded');
  report = buildReport(f.records(), 606001);
  assert.equal(report.totals.dropoffs, 0);
});

test('idle emits once and stops heartbeats, allowing an abandoned open tab to time out', () => {
  const f = fixture();
  f.journey.enter(0);
  f.journey.focus('email', { filled: false });
  f.advance(60_000); f.journey.tick();
  f.advance(60_000); f.journey.tick();
  assert.equal(f.records().filter(e => e.name === 'dk_form_idle').length, 1);
  assert.equal(f.records().filter(e => e.name === 'dk_heartbeat').length, 0);
  f.journey.input('email', { filled: true });
  f.journey.tick();
  assert.equal(f.records().filter(e => e.name === 'dk_form_resume').length, 1);
  assert.equal(f.records().filter(e => e.name === 'dk_heartbeat').length, 1);
});

test('valid events reflect accepted field values even when input already updated its validity state', () => {
  const f = fixture();
  f.journey.focus('email', { filled: false, valid: false });
  f.journey.input('email', { filled: true, valid: true });
  f.journey.validated('email', null);
  f.journey.validated('email', null);
  assert.equal(f.records().filter(e => e.name === 'dk_field_valid').length, 1);
  f.journey.input('email', { filled: true, valid: false });
  f.journey.validated('email', 'invalid_format');
  f.journey.input('email', { filled: true, valid: true });
  f.journey.validated('email', null);
  assert.equal(f.records().filter(e => e.name === 'dk_field_valid').length, 2);
  assert.equal(buildReport(f.records()).fields[0].valid, 1);
});

test('step revisits and out-of-order delivery do not inflate funnels or undo completion', () => {
  const f = fixture();
  f.journey.enter(0); f.journey.submit(0); f.journey.continued(); f.journey.enter(1); f.journey.enter(0); f.journey.submit(0); f.journey.continued();
  f.journey.enter(2); f.journey.submit(0); f.journey.continued(); f.journey.complete(); f.journey.exit();
  const report = buildReport(f.records().reverse(), 1000 + DROPOFF_MS * 2);
  assert.equal(report.steps[0].viewed, 1);
  assert.equal(report.steps[0].continued, 1);
  assert.equal(report.totals.completed, 1);
  assert.equal(report.totals.dropoffs, 0);
  assert.equal(f.records().some(e => e.name === 'dk_form_exit'), false);
});

test('reload preserves consented journey and sequence, while completion removes the reload identity', async () => {
  const storage = memory(); const journeyStorage = memory();
  const opts = { storage, journeyStorage, uuid: randomUUID, clock: () => 1000 };
  const first = new AnalyticsTracker(opts);
  first.track('dk_page_view');
  assert.equal(journeyStorage.data.size, 0);
  await first.setConsent('granted');
  const event = first.track('dk_form_start');
  const reloaded = new AnalyticsTracker(opts);
  assert.equal(reloaded.resumed, true);
  assert.equal(reloaded.snapshot().journeyId, event.properties.journey_id);
  assert.equal(reloaded.track('dk_form_resume').properties.sequence, event.properties.sequence + 1);
  assert.deepEqual(Object.keys(JSON.parse(journeyStorage.getItem(JOURNEY_KEY))).sort(), ['at', 'id', 'sequence']);
  reloaded.endJourney();
  reloaded.track('dk_reward_copy');
  assert.equal(new AnalyticsTracker(opts).resumed, false);
  assert.deepEqual([...storage.data.keys()], [CONSENT_KEY]);
});

test('withdrawing consent removes journey persistence and starting over clears all field context', async () => {
  const journeyStorage = memory();
  const tracker = new AnalyticsTracker({ journeyStorage });
  await tracker.setConsent('granted'); tracker.track('dk_form_start');
  await tracker.setConsent('denied');
  assert.equal(journeyStorage.data.size, 0);
  const journey = new Journey(tracker);
  journey.focus('email', { filled: true });
  const old = tracker.snapshot().journeyId;
  tracker.newJourney(); journey.reset(); journey.enter(0);
  assert.notEqual(tracker.snapshot().journeyId, old);
  assert.equal(journey.lastField, undefined);
  assert.equal(journey.context().filled_count, 0);
});

test('local delivery retries after failure, beacon queueing is not an acknowledgement, and withdrawal clears queue', async () => {
  const storage = memory(); let fail = true; const requests = [];
  const provider = localProvider({ storage, schedule: () => 1, cancel: () => {}, beacon: () => true,
    fetcher: async (url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ accepted: body.events.map(e => e.id) }) };
    },
  });
  const tracker = new AnalyticsTracker({ providers: [provider] });
  tracker.track('dk_page_view');
  await tracker.flush();
  assert.equal(requests.length, 0);
  await tracker.setConsent('granted');
  tracker.track('dk_field_focus', { field_id: 'email', value: 'must-not-leak' });
  await tracker.flush();
  assert.equal(provider.snapshot().status, 'retry_pending');
  await provider.flush({ urgent: true });
  assert.equal(provider.snapshot().pending, 2);
  assert.equal(provider.snapshot().acknowledged, 0);
  fail = false; await tracker.flush();
  assert.equal(provider.snapshot().acknowledged, 2);
  assert.equal(provider.snapshot().pending, 0);
  assert.equal(JSON.stringify(requests).includes('must-not-leak'), false);
  assert.equal(requests[0].events.some(e => e.name === 'dk_page_view'), false);
  tracker.track('dk_form_start');
  await tracker.setConsent('denied');
  assert.equal(provider.snapshot().pending, 0);
  assert.equal(storage.data.size, 0);
});

test('email and OTP validation accept valid input and reject malformed values', () => {
  const values = { email: 'demo@example.test', turnstile: 'test-token', verification_code: '123456' };
  for (const id of STEPS.flatMap(s => s.fields)) {
    assert.equal(validateField(id, values[id]), null, id);
    assert.equal(validateField(id, ''), 'required', id);
  }
  assert.equal(validateField('email', 'not-an-email'), 'invalid_format');
  assert.equal(validateField('email', 'a@example.test\nBcc:x@example.test'), 'invalid_format');
  assert.equal(validateField('verification_code', '12345'), 'invalid_format');
  assert.equal(validateField('verification_code', '12a456'), 'invalid_format');
});

test('a valid local submission does not count as continuation until the server succeeds', () => {
  const f = fixture();
  f.journey.enter(0); f.journey.submit(0);
  assert.equal(buildReport(f.records()).steps[0].continued, 0);
  f.journey.emit('dk_email_failed', { error_code: 'email_unavailable' });
  assert.equal(buildReport(f.records()).outcomes.find(o => o.name === 'dk_email_failed').journeys, 1);
  f.journey.continued();
  assert.equal(buildReport(f.records()).steps[0].continued, 1);
});
