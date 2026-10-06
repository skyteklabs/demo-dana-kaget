import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createHandler } from '../server.mjs';
import { createEventStore } from '../lib/event-store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bpu-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createEventStore(directory);
  return { directory, store, handler: createHandler({ store, env: { GA4_MEASUREMENT_ID: 'G-TEST', PRIVATE_SECRET: 'must-not-export' } }) };
}
export async function request(handler, url, { method = 'GET', body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  req.url = url; req.method = method; req.headers = { host: 'localhost:4173', 'content-type': 'application/json', ...headers };
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, fields) { this.status = status; Object.assign(this.headers, fields); }, end(data) { this.body = data?.toString() || ''; } };
  await handler(req, res);
  return res;
}
function event(extra = {}) {
  return { name: 'dk_field_focus', id: randomUUID(), at: Date.now(), properties: { journey_id: randomUUID(), sequence: 1, step_id: 'email', step_number: 1, field_id: 'email', ...extra } };
}

test('form aliases, report and JS assets are served; configuration exports only public values', async t => {
  const { handler } = await fixture(t);
  for (const route of ['/', '/dana-kaget', '/dana-kaget/', '/analytics', '/analytics/', '/app.js', '/analytics/journey.js', '/styles.css']) {
    const res = await request(handler, route);
    assert.equal(res.status, 200, route);
    if (['/', '/dana-kaget', '/dana-kaget/'].includes(route)) assert.match(res.body, /id="form"/);
  }
  const cfg = await request(handler, '/api/config');
  assert.equal(JSON.parse(cfg.body).ga4MeasurementId, 'G-TEST');
  assert.equal(cfg.body.includes('must-not-export'), false);
  assert.equal((await request(handler, '/dana-kaget', { method: 'HEAD' })).body, '');
  assert.equal((await request(handler, '/healthz')).status, 200);
});

test('collector strips personal values server-side, deduplicates retry IDs and survives restart', async t => {
  const { directory, handler, store } = await fixture(t);
  const e = event({ value: 'private-input', nik: '0000000000000000', email: 'private@example.invalid', nested: { text: 'private-input' }, last_field_id: 'email' });
  const body = { consent: 'granted', events: [e, e] };
  const first = await request(handler, '/api/events', { method: 'POST', body });
  assert.equal(first.status, 200);
  await request(handler, '/api/events', { method: 'POST', body });
  assert.equal(store.all().length, 1);
  const persisted = await readFile(join(directory, 'dana-events.jsonl'), 'utf8');
  assert.equal(persisted.includes('private-input'), false);
  assert.equal(persisted.includes('private@example.invalid'), false);
  const resumed = await createEventStore(directory);
  assert.equal(resumed.all().length, 1);
  assert.equal(resumed.all()[0].properties.field_id, 'email');
  await resumed.append([e]);
  assert.equal(resumed.all().length, 1);
  const report = JSON.parse((await request(handler, '/api/report')).body);
  assert.equal(report.fields[0].focused, 1);
  const exported = await request(handler, '/api/events/export');
  assert.equal(JSON.parse(exported.body).length, 1);
});

test('collector rejects missing consent, foreign origin, malformed batches and invalid identifiers', async t => {
  const { handler, store } = await fixture(t);
  const e = event();
  const post = options => request(handler, '/api/events', { method: 'POST', ...options });
  assert.equal((await post({ body: { events: [e] } })).status, 403);
  assert.equal((await post({ body: null })).status, 403);
  assert.equal((await post({ body: '{' })).status, 400);
  assert.equal((await post({ body: { consent: 'granted', events: [] } })).status, 400);
  assert.equal((await post({ body: { consent: 'granted', events: [e] }, headers: { origin: 'https://elsewhere.example' } })).status, 403);
  assert.equal((await post({ body: { consent: 'granted', events: [{ ...e, id: 'personal@example.invalid' }] } })).status, 400);
  assert.equal((await post({ body: ' '.repeat(33_000) })).status, 413);
  assert.equal(store.all().length, 0);
});

test('static server refuses traversal and malformed paths and reports unsupported methods', async t => {
  const { handler } = await fixture(t);
  for (const url of ['/.env.example', '/%2e%2e%2fpackage.json', '/%2e%2e%5cpackage.json', '/api/unknown']) assert.equal((await request(handler, url)).status, 404, url);
  assert.equal((await request(handler, '/%ZZ')).status, 400);
  assert.equal((await request(handler, '/dana-kaget', { method: 'POST', body: 'should-never-store-form' })).status, 405);
});

test('a partial final journal line cannot swallow the next valid event after restart', async t => {
  const { directory, store } = await fixture(t);
  await store.append([event()]);
  await appendFile(join(directory, 'dana-events.jsonl'), '{"interrupted":');
  const resumed = await createEventStore(directory);
  await resumed.append([event()]);
  assert.equal((await createEventStore(directory)).all().length, 2);
});
