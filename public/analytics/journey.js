import { STEPS } from '../form-schema.js';

// This class accepts states and fixed identifiers only; DOM values stay in the form.
export class Journey {
  constructor(tracker, { clock = Date.now } = {}) {
    this.tracker = tracker;
    this.clock = clock;
    this.reset();
  }

  reset() {
    this.step = 0;
    this.started = false;
    this.finished = false;
    this.lastField = undefined;
    this.focused = undefined;
    this.states = new Map();
    this.visits = new Map();
    this.focusCounts = new Map();
    this.validReported = new Set();
    this.lastAction = this.clock();
    this.activeSince = this.clock();
    this.stepMs = 0;
    this.suspended = false;
    this.idle = false;
  }

  context() {
    const fields = STEPS[this.step].fields;
    return {
      step_visit: this.visits.get(this.step) || 1,
      last_field_id: this.lastField,
      filled_count: fields.filter(id => this.states.get(id)?.filled).length,
      valid_count: fields.filter(id => this.states.get(id)?.valid).length,
      progress_percent: Math.round(this.step / STEPS.length * 100),
    };
  }

  emit(name, properties = {}) {
    return this.tracker.track(name, { ...this.context(), ...properties });
  }

  enter(index, reason = 'navigation') {
    this.blur('navigation');
    this.step = index;
    this.stepMs = 0;
    this.lastField = undefined;
    this.activeSince = this.suspended || this.idle ? null : this.clock();
    this.visits.set(index, (this.visits.get(index) || 0) + 1);
    this.tracker.setStep(STEPS[index].id, index + 1);
    this.emit('dk_step_view', { reason });
  }

  activity(start = true) {
    if (this.finished) return;
    if (this.idle) {
      this.idle = false;
      this.activeSince = this.suspended ? null : this.clock();
      this.emit('dk_form_resume', { reason: 'idle' });
    }
    this.lastAction = this.clock();
    if (!this.started && start) {
      this.started = true;
      this.emit('dk_form_start');
    }
  }

  focus(id, state, interaction = 'unknown') {
    this.activity();
    this.blur('user');
    this.lastField = id;
    this.states.set(id, state);
    this.focused = { id, since: this.clock(), inputs: 0 };
    this.focusCounts.set(id, (this.focusCounts.get(id) || 0) + 1);
    this.emit('dk_field_focus', { field_id: id, state: state.filled ? 'filled' : 'empty', interaction, focus_count: this.focusCounts.get(id) });
  }

  blur(reason = 'user') {
    if (!this.focused) return;
    const { id, since, inputs } = this.focused;
    this.focused = undefined;
    this.emit('dk_field_blur', { field_id: id, state: this.states.get(id)?.filled ? 'filled' : 'empty', duration_ms: this.clock() - since, input_count: inputs, reason });
  }

  hover(id) {
    this.emit('dk_field_hover', { field_id: id });
  }

  input(id, state) {
    this.activity();
    this.lastField = id;
    this.states.set(id, state);
    if (!state.valid) this.validReported.delete(id);
    if (this.focused?.id === id) this.focused.inputs++;
  }

  edited(id, type = 'dk_field_input') {
    this.emit(type, { field_id: id, state: this.states.get(id)?.filled ? 'filled' : 'empty', input_count: this.focused?.id === id ? this.focused.inputs : 0 });
  }

  validated(id, error, { reportError = true } = {}) {
    const state = this.states.get(id) || { filled: false };
    const previous = this.validReported.has(id);
    state.valid = !error;
    this.states.set(id, state);
    if (error) {
      this.validReported.delete(id);
      if (reportError) this.emit('dk_validation_error', { field_id: id, error_code: error });
    } else if (!previous) {
      this.validReported.add(id);
      this.emit('dk_field_valid', { field_id: id, state: 'valid' });
    }
  }

  timeSpent() {
    return this.stepMs + (this.activeSince === null ? 0 : this.clock() - this.activeSince);
  }

  submit(errors) {
    this.activity();
    this.blur('navigation');
    this.emit('dk_step_submit', { error_count: errors, duration_ms: this.timeSpent() });
  }

  continued() {
    this.emit('dk_step_complete', { duration_ms: this.timeSpent(), progress_percent: Math.round((this.step + 1) / STEPS.length * 100) });
  }

  pause(reason) {
    this.blur(reason);
    if (this.activeSince !== null) this.stepMs += this.clock() - this.activeSince;
    this.activeSince = null;
  }

  visibility(hidden) {
    if (this.finished) return;
    this.suspended = hidden;
    if (hidden) this.pause('visibility');
    else { this.idle = false; this.activeSince = this.clock(); this.lastAction = this.clock(); }
    this.emit('dk_visibility', { state: hidden ? 'hidden' : 'visible', reason: 'visibility' });
    if (!hidden) this.emit('dk_form_resume', { reason: 'visibility' });
  }

  tick() {
    if (this.finished || this.suspended) return;
    if (this.clock() - this.lastAction >= 60_000) {
      if (!this.idle) {
        this.pause('idle');
        this.idle = true;
        this.emit('dk_form_idle', { reason: 'idle', duration_ms: 60_000 });
      }
    } else this.emit('dk_heartbeat', { duration_ms: this.timeSpent() });
  }

  exit() {
    if (this.finished) return;
    this.pause('pagehide');
    this.emit('dk_form_exit', { reason: 'pagehide', duration_ms: this.timeSpent() });
  }

  complete(recovered = false) {
    this.emit('dk_claim_success', { progress_percent: 100, state: recovered ? 'recovered' : 'new' });
    this.finished = true;
    this.tracker.endJourney();
  }
}
