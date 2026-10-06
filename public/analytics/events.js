export const EVENT_NAMES = Object.freeze([
  'dk_page_view', 'dk_form_view', 'dk_form_start', 'dk_field_focus',
  'dk_field_input', 'dk_field_change', 'dk_field_blur', 'dk_field_paste',
  'dk_field_hover', 'dk_field_valid', 'dk_validation_error', 'dk_step_view',
  'dk_step_submit', 'dk_step_complete', 'dk_step_back', 'dk_click',
  'dk_scroll', 'dk_visibility', 'dk_form_exit', 'dk_form_resume',
  'dk_form_reset', 'dk_consent_update', 'dk_form_idle', 'dk_heartbeat',
  'dk_captcha_ready', 'dk_captcha_success', 'dk_captcha_expired', 'dk_captcha_error', 'dk_captcha_reset',
  'dk_code_request', 'dk_code_resend', 'dk_email_accepted', 'dk_email_failed',
  'dk_code_expired', 'dk_claim_attempt', 'dk_claim_failed', 'dk_claim_success',
  'dk_reward_copy', 'dk_reward_copy_failed', 'dk_reward_open', 'dk_inbox_open',
]);
export const FIELD_IDS = Object.freeze(['email', 'turnstile', 'verification_code']);
const enums = {
  field_id: FIELD_IDS, last_field_id: FIELD_IDS,
  interaction: ['pointer', 'keyboard', 'programmatic', 'unknown'],
  step_id: ['email', 'verification', 'complete'],
  target_id: ['get_code', 'claim', 'resend', 'change_email', 'copy', 'open_reward', 'open_inbox', 'consent_accept', 'consent_decline', 'captcha_reset', 'restart'],
  error_code: ['required', 'invalid_format', 'invalid_email', 'captcha_required', 'captcha_invalid', 'captcha_unavailable', 'email_unavailable', 'rate_limited', 'resend_wait', 'invalid_code', 'code_expired', 'attempts_exhausted', 'invalid_request', 'session_expired', 'sold_out', 'service_unavailable', 'network_error', 'clipboard_failed'],
  state: ['empty', 'filled', 'valid', 'invalid', 'visible', 'hidden', 'granted', 'denied', 'pending', 'new', 'recovered'],
  reason: ['navigation', 'pagehide', 'visibility', 'restart', 'user', 'idle', 'reload', 'consent'],
};
const numbers = {
  step_number: [1, 3], duration_ms: [0, 86_400_000], input_count: [0, 100_000],
  error_count: [0, 30], progress_percent: [0, 100], scroll_percent: [0, 100],
  focus_count: [0, 100_000], filled_count: [0, 3], valid_count: [0, 3], step_visit: [1, 100_000],
};
// Values, email addresses, tokens, reward URLs and exception text never cross this boundary.
export function sanitizeProperties(properties = {}) {
  const safe = {};
  if (!properties || typeof properties !== 'object') return safe;
  for (const [key, values] of Object.entries(enums)) {
    if (typeof properties[key] === 'string' && values.includes(properties[key])) safe[key] = properties[key];
  }
  for (const [key, [min, max]] of Object.entries(numbers)) {
    const value = properties[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) safe[key] = Math.round(value);
  }
  return safe;
}
export function isEventName(name) { return EVENT_NAMES.includes(name); }
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
