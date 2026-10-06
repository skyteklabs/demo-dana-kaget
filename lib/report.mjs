import { STEPS, FIELDS } from '../public/form-schema.js';

export const DROPOFF_MS = 30 * 60_000;

export function buildReport(events, now = Date.now()) {
  const groups = new Map();
  for (const event of events) {
    const id = event.properties.journey_id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(event);
  }
  const steps = STEPS.map(step => ({ id: step.id, title: step.title, viewed: 0, attempted: 0, continued: 0, dropoffs: 0 }));
  const fields = Object.entries(FIELDS).map(([id, field]) => ({ id, label: field.label, hovered: 0, focused: 0, typed: 0, valid: 0, errors: 0, continued: 0, lastAtDrop: 0, focusMs: 0, focusSessions: 0 }));
  const journeys = [];
  for (const [id, raw] of groups) {
    const list = raw.toSorted((a, b) => a.properties.sequence - b.properties.sequence || a.at - b.at);
    const flow = list.filter(e => e.name !== 'dk_consent_update' && e.name !== 'dk_click');
    if (!flow.length) continue;
    const last = flow.at(-1);
    const completed = list.some(e => e.name === 'dk_claim_success');
    const restarted = list.some(e => e.name === 'dk_form_reset');
    const lastActivity = Math.max(...list.map(e => e.received_at));
    const quiet = now - lastActivity >= DROPOFF_MS;
    const pendingExit = ['dk_form_exit', 'dk_visibility'].includes(last.name) && last.properties.state !== 'visible';
    const state = completed ? 'completed' : restarted ? 'restarted' : quiet ? 'dropoff' : pendingExit ? 'away' : 'active';
    const stepId = last.properties.step_id;
    const lastField = last.properties.last_field_id || [...flow].reverse().find(e => e.properties.field_id && e.properties.step_id === stepId)?.properties.field_id || null;
    const started = list.some(e => e.name === 'dk_form_start');
    for (const step of steps) {
      if (list.some(e => e.name === 'dk_step_view' && e.properties.step_id === step.id)) step.viewed++;
      if (list.some(e => e.name === 'dk_step_submit' && e.properties.step_id === step.id)) step.attempted++;
      if (list.some(e => e.name === 'dk_step_complete' && e.properties.step_id === step.id)) step.continued++;
      if (state === 'dropoff' && stepId === step.id) step.dropoffs++;
    }
    for (const field of fields) {
      const own = list.filter(e => e.properties.field_id === field.id);
      const has = name => own.some(e => e.name === name);
      if (has('dk_field_hover')) field.hovered++;
      if (has('dk_field_focus')) field.focused++;
      if (has('dk_field_input') || has('dk_field_change')) field.typed++;
      if (has('dk_field_valid')) field.valid++;
      if (has('dk_validation_error')) field.errors++;
      const step = STEPS.find(s => s.fields.includes(field.id));
      if (list.some(e => e.name === 'dk_step_complete' && e.properties.step_id === step.id)) field.continued++;
      if (state === 'dropoff' && lastField === field.id) field.lastAtDrop++;
      for (const event of own.filter(e => e.name === 'dk_field_blur')) {
        field.focusMs += event.properties.duration_ms || 0;
        field.focusSessions++;
      }
    }
    journeys.push({ id, state, started, step: stepId, lastField, events: list.length, lastActivity, timeline: list });
  }
  return {
    generatedAt: now, dropoffMinutes: DROPOFF_MS / 60_000,
    totals: { journeys: journeys.length, started: journeys.filter(j => j.started).length, completed: journeys.filter(j => j.state === 'completed').length, dropoffs: journeys.filter(j => j.state === 'dropoff').length },
    outcomes: ['dk_code_request', 'dk_code_resend', 'dk_captcha_success', 'dk_captcha_error', 'dk_email_accepted', 'dk_email_failed', 'dk_claim_attempt', 'dk_claim_failed', 'dk_claim_success', 'dk_reward_copy', 'dk_reward_open'].map(name => ({ name, events: events.filter(e => e.name === name).length, journeys: new Set(events.filter(e => e.name === name).map(e => e.properties.journey_id)).size })),
    failures: [...new Set(events.map(e => e.properties.error_code).filter(Boolean))].map(code => ({ code, events: events.filter(e => e.properties.error_code === code).length, journeys: new Set(events.filter(e => e.properties.error_code === code).map(e => e.properties.journey_id)).size })),
    steps, fields: fields.map(f => ({ ...f, averageFocusMs: f.focusSessions ? Math.round(f.focusMs / f.focusSessions) : 0 })),
    journeys: journeys.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 100),
  };
}
