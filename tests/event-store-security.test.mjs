import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEventStore } from '../lib/event-store.mjs';

const event = () => ({ name: 'dk_page_view', id: randomUUID(), at: Date.now(), properties: { journey_id: randomUUID(), sequence: 1, step_id: 'email', step_number: 1 } });

async function fixture(t, limits = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dana-events-security-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'dana-events.jsonl'), store: await createEventStore(directory, limits) };
}

test('event retention rolls over, remains private and survives restart without a permanent full state', async t => {
  const { directory, file, store } = await fixture(t, { maxEvents: 10 });
  const batches = Array.from({ length: 16 }, event);
  await store.append(batches.slice(0, 10));
  await store.append([batches[10]]);
  assert.deepEqual(store.all().map(e => e.id), batches.slice(2, 11).map(e => e.id));
  await store.append(batches.slice(11));
  assert.deepEqual(store.all().map(e => e.id), batches.slice(7).map(e => e.id));
  const resumed = await createEventStore(directory, { maxEvents: 10 });
  assert.deepEqual(resumed.all(), store.all());
  await resumed.append([event()]);
  await resumed.append([event()]);
  assert.ok(resumed.all().length <= 10);
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, resumed.all().length);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['dana-events.jsonl']);
});

test('retry IDs deduplicate while retained and can be accepted again after rotation', async t => {
  const { directory, store } = await fixture(t, { maxEvents: 3 });
  const items = Array.from({ length: 4 }, event);
  await store.append(items.slice(0, 3));
  await store.append([items[3]]);
  assert.deepEqual(store.all().map(e => e.id), items.slice(2).map(e => e.id));
  const resumed = await createEventStore(directory, { maxEvents: 3 });
  await resumed.append([items[3], items[3]]);
  assert.equal(resumed.all().length, 2);
  await resumed.append([items[0]]);
  assert.deepEqual(resumed.all().map(e => e.id), [items[2].id, items[3].id, items[0].id]);
});

test('startup compacts an oversized journal and repairs incomplete records', async t => {
  const { directory, file, store } = await fixture(t);
  await store.append(Array.from({ length: 20 }, event));
  const expected = store.all().slice(-3).map(e => e.id);
  await appendFile(file, '{"interrupted":');
  const resumed = await createEventStore(directory, { maxEvents: 3 });
  assert.ok(resumed.all().length <= 3);
  assert.ok(resumed.all().every(e => expected.includes(e.id)));
  const another = event();
  await resumed.append([another]);
  const restarted = await createEventStore(directory, { maxEvents: 3 });
  assert.deepEqual(restarted.all(), resumed.all());
  assert.equal(restarted.all().at(-1).id, another.id);
  assert.ok(!(await readFile(file, 'utf8')).includes('interrupted'));
});

test('bounded concurrent appends return a retryable busy error and free slots after completion', async t => {
  const { directory, store } = await fixture(t, { maxPending: 2 });
  const items = Array.from({ length: 3 }, event);
  const results = await Promise.allSettled(items.map(e => store.append([e])));
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(results[2].reason.status, 503);
  assert.equal(results[2].reason.code, 'service_unavailable');
  assert.equal(results[2].reason.retryAfter, 1);
  await store.append([items[2]]);
  assert.deepEqual((await createEventStore(directory)).all().map(e => e.id), items.map(e => e.id));
});

test('concurrent retries are serialized and deduplicated against committed writes', async t => {
  const { store } = await fixture(t);
  const e = event();
  const accepted = await Promise.all(Array.from({ length: 12 }, () => store.append([e])));
  assert.ok(accepted.every(ids => ids.length === 1 && ids[0] === e.id));
  assert.equal(store.all().length, 1);
});

test('failed append recovers the queue and replaces a potentially partial journal', async t => {
  const { directory, file, store } = await fixture(t, { maxPending: 1 });
  const original = event();
  await store.append([original]);
  await rename(file, `${file}.backup`);
  await mkdir(file);
  await assert.rejects(store.append([event()]));
  assert.equal(store.all().length, 1);
  await rm(file, { recursive: true });
  await rename(`${file}.backup`, file);
  await appendFile(file, '{"partial":');
  const next = event();
  await store.append([next]);
  assert.deepEqual((await createEventStore(directory)).all().map(e => e.id), [original.id, next.id]);
});

test('failed snapshot preserves committed events and removes its temporary file', async t => {
  const { directory, file, store } = await fixture(t, { maxEvents: 2 });
  const items = Array.from({ length: 3 }, event);
  await store.append(items.slice(0, 2));
  await rename(file, `${file}.backup`);
  await mkdir(file);
  await assert.rejects(store.append([items[2]]));
  assert.deepEqual(store.all().map(e => e.id), items.slice(0, 2).map(e => e.id));
  assert.ok((await readdir(directory)).every(name => !name.endsWith('.tmp')));
  await rm(file, { recursive: true });
  await rename(`${file}.backup`, file);
  await store.append([items[2]]);
  assert.deepEqual((await createEventStore(directory, { maxEvents: 2 })).all().map(e => e.id), [items[2].id]);
});

test('invalid batches do not consume queue slots and queued data is sanitized before waiting', async t => {
  const { store } = await fixture(t, { maxPending: 1 });
  for (const batch of [null, [], Array.from({ length: 21 }, event), [{ ...event(), id: 'invalid' }]]) {
    await assert.rejects(store.append(batch), error => error.status === 400);
  }
  const original = event();
  original.properties.value = 'private-input';
  const originalId = original.id;
  const operation = store.append([original]);
  original.id = 'changed-after-enqueue';
  original.properties.step_number = 3;
  await operation;
  assert.equal(store.all()[0].id, originalId);
  assert.equal(store.all()[0].properties.step_number, 1);
  assert.equal(store.all()[0].properties.value, undefined);
});

test('an existing empty journal also has its permissions restricted', async t => {
  const { directory, file } = await fixture(t);
  await writeFile(file, '', { mode: 0o644 });
  await createEventStore(directory);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
