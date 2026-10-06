import { isIP } from 'node:net';
import { UUID_PATTERN } from '../public/analytics/events.js';

const RETAIN_IDS_MS = 48 * 60 * 60 * 1000;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_NAMES = new Set(['PageView', 'CompleteRegistration']);

export function metaConfig(env = process.env, origin) {
  const pixelId = env.META_PIXEL_ID || '';
  const accessToken = env.META_ACCESS_TOKEN || '';
  const apiVersion = env.META_API_VERSION || 'v26.0';
  const testEventCode = env.META_TEST_EVENT_CODE || '';
  const invalid = () => Object.assign(new Error('invalid_meta_configuration'), { code: 'invalid_meta_configuration', status: 503 });
  if (typeof pixelId !== 'string' || typeof accessToken !== 'string' || typeof apiVersion !== 'string' || typeof testEventCode !== 'string'
      || Boolean(pixelId) !== Boolean(accessToken)
      || (pixelId && !/^\d{1,32}$/.test(pixelId))
      || (accessToken && !/^[\x21-\x7e]{1,8192}$/.test(accessToken))
      || !/^v[1-9]\d{0,2}\.0$/.test(apiVersion)
      || (testEventCode && !/^[A-Za-z0-9_-]{1,100}$/.test(testEventCode))) throw invalid();
  let source;
  try { source = new URL(origin); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin || source.username || source.password) throw invalid();
  return { enabled: Boolean(pixelId && accessToken), pixelId, accessToken, apiVersion, testEventCode, sourceUrl: `${source.origin}/dana-kaget` };
}

export function createMetaConversions(config, { fetcher = fetch, clock = Date.now, maxInflight = 8, maxSeen = 10_000, timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(maxInflight) || maxInflight < 1 || maxInflight > 64
      || !Number.isSafeInteger(maxSeen) || maxSeen < 1 || maxSeen > 100_000
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError('Invalid Meta delivery limits');
  const active = new Set();
  const seen = new Map();
  const counters = { attempted: 0, accepted: 0, failed: 0, dropped: 0, duplicates: 0 };
  const increment = key => { counters[key] = Math.min(Number.MAX_SAFE_INTEGER, counters[key] + 1); };

  async function transmit(event) {
    try {
      const response = await fetcher(`https://graph.facebook.com/${config.apiVersion}/${config.pixelId}/events`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.accessToken}` },
        body: JSON.stringify({ data: [event], ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}) }),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error();
      }
      let length = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > 16_384) throw new Error();
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
      if (!result || Array.isArray(result) || result.events_received !== 1 || result.error) throw new Error();
      increment('accepted');
    } catch {
      // Delivery diagnostics contain counts only, never Meta responses or visitor data.
      increment('failed');
    }
  }

  return {
    send(event, context = {}) {
      if (!config.enabled) return false;
      const now = clock();
      const { ip, userAgent } = context && typeof context === 'object' ? context : {};
      if (!event || !EVENT_NAMES.has(event.name) || typeof event.id !== 'string' || !UUID_PATTERN.test(event.id)
          || !Number.isSafeInteger(event.at) || event.at < 0 || event.at < now - MAX_EVENT_AGE_MS || event.at > now + 60_000
          || typeof ip !== 'string' || !isIP(ip)
          || typeof userAgent !== 'string' || !userAgent.trim() || /[\x00-\x1f\x7f]/.test(userAgent)) {
        increment('dropped');
        return false;
      }
      for (const [id, expiresAt] of seen) if (expiresAt <= now) seen.delete(id);
      const key = `${event.name}:${event.id.toLowerCase()}`;
      if (seen.has(key)) { increment('duplicates'); return false; }
      if (active.size >= maxInflight || seen.size >= maxSeen) { increment('dropped'); return false; }
      seen.set(key, now + RETAIN_IDS_MS);
      const data = {
        event_name: event.name, event_time: Math.floor(event.at / 1000), event_id: event.id.toLowerCase(),
        action_source: 'website', event_source_url: config.sourceUrl,
        user_data: { client_ip_address: ip, client_user_agent: userAgent.slice(0, 512) },
      };
      increment('attempted');
      const pending = transmit(data).finally(() => active.delete(pending));
      active.add(pending);
      return true;
    },
    async flush() { while (active.size) await Promise.all(active); },
    snapshot: () => ({ enabled: config.enabled, ...counters, inflight: active.size, retainedIds: seen.size }),
  };
}
