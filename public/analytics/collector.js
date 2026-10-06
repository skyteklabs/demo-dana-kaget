const QUEUE_KEY = 'dana.analytics.queue.v1';

export function localProvider({ fetcher = (...args) => fetch(...args), beacon = (...args) => navigator.sendBeacon(...args), storage, schedule = setTimeout, cancel = clearTimeout } = {}) {
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
  const save = () => {
    try {
      if (active && queue.length) storage?.setItem(QUEUE_KEY, JSON.stringify(queue));
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
        if (beacon('/api/events', new Blob([JSON.stringify({ consent: 'granted', events: queue.slice(-20) })], { type: 'application/json' }))) {
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
          body: JSON.stringify({ consent: 'granted', events: batch }),
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
        const saved = JSON.parse(storage?.getItem(QUEUE_KEY) || '[]');
        if (Array.isArray(saved)) queue = saved.slice(-500);
      } catch {}
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
