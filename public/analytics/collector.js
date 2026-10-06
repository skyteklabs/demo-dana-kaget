import { CONSENT_KEY, CONSENT_VERSION, QUEUE_KEY } from './consent.js';
import { UUID_PATTERN } from './events.js';
const LEGACY_QUEUE_KEY = 'dana.analytics.queue.v1';

export function localProvider({ fetcher = (...args) => fetch(...args), beacon = (...args) => navigator.sendBeacon(...args), storage, consentStorage, metaEnabled = false, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let active = false;
  let allowed = () => false;
  let queue = [];
  let timer;
  let inflight;
  let controller;
  let generation = 0;
  let acknowledged = 0;
  let dropped = 0;
  let status = 'waiting_consent';
  let consentAt;
  let consentGrantId;
  let metaConsent = false;
  const payload = events => ({ consent: 'granted', consentVersion: CONSENT_VERSION, metaConsent, events });
  const save = () => {
    try {
      storage?.removeItem(LEGACY_QUEUE_KEY);
      if (active && queue.length) storage?.setItem(QUEUE_KEY, JSON.stringify({ consentAt, consentGrantId, metaConsent, events: queue }));
      else storage?.removeItem(QUEUE_KEY);
    } catch { /* In-memory delivery remains available when storage is blocked. */ }
  };
  const later = () => {
    if (!timer && active && queue.length) timer = schedule(() => { timer = undefined; void flush(); }, 2000);
  };
  async function flush({ urgent = false } = {}) {
    if (!active || !allowed() || !queue.length) return;
    if (urgent) {
      // A beacon's return value confirms queueing, not receipt. Keep IDs for deduplicated retry.
      try {
        if (beacon('/api/events', new Blob([JSON.stringify(payload(queue.slice(-20)))], { type: 'application/json' }))) {
          status = 'beacon_queued';
          return;
        }
      } catch {}
    }
    if (inflight) return inflight;
    const batch = queue.slice(0, 20);
    const current = generation;
    controller = new AbortController();
    status = 'sending';
    inflight = (async () => {
      try {
        const response = await fetcher('/api/events', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload(batch)),
          keepalive: true, signal: controller.signal,
        });
        if (!response.ok) throw new Error('Collector unavailable');
        const result = await response.json();
        if (!active || current !== generation) return;
        const ids = new Set(result.accepted);
        queue = queue.filter(event => !ids.has(event.id));
        acknowledged += ids.size;
        status = 'received';
        save();
      } catch {
        if (active && current === generation) status = 'retry_pending';
      } finally {
        inflight = undefined;
        later();
      }
    })();
    return inflight;
  }
  return {
    id: 'local', configured: true,
    async initialize(consentAllowed) {
      allowed = consentAllowed;
      if (!allowed()) return false;
      active = true;
      status = 'ready';
      try {
        storage?.removeItem(LEGACY_QUEUE_KEY);
        const consent = JSON.parse(consentStorage?.getItem(CONSENT_KEY) || 'null');
        consentAt = consent?.state === 'granted' && Number.isFinite(consent.at) ? consent.at : undefined;
        consentGrantId = UUID_PATTERN.test(consent?.grantId) ? consent.grantId : undefined;
        metaConsent = metaEnabled === true && consentAt !== undefined && consentGrantId !== undefined && consent.metaConsent === true;
        const saved = JSON.parse(storage?.getItem(QUEUE_KEY) || 'null');
        if (consentAt !== undefined && consentGrantId !== undefined && saved?.consentAt === consentAt
            && saved.consentGrantId === consentGrantId && saved.metaConsent === metaConsent && Array.isArray(saved.events)) {
          queue = saved.events.slice(-500);
        }
      } catch {}
      save();
      later();
      return true;
    },
    send(event) {
      if (!active || !allowed()) return;
      if (queue.length >= 500) { dropped++; status = 'queue_full'; return; }
      queue.push(event);
      save();
      later();
    },
    flush,
    stop() {
      active = false;
      generation++;
      controller?.abort();
      cancel(timer);
      timer = undefined;
      queue = [];
      status = 'disabled';
      save();
    },
    snapshot: () => ({ status, pending: queue.length, acknowledged, dropped }),
  };
}
