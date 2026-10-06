import { fail, normalizeEmail } from './claims.mjs';

export function claimService(store, provider) {
  return {
    async request({ email, turnstileToken }, session, ip) {
      email = normalizeEmail(email);
      const retry = store.rateLimit(`request:${ip}`, 20);
      if (retry) throw fail('rate_limited', 429, retry);
      await provider.verify(turnstileToken);
      const challenge = store.prepare(email, session);
      if (!challenge.suppressed) {
        try {
          await provider.send({ email, code: challenge.code, id: challenge.id });
          store.sent(challenge.id);
        } catch (error) { store.failed(challenge.id); throw error; }
      }
      return { requestId: challenge.id, expiresAt: challenge.expiresAt, resendAt: challenge.resendAt };
    },
    claim({ requestId, verificationCode }, session, ip) {
      const retry = store.rateLimit(`claim:${ip}`, 60);
      if (retry) throw fail('rate_limited', 429, retry);
      if (typeof requestId !== 'string' || !/^[\da-f-]{36}$/i.test(requestId) || typeof verificationCode !== 'string' || !/^\d{6}$/.test(verificationCode)) throw fail('invalid_code');
      return store.claim(requestId, verificationCode, session);
    },
  };
}
