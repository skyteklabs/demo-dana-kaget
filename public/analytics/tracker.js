import { isEventName, sanitizeProperties, UUID_PATTERN } from './events.js';
import { CONSENT_KEY } from './consent.js';

export { CONSENT_KEY } from './consent.js';
const CONSENT_LIFETIME = 180 * 24 * 60 * 60 * 1000;
export const JOURNEY_KEY = 'dana.analytics.journey.v2';

export class AnalyticsTracker {
  #records = [];
  #listeners = new Set();
  #providers;
  #storage;
  #clock;
  #uuid;
  #generation = 0;
  #journeyId;
  #step = { step_id: 'email', step_number: 1 };
  #limit;
  #journeyStorage;
  #sequence = 0;
  #ended = false;
  #consentAt;
  #consentGrantId;
  #metaEnabled;
  resumed = false;

  constructor({ providers = [], storage, journeyStorage, clock = Date.now, uuid = () => crypto.randomUUID(), limit = 300, metaEnabled = false } = {}) {
    this.#storage = storage;
    this.#clock = clock;
    this.#uuid = uuid;
    this.#limit = limit;
    this.#metaEnabled = metaEnabled === true;
    this.#providers = providers.map(adapter => ({ adapter, status: adapter.configured ? 'waiting_consent' : 'not_configured' }));
    const savedConsent = this.#readConsent();
    this.consent = savedConsent.state;
    this.#consentAt = savedConsent.at;
    this.#consentGrantId = savedConsent.grantId;
    this.#journeyId = this.#uuid();
    this.#journeyStorage = journeyStorage;
    if (this.consent === 'granted') {
      try {
        const saved = JSON.parse(journeyStorage?.getItem(JOURNEY_KEY) || 'null');
        if (saved && UUID_PATTERN.test(saved.id) && Number.isSafeInteger(saved.sequence) && saved.sequence >= 0
            && saved.at <= clock() && clock() - saved.at < 30 * 60_000) {
          this.#journeyId = saved.id;
          this.#sequence = saved.sequence;
          this.resumed = true;
        }
      } catch { /* A journey can still run without browser storage. */ }
    }
  }

  #readConsent(fallback = 'pending') {
    if (!this.#storage) return { state: fallback, at: this.#consentAt, grantId: this.#consentGrantId };
    try {
      const saved = JSON.parse(this.#storage?.getItem(CONSENT_KEY) || 'null');
      if (saved && ['granted', 'denied'].includes(saved.state)
          && Number.isFinite(saved.at) && saved.at <= this.#clock()
          && this.#clock() - saved.at < CONSENT_LIFETIME) {
        if (saved.state === 'granted' && !UUID_PATTERN.test(saved.grantId)) return { state: 'pending' };
        if (saved.state === 'granted' && this.#metaEnabled && saved.metaConsent !== true) return { state: 'pending' };
        return saved;
      }
    } catch { /* Storage may be unavailable in private browsing. */ }
    return { state: 'pending' };
  }

  async start() {
    this.syncConsent();
    if (this.consent === 'granted') await this.#enableProviders();
  }

  syncConsent() {
    const stored = this.#readConsent(this.consent);
    if (stored.state === 'granted') {
      if (this.consent !== 'granted' || (stored.at === this.#consentAt && stored.grantId === this.#consentGrantId)) return;
      // A newer grant may follow a withdrawal that this tab did not observe.
      this.consent = 'pending';
    } else {
      if (stored.state === this.consent) return;
      this.consent = stored.state;
    }
    this.#disableProviders();
    this.#notify();
  }

  #disableProviders() {
    try { this.#journeyStorage?.removeItem(JOURNEY_KEY); } catch {}
    this.#generation++;
    for (const provider of this.#providers) {
      try { provider.adapter.stop(); } catch { /* A provider cannot block withdrawal. */ }
      provider.status = provider.adapter.configured ? 'disabled' : 'not_configured';
    }
    for (const record of this.#records) {
      for (const id of Object.keys(record.delivery)) {
        if (record.delivery[id] === 'queued') record.delivery[id] = 'discarded';
      }
    }
  }

  setStep(stepId, stepNumber) {
    this.#step = sanitizeProperties({ step_id: stepId, step_number: stepNumber });
  }

  track(name, properties = {}) {
    this.syncConsent();
    if (!isEventName(name)) return null;
    const event = Object.freeze({
      name,
      at: this.#clock(),
      id: this.#uuid(),
      properties: Object.freeze({
        ...this.#step,
        ...sanitizeProperties(properties),
        form_id: 'dana_kaget',
        journey_id: this.#journeyId,
        sequence: ++this.#sequence,
      }),
    });
    if (this.consent === 'granted' && !this.#ended) {
      try { this.#journeyStorage?.setItem(JOURNEY_KEY, JSON.stringify({ id: this.#journeyId, sequence: this.#sequence, at: event.at })); } catch {}
    }
    const record = { event, consent: this.consent, delivery: {} };
    for (const provider of this.#providers) {
      record.delivery[provider.adapter.id] = this.consent !== 'granted' ? 'local_only'
        : !provider.adapter.configured ? 'not_configured' : 'queued';
    }
    this.#records.push(record);
    if (this.#records.length > this.#limit) this.#records.shift();
    if (this.consent === 'granted') {
      for (const provider of this.#providers) this.#deliver(provider, record);
    }
    this.#notify();
    return event;
  }

  #deliver(provider, record) {
    this.syncConsent();
    if (this.consent !== 'granted' || record.consent !== 'granted'
        || provider.status !== 'ready' || record.delivery[provider.adapter.id] !== 'queued') return;
    try {
      provider.adapter.send(record.event);
      record.delivery[provider.adapter.id] = 'handed_to_sdk';
    } catch {
      record.delivery[provider.adapter.id] = 'failed';
      provider.status = 'error';
    }
  }

  async setConsent(state) {
    if (!['granted', 'denied'].includes(state)) throw new TypeError('Invalid consent state');
    const changed = this.consent !== state;
    this.consent = state;
    this.#consentAt = this.#clock();
    this.#consentGrantId = state === 'granted' ? crypto.randomUUID() : undefined;
    try {
      this.#storage?.setItem(CONSENT_KEY, JSON.stringify({ state, at: this.#consentAt, grantId: this.#consentGrantId, metaConsent: state === 'granted' && this.#metaEnabled }));
    } catch { /* Delivery checks the persisted choice again before sending. */ }
    if (state === 'denied') {
      this.#disableProviders();
    }
    if (changed) this.track('dk_consent_update', { state });
    this.#notify();
    if (state === 'granted') await this.#enableProviders();
  }

  async #enableProviders() {
    const generation = this.#generation;
    const allowed = () => {
      this.syncConsent();
      return this.consent === 'granted' && generation === this.#generation;
    };
    await Promise.allSettled(this.#providers.map(async provider => {
      if (!provider.adapter.configured || provider.status === 'ready') return;
      if (provider.status === 'loading' && provider.initializingGeneration === generation) return provider.pending;
      provider.status = 'loading';
      provider.initializingGeneration = generation;
      this.#notify();
      const previous = provider.pending || Promise.resolve();
      provider.pending = previous.then(async () => {
        if (!allowed()) return;
        try {
          const ready = await provider.adapter.initialize(allowed);
          if (!allowed()) return;
          provider.status = ready ? 'ready' : 'error';
          if (ready) for (const record of this.#records) this.#deliver(provider, record);
        } catch {
          if (allowed()) provider.status = 'error';
        }
        this.#notify();
      });
      return provider.pending;
    }));
  }

  async flush() {
    this.syncConsent();
    if (this.consent !== 'granted') return;
    await Promise.allSettled(this.#providers.filter(p => p.status === 'ready').map(p => p.adapter.flush?.()));
  }

  newJourney() {
    this.#journeyId = this.#uuid();
    this.#sequence = 0;
    this.resumed = false;
    this.endJourney();
    this.#ended = false;
    this.setStep('email', 1);
  }

  endJourney() {
    this.#ended = true;
    try { this.#journeyStorage?.removeItem(JOURNEY_KEY); } catch {}
  }

  clearLocalRecords() {
    this.#records = [];
    this.#notify();
  }

  snapshot() {
    return {
      consent: this.consent,
      journeyId: this.#journeyId,
      providers: this.#providers.map(p => ({ id: p.adapter.id, status: p.status })),
      records: this.#records.map(r => ({ event: r.event, consent: r.consent, delivery: { ...r.delivery } })),
    };
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  #notify() {
    for (const listener of this.#listeners) {
      try { listener(this.snapshot()); } catch { /* Diagnostics must not interrupt the form. */ }
    }
  }
}
