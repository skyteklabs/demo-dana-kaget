import { createHash, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { fail } from './claims.mjs';

const reportPaths = new Set(['/analytics', '/analytics/', '/report.html', '/api/report', '/api/events/export']);
const digest = value => createHash('sha256').update(value).digest();
const normalizeIP = value => typeof value === 'string' && value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;

export function createHttpSecurity(env, config) {
  const trusted = new BlockList();
  for (const entry of (env.TRUSTED_PROXY_CIDRS || '').split(',').map(value => value.trim()).filter(Boolean)) {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) throw fail('invalid_proxy_configuration', 503);
    if (prefix === undefined) trusted.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
    else trusted.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  }
  const isTrusted = address => {
    const family = isIP(address);
    return family !== 0 && trusted.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };
  const user = env.REPORTS_USER || '';
  const password = env.REPORTS_PASSWORD || '';
  if ((user || password) && (!user || /[:\x00-\x1f\x7f]/.test(user) || user.length > 128 || password.length < 32 || password.length > 1024)) throw fail('invalid_reports_configuration', 503);
  const expected = user && password ? digest(`${user}:${password}`) : null;
  const origin = new URL(config.origin);
  const hosts = new Set([origin.host]);
  if (config.local && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) hosts.add(hostname + (origin.port ? `:${origin.port}` : ''));
  }
  return {
    reportsAvailable: config.local || Boolean(expected),
    isReportPath: pathname => reportPaths.has(pathname),
    validHost: host => typeof host === 'string' && hosts.has(host.toLowerCase()),
    validOrigin(value) {
      if (!value) return config.local;
      try {
        const candidate = new URL(value);
        return candidate.origin === value && candidate.protocol === origin.protocol && hosts.has(candidate.host);
      } catch { return false; }
    },
    authorizeReport(header) {
      if (!expected) return config.local ? 200 : 404;
      if (typeof header !== 'string' || header.length > 2048 || !/^Basic [a-z0-9+/]+={0,2}$/i.test(header)) return 401;
      const supplied = Buffer.from(header.slice(6), 'base64').toString('utf8');
      return timingSafeEqual(digest(supplied), expected) ? 200 : 401;
    },
    clientIP(request) {
      const peer = normalizeIP(request.socket?.remoteAddress || '127.0.0.1');
      if (!isTrusted(peer)) return peer;
      const value = request.headers['x-forwarded-for'];
      if (!value) return peer;
      if (typeof value !== 'string' || value.length > 1024) throw fail('invalid_forwarded_address');
      const addresses = value.split(',').map(value => normalizeIP(value.trim()));
      if (addresses.length > 16 || addresses.some(value => !isIP(value))) throw fail('invalid_forwarded_address');
      let address = peer;
      for (let i = addresses.length - 1; i >= 0 && isTrusted(address); i--) address = addresses[i];
      return address;
    },
    headers: {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'x-frame-options': 'DENY',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'content-security-policy': [
        "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
        "script-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com",
        "style-src 'self' 'unsafe-inline'",
        "frame-src https://challenges.cloudflare.com",
        "connect-src 'self' https://challenges.cloudflare.com https://sdk.sqd.link https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://www.googletagmanager.com",
        "img-src 'self' data: https://*.google-analytics.com https://www.googletagmanager.com",
      ].join('; '),
      ...(config.local ? {} : { 'strict-transport-security': 'max-age=31536000' }),
    },
  };
}

export function createRequestLimiter({ clock = Date.now, maxKeys = 10_000 } = {}) {
  const entries = new Map();
  let lastSweep = 0;
  return {
    check(key, maximum, weight = 1) {
      const now = clock();
      if (now - lastSweep >= 60_000) {
        for (const [id, entry] of entries) if (entry.until <= now) entries.delete(id);
        lastSweep = now;
      }
      let entry = entries.get(key);
      if (entry?.until <= now) { entries.delete(key); entry = null; }
      if (!entry) {
        if (entries.size >= maxKeys) return 60;
        entry = { count: 0, until: now + 60_000 };
        entries.set(key, entry);
      }
      if (entry.count + weight > maximum) return Math.max(1, Math.ceil((entry.until - now) / 1000));
      entry.count += weight;
      return 0;
    },
  };
}
