import { createReadStream } from 'node:fs';
import { mkdir, appendFile, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isEventName, sanitizeProperties, UUID_PATTERN } from '../public/analytics/events.js';

export function cleanEvent(event, now = Date.now()) {
  if (!event || !isEventName(event.name) || !UUID_PATTERN.test(event.id)) return null;
  const props = event.properties;
  if (!props || !UUID_PATTERN.test(props.journey_id) || !Number.isSafeInteger(props.sequence) || props.sequence < 1) return null;
  if (!Number.isSafeInteger(event.at) || event.at < 0 || event.at > now + 60_000) return null;
  const safe = sanitizeProperties(props);
  if (!safe.step_id || !safe.step_number) return null;
  return {
    name: event.name, id: event.id, at: event.at, received_at: now,
    properties: { ...safe, journey_id: props.journey_id, sequence: props.sequence, form_id: 'dana_kaget' },
  };
}

export async function createEventStore(directory, { maxEvents = 100_000, maxPending = 64 } = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isSafeInteger(maxPending) || maxPending < 1) throw new RangeError('Invalid event store limits');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'dana-events.jsonl');
  let events = [];
  let ids = new Set();
  const retainRecent = items => items.length > maxEvents ? items.slice(-Math.max(1, maxEvents - Math.ceil(maxEvents / 10))) : items;
  const serialize = items => items.length ? `${items.map(event => JSON.stringify(event)).join('\n')}\n` : '';
  async function replaceJournal(next) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(serialize(next));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }
  let exists = false;
  try {
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const clean = cleanEvent(parsed, parsed.received_at);
        if (clean && Number.isSafeInteger(clean.received_at) && !ids.has(clean.id)) {
          events.push(clean);
          if (events.length > maxEvents) {
            events = retainRecent(events);
            ids = new Set(events.map(event => event.id));
          } else ids.add(clean.id);
        }
      } catch { /* Ignore an incomplete line left by an interrupted write. */ }
    }
    exists = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Rewriting also removes an interrupted final line before another append.
  if (exists) await replaceJournal(events);
  let pending = Promise.resolve();
  let pendingCount = 0;
  let needsSnapshot = false;
  return {
    all: () => events,
    async append(batch) {
      if (pendingCount >= maxPending) throw Object.assign(new Error('Event store busy'), { status: 503, code: 'service_unavailable', retryAfter: 1 });
      if (!Array.isArray(batch) || !batch.length || batch.length > 20) throw Object.assign(new Error('Invalid event batch'), { status: 400 });
      const clean = batch.map(e => cleanEvent(e));
      if (clean.some(e => !e)) throw Object.assign(new Error('Invalid event'), { status: 400 });
      pendingCount += 1;
      const operation = pending.then(async () => {
        const batchIds = new Set();
        const fresh = clean.filter(e => {
          if (ids.has(e.id) || batchIds.has(e.id)) return false;
          batchIds.add(e.id);
          return true;
        });
        if (fresh.length || needsSnapshot) {
          const rotating = events.length + fresh.length > maxEvents;
          const next = rotating || needsSnapshot ? retainRecent(events.concat(fresh)) : null;
          try {
            if (next) await replaceJournal(next);
            else await appendFile(file, serialize(fresh), { mode: 0o600 });
          } catch (error) {
            // A failed append may have written a partial line; retry from committed state.
            needsSnapshot = true;
            throw error;
          }
          if (next) events = next;
          else events.push(...fresh);
          if (rotating) ids = new Set(events.map(e => e.id));
          else fresh.forEach(e => ids.add(e.id));
          needsSnapshot = false;
        }
        return clean.map(e => e.id);
      }).finally(() => { pendingCount -= 1; });
      pending = operation.catch(() => {});
      return operation;
    },
  };
}
