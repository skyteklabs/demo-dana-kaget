import { AnalyticsTracker, CONSENT_KEY } from './analytics/tracker.js';
import { googleProvider, grovsProvider } from './analytics/providers.js';
import { localProvider } from './analytics/collector.js';
import { Journey } from './analytics/journey.js';
import { validateField } from './form-schema.js';
import { createRewardView } from './reward-view.js';
import { createTurnstileLoader } from './turnstile.js';

const $ = selector => document.querySelector(selector);
const storage = name => { try { return window[name]; } catch { return undefined; } };
const messages = {
  required: 'Lengkapi kolom ini.', invalid_format: 'Periksa format isian Anda.',
  invalid_email: 'Masukkan alamat email yang valid.', captcha_required: 'Selesaikan verifikasi keamanan terlebih dahulu.',
  captcha_invalid: 'Verifikasi keamanan tidak berlaku. Selesaikan kembali.',
  captcha_unavailable: 'Verifikasi keamanan belum tersedia. Muat ulang verifikasi untuk mencoba lagi.',
  email_unavailable: 'Email belum dapat dikirim. Tunggu sebentar, lalu coba lagi.',
  rate_limited: 'Batas percobaan tercapai. Coba lagi setelah waktu tunggu berakhir.',
  resend_wait: 'Tunggu sebelum meminta kode baru.', invalid_code: 'Kode belum sesuai. Periksa 6 digit dari email terbaru.',
  code_expired: 'Kode sudah kedaluwarsa. Pilih Kirim ulang kode.',
  attempts_exhausted: 'Batas 5 percobaan tercapai. Minta kode baru untuk melanjutkan.',
  invalid_request: 'Permintaan kode tidak berlaku. Minta kode baru.',
  session_expired: 'Sesi berakhir. Muat ulang halaman dan minta kode baru.',
  sold_out: 'Kode DANA sedang habis. Silakan coba lagi nanti.',
  service_unavailable: 'Layanan belum tersedia. Coba lagi nanti.',
  network_error: 'Koneksi terputus atau respons belum diterima. Coba lagi; klaim ulang tidak mengambil kode tambahan.',
};
let tracker, journey, local, config;
let step = 0, busy = false, challenge, token = '', widget, captchaSdk, reward;
let resendAt = 0, expiredReported = false, interaction = 'unknown', captchaRendering = false;
const compactCaptcha = window.matchMedia('(max-width: 374px)');
const inputTimers = new Map();
const loadCaptcha = createTurnstileLoader({ window, document });
const rewardView = createRewardView({
  qr: $('#reward-qr'), hint: $('#reward-qr-hint'), link: $('#open-reward'),
  value: $('#reward-value'), fallback: $('#reward-qr-fallback'),
}, {
  openWindow: (...args) => window.open(...args),
  onOpen: () => { event('dk_reward_open'); void local.flush({ urgent: true }); },
});

function event(name, properties = {}) { journey.emit(name, properties); }
function errorMessage(code) { return messages[code] || messages.service_unavailable; }
function showError(code, retryAfter) {
  $('#form-error').textContent = errorMessage(code) + (retryAfter ? ' Coba lagi dalam ' + retryAfter + ' detik.' : '');
  $('#form-error').hidden = false;
}
function clearError() { $('#form-error').hidden = true; $('#form-status').textContent = ''; }
function fieldState(id) {
  const value = $('#' + id).value;
  return { filled: Boolean(value.trim()), valid: !validateField(id, value) };
}
function validate(id, reportError = true) {
  const element = $('#' + id);
  const error = validateField(id, element.value);
  journey.states.set(id, fieldState(id));
  journey.validated(id, error, { reportError });
  element.setAttribute('aria-invalid', String(Boolean(error)));
  $('#' + id + '-error').hidden = !error;
  $('#' + id + '-error').textContent = error ? (id === 'verification_code' && error === 'invalid_format' ? 'Masukkan kode 6 digit.' : errorMessage(error)) : '';
  return error;
}
function drainInput() {
  for (const [id, timer] of inputTimers) { clearTimeout(timer); journey.edited(id); }
  inputTimers.clear();
}
function updateControls() {
  $('#form').setAttribute('aria-busy', String(busy));
  for (const id of ['get-code', 'claim-button', 'change-email', 'send-again', 'captcha-retry']) $('#' + id).disabled = busy;
  $('#resend').disabled = busy || Date.now() < resendAt;
  const seconds = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
  $('#resend').textContent = seconds ? 'Kirim ulang (' + seconds + ' dtk)' : 'Kirim ulang kode';
  $('#get-code').textContent = busy ? 'Mengirim…' : 'Get code';
  $('#claim-button').textContent = busy ? 'Memproses…' : 'Claim';
  $('#send-again').textContent = busy ? 'Mengirim…' : 'Kirim kode baru';
  $('#email').readOnly = busy;
  $('#verification_code').readOnly = busy;
}
function showStep(next, focus = true) {
  drainInput();
  step = next;
  $('#email-panel').hidden = next !== 0;
  $('#verify-panel').hidden = next !== 1;
  $('#form').hidden = next === 2;
  $('#success').hidden = next !== 2;
  $('#step-title').hidden = next === 2;
  $('#step-title').textContent = next === 0 ? 'Mulai dengan email Anda' : 'Cek email Anda';
  $('#captcha-region').hidden = next !== 0;
  (next === 0 ? $('#initial-captcha') : $('#resend-captcha')).append($('#captcha-region'));
  $('#resend-panel').hidden = true;
  [...$('#steps').children].forEach((node, index) => {
    node.removeAttribute('aria-current');
    if (index === next) node.setAttribute('aria-current', 'step');
    node.classList.toggle('completed', index < next);
  });
  journey.enter(next);
  if (focus) (next === 2 ? $('#success-title') : $('#step-title')).focus();
}
function captchaStatus(text) { $('#captcha-status').textContent = text; }
async function renderCaptcha() {
  if (captchaRendering) return;
  captchaRendering = true;
  try {
    captchaSdk = await loadCaptcha();
    widget = captchaSdk.render('#turnstile-widget', {
      sitekey: config.turnstileSiteKey, action: 'request_code', theme: 'light', size: compactCaptcha.matches ? 'compact' : 'flexible',
      callback: value => {
        token = value;
        journey.states.set('turnstile', { filled: true, valid: true });
        event('dk_captcha_success', { field_id: 'turnstile' });
        captchaStatus('Verifikasi keamanan selesai.');
      },
      'expired-callback': () => {
        token = ''; journey.states.set('turnstile', { filled: false, valid: false });
        event('dk_captcha_expired', { field_id: 'turnstile' });
        captchaStatus('Verifikasi kedaluwarsa. Muat ulang verifikasi.');
      },
      'error-callback': () => {
        token = ''; journey.states.set('turnstile', { filled: false, valid: false });
        event('dk_captcha_error', { field_id: 'turnstile', error_code: 'captcha_unavailable' });
        captchaStatus('Verifikasi belum berhasil. Muat ulang verifikasi.'); return true;
      },
      'timeout-callback': () => {
        token = ''; event('dk_captcha_expired', { field_id: 'turnstile' });
        captchaStatus('Waktu verifikasi habis. Muat ulang verifikasi.');
      },
    });
    event('dk_captcha_ready', { field_id: 'turnstile' });
  } catch {
    token = '';
    event('dk_captcha_error', { field_id: 'turnstile', error_code: 'captcha_unavailable' });
    captchaStatus('Cloudflare belum dapat dimuat. Periksa koneksi lalu muat ulang verifikasi.');
  } finally { captchaRendering = false; }
}
function resetCaptcha() {
  token = '';
  journey.states.set('turnstile', { filled: false, valid: false });
  captchaStatus('Selesaikan verifikasi keamanan.');
  event('dk_captcha_reset', { field_id: 'turnstile' });
  if (widget !== undefined && captchaSdk) captchaSdk.reset(widget);
  else void renderCaptcha();
}
async function api(path, body) {
  let response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  } catch { throw { code: 'network_error' }; }
  let result;
  try { result = await response.json(); } catch { throw { code: 'service_unavailable' }; }
  if (!response.ok) throw { code: messages[result.error] ? result.error : 'service_unavailable', retryAfter: result.retryAfter };
  return result;
}
async function requestCode(resending = false) {
  if (busy) return;
  drainInput(); clearError();
  journey.activity();
  event(resending ? 'dk_code_resend' : 'dk_code_request');
  const emailError = validate('email');
  if (!token) {
    event('dk_validation_error', { field_id: 'turnstile', error_code: 'captcha_required' });
    showError('captcha_required');
  }
  if (!resending) journey.submit(Number(Boolean(emailError)) + Number(!token));
  if (emailError || !token) { if (emailError) $('#email').focus(); return; }
  busy = true; updateControls();
  const started = Date.now();
  try {
    challenge = await api('/api/code/request', { email: $('#email').value.trim(), turnstileToken: token });
    resendAt = challenge.resendAt; expiredReported = false;
    $('#recipient').textContent = $('#email').value.trim();
    $('#verification_code').value = '';
    $('#verification_code').removeAttribute('aria-invalid');
    $('#verification_code-error').hidden = true;
    journey.states.delete('verification_code'); journey.validReported.delete('verification_code');
    event('dk_email_accepted', { duration_ms: Date.now() - started });
    if (!resending) { journey.continued(); showStep(1); }
    else { $('#resend-panel').hidden = true; $('#captcha-region').hidden = true; $('#verification_code').focus(); }
    $('#form-status').textContent = config.localMode ? 'Email tersedia di inbox pengujian.' : 'Permintaan email diterima. Kode berlaku 10 menit.';
  } catch (error) {
    event('dk_email_failed', { error_code: error.code, duration_ms: Date.now() - started });
    showError(error.code, error.retryAfter);
    if (error.retryAfter) resendAt = Date.now() + error.retryAfter * 1000;
  } finally { busy = false; resetCaptcha(); updateControls(); }
}
async function claim() {
  if (busy) return;
  drainInput(); clearError(); journey.activity();
  event('dk_claim_attempt');
  const invalid = validate('verification_code');
  journey.submit(Number(Boolean(invalid)));
  if (invalid) { $('#verification_code').focus(); return; }
  if (!challenge) { showError('invalid_request'); return; }
  busy = true; updateControls();
  const started = Date.now();
  try {
    const result = await api('/api/claim', { requestId: challenge.requestId, verificationCode: $('#verification_code').value.trim() });
    if (!rewardView.render(result.reward)) throw { code: 'service_unavailable' };
    reward = result.reward;
    journey.continued(); showStep(2); journey.continued(); journey.complete(result.recovered);
    $('#recovered').hidden = !result.recovered;
    $('#demo-reward').hidden = !reward.value.startsWith('DEMO-NOT-REDEEMABLE-');
    $('#copy').textContent = reward.kind === 'link' ? 'Salin tautan' : 'Salin kode';
    $('#email').value = ''; $('#verification_code').value = '';
    void tracker.flush();
  } catch (error) {
    event('dk_claim_failed', { error_code: error.code, duration_ms: Date.now() - started });
    showError(error.code, error.retryAfter);
    if (['invalid_code', 'code_expired', 'attempts_exhausted'].includes(error.code)) {
      event('dk_validation_error', { field_id: 'verification_code', error_code: error.code });
      $('#verification_code').setAttribute('aria-invalid', 'true');
      $('#verification_code').focus();
    }
  } finally { busy = false; updateControls(); }
}
function inspector(snapshot) {
  $('#journey-id').textContent = snapshot.journeyId;
  $('#event-list').replaceChildren(...snapshot.records.slice(-20).reverse().map(({ event: record }) => {
    const item = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = record.name;
    const details = document.createElement('pre'); details.textContent = JSON.stringify(record.properties, null, 2);
    item.append(title, details); return item;
  }));
}
async function chooseConsent(state) {
  const changed = tracker.consent !== state;
  await tracker.setConsent(state);
  $('#consent-status').textContent = state === 'granted' ? 'Analitik diizinkan. Anda dapat menonaktifkannya kapan saja.' : 'Analitik dinonaktifkan. Klaim tetap dapat dilanjutkan.';
  if (state === 'granted' && changed) {
    event('dk_form_view', { reason: 'consent' });
    event('dk_step_view', { reason: 'consent' });
    if (journey.started && !journey.finished) event('dk_form_start', { reason: 'consent' });
  }
}
function bind() {
  compactCaptcha.addEventListener('change', () => {
    if (widget !== undefined && captchaSdk) captchaSdk.remove(widget);
    widget = undefined; resetCaptcha();
  });
  document.addEventListener('pointerdown', () => { interaction = 'pointer'; }, true);
  document.addEventListener('keydown', () => { interaction = 'keyboard'; }, true);
  for (const id of ['email', 'verification_code']) {
    const field = $('#' + id);
    let hoverAt = 0;
    field.addEventListener('pointerenter', () => { if (Date.now() - hoverAt > 1000) { journey.hover(id); hoverAt = Date.now(); } });
    field.addEventListener('focus', () => journey.focus(id, fieldState(id), interaction));
    field.addEventListener('input', () => {
      journey.input(id, fieldState(id));
      clearTimeout(inputTimers.get(id));
      inputTimers.set(id, setTimeout(() => { journey.edited(id); inputTimers.delete(id); }, 500));
    });
    field.addEventListener('change', () => { drainInput(); journey.input(id, fieldState(id)); journey.edited(id, 'dk_field_change'); });
    field.addEventListener('paste', () => event('dk_field_paste', { field_id: id }));
    field.addEventListener('blur', () => { drainInput(); journey.blur(); if (field.value) validate(id); });
  }
  document.addEventListener('click', e => {
    const target = e.target.closest('[data-target]');
    if (target && !target.disabled) { journey.activity(); event('dk_click', { target_id: target.dataset.target }); }
  });
  $('#form').addEventListener('submit', e => { e.preventDefault(); void (step === 0 ? requestCode() : claim()); });
  $('#resend').addEventListener('click', () => {
    if (busy || Date.now() < resendAt) return;
    clearError(); $('#resend-panel').hidden = false; $('#captcha-region').hidden = false; resetCaptcha();
  });
  $('#send-again').addEventListener('click', () => void requestCode(true));
  $('#captcha-retry').addEventListener('click', resetCaptcha);
  $('#change-email').addEventListener('click', () => {
    if (busy) return;
    event('dk_step_back'); challenge = undefined; clearError(); showStep(0); resetCaptcha(); $('#email').focus();
  });
  $('#local-inbox').addEventListener('click', () => event('dk_inbox_open'));
  $('#open-reward').addEventListener('click', () => rewardView.open());
  $('#copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(reward.value);
      event('dk_reward_copy'); $('#copy-status').textContent = 'Tersalin.';
    } catch {
      event('dk_reward_copy_failed', { error_code: 'clipboard_failed' });
      $('#copy-status').textContent = 'Belum dapat disalin. Pilih kode di atas dan salin secara manual.';
    }
  });
  $('#restart').addEventListener('click', () => {
    event('dk_form_reset'); tracker.newJourney(); journey.reset();
    reward = undefined; challenge = undefined; clearError();
    rewardView.clear(); $('#copy-status').textContent = '';
    showStep(0); resetCaptcha();
  });
  $('#accept').addEventListener('click', () => void chooseConsent('granted'));
  $('#decline').addEventListener('click', () => void chooseConsent('denied'));
  tracker.subscribe(snapshot => { if ($('#inspector').open) inspector(snapshot); });
  $('#inspector').addEventListener('toggle', () => { if ($('#inspector').open) inspector(tracker.snapshot()); });
  document.addEventListener('visibilitychange', () => {
    drainInput(); journey.visibility(document.hidden);
    if (document.hidden) { void local.flush({ urgent: true }); void tracker.flush(); }
    else {
      const active = document.activeElement;
      if (['email', 'verification_code'].includes(active?.id)) journey.focus(active.id, fieldState(active.id), 'programmatic');
    }
  });
  window.addEventListener('pagehide', () => { drainInput(); journey.exit(); void local.flush({ urgent: true }); void tracker.flush(); });
  window.addEventListener('pageshow', e => { if (e.persisted) journey.visibility(false); });
  window.addEventListener('online', () => void tracker.flush());
  window.addEventListener('storage', e => {
    if (e.key !== CONSENT_KEY && e.key !== null) return;
    tracker.syncConsent();
    if (tracker.consent !== 'granted') $('#consent-status').textContent = 'Analitik dinonaktifkan. Klaim tetap dapat dilanjutkan.';
  });
  let lastScroll = -1;
  window.addEventListener('scroll', () => {
    if (journey.finished) return;
    journey.activity(false);
    const height = document.documentElement.scrollHeight - window.innerHeight;
    const percent = height > 0 ? Math.min(100, Math.floor(window.scrollY / height * 4) * 25) : 100;
    if (percent > lastScroll) { lastScroll = percent; event('dk_scroll', { scroll_percent: percent }); }
  }, { passive: true });
  setInterval(() => { journey.tick(); void tracker.flush(); }, 15_000);
  setInterval(() => {
    updateControls();
    if (challenge && step === 1) {
      const left = Math.max(0, Math.ceil((challenge.expiresAt - Date.now()) / 1000));
      $('#expiry').textContent = left ? 'Kode berlaku ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' lagi.' : messages.code_expired;
      if (!left && !expiredReported) { expiredReported = true; event('dk_code_expired'); }
    }
    const status = local.snapshot();
    $('#delivery-status').textContent = 'Server: ' + status.status + ' · diterima ' + status.acknowledged + ' · antrean ' + status.pending;
  }, 1000);
}
async function main() {
  const response = await fetch('/api/config', { credentials: 'same-origin' });
  if (!response.ok) throw new Error();
  config = await response.json();
  local = localProvider({ storage: storage('sessionStorage') });
  tracker = new AnalyticsTracker({ storage: storage('localStorage'), journeyStorage: storage('sessionStorage'), providers: [local, googleProvider(config, { window, document }), grovsProvider(config)] });
  journey = new Journey(tracker);
  $('#local-notice').hidden = !config.localMode;
  $('#local-inbox').hidden = !config.localMode;
  $('#reports-link').hidden = !config.reportsAvailable;
  $('#inspector').hidden = !config.debug;
  bind();
  if (tracker.consent !== 'pending') void chooseConsent(tracker.consent);
  void tracker.start();
  event('dk_page_view'); event('dk_form_view'); showStep(0, false);
  if (tracker.resumed) event('dk_form_resume', { reason: 'reload' });
  updateControls();
  await renderCaptcha();
}
main().catch(() => {
  $('#load-error').hidden = false;
  $('#load-error').textContent = 'Layanan belum dapat dimuat. Muat ulang halaman untuk mencoba kembali.';
});
