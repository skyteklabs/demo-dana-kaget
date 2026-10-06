import { fail } from './claims.mjs';

export const TEST_SITE_KEY = '1x00000000000000000000AA';
export const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';
export function claimConfig(env = process.env) {
  const mode = env.APP_MODE || 'local';
  if (!['local', 'live'].includes(mode)) throw fail('invalid_app_mode', 503);
  const local = mode === 'local';
  const config = {
    mode, local, siteKey: env.TURNSTILE_SITE_KEY || (local ? TEST_SITE_KEY : ''),
    secretKey: env.TURNSTILE_SECRET_KEY || (local ? TEST_SECRET_KEY : ''),
    origin: env.PUBLIC_ORIGIN || 'http://localhost:4173',
    kirimDomain: env.KIRIM_EMAIL_DOMAIN || '',
    kirimUsername: env.KIRIM_EMAIL_USERNAME || '', kirimPassword: env.KIRIM_EMAIL_PASSWORD || '',
    from: env.EMAIL_FROM || 'Dana Kaget <noreply@example.test>',
    mailpitUrl: env.MAILPIT_URL || 'http://127.0.0.1:8025',
    secret: env.CLAIM_SECRET,
  };
  let origin;
  try { origin = new URL(config.origin); } catch { throw fail('invalid_public_origin', 503); }
  if (origin.origin !== config.origin || origin.username || origin.password) throw fail('invalid_public_origin', 503);
  config.hostname = origin.hostname;
  if (!local && (!config.siteKey || !config.secretKey || /^[123]x0/.test(config.siteKey) || /^[123]x0/.test(config.secretKey)
    || !config.kirimDomain || !config.kirimUsername || !config.kirimPassword
    || !env.EMAIL_FROM || !env.CLAIM_SECRET || env.CLAIM_SECRET.length < 32 || origin.protocol !== 'https:')) throw fail('live_configuration_missing', 503);
  return config;
}

export function delivery(config, { fetcher = fetch } = {}) {
  return {
    async verify(token) {
      if (typeof token !== 'string' || !token || token.length > 2048) throw fail('captcha_required');
      let result;
      try {
        const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ secret: config.secretKey, response: token }),
        });
        if (!response.ok || !response.body) throw new Error();
        let length = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          length += chunk.byteLength;
          if (length > 16_384) throw new Error();
          chunks.push(chunk);
        }
        result = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
        if (!result || Array.isArray(result) || typeof result.success !== 'boolean') throw new Error();
      } catch { throw fail('captcha_unavailable', 503); }
      const testing = config.local && config.secretKey === TEST_SECRET_KEY;
      if (result.success !== true) throw fail('captcha_invalid');
      if (!testing && (typeof result.action !== 'string' || typeof result.hostname !== 'string')) throw fail('captcha_unavailable', 503);
      if (!testing && (result.action !== 'request_code' || result.hostname !== config.hostname)) throw fail('captcha_invalid');
    },
    async send({ email, code }) {
      const subject = 'Kode verifikasi Dana Kaget';
      const text = `Kode verifikasi Dana Kaget Anda: ${code}\n\nBerlaku selama 10 menit. Kembali ke halaman Dana Kaget, masukkan kode ini, lalu tekan Claim untuk mendapatkan kode DANA Anda.\n\nKode ini hanya untuk verifikasi email di halaman tersebut, bukan kode login atau PIN DANA. Jangan bagikan kode ini. Jika Anda tidak meminta kode ini, abaikan email ini.`;
      try {
        const endpoint = config.local ? `${config.mailpitUrl}/api/v1/send` : 'https://smtp-app.kirim.email/api/v4/transactional/message';
        const headers = config.local ? { 'content-type': 'application/json' } : {
          'content-type': 'application/x-www-form-urlencoded',
          domain: config.kirimDomain,
          authorization: `Basic ${Buffer.from(`${config.kirimUsername}:${config.kirimPassword}`, 'utf8').toString('base64')}`,
        };
        const body = config.local
          ? JSON.stringify({ From: { Email: 'noreply@example.test', Name: 'Dana Kaget (lokal)' }, To: [{ Email: email }], Subject: subject, Text: text })
          : new URLSearchParams({ from: config.from, to: email, subject, text }).toString();
        const response = await fetcher(endpoint, {
          method: 'POST', signal: AbortSignal.timeout(15_000), redirect: 'error', headers, body,
        });
        if (!response.ok) throw new Error();
      } catch { throw fail('email_unavailable', 503); }
    },
  };
}
