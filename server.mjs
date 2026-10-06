import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEvent, createEventStore } from './lib/event-store.mjs';
import { buildReport } from './lib/report.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createClaimStore } from './lib/claims.mjs';
import { claimConfig, delivery } from './lib/delivery.mjs';
import { claimService } from './lib/claim-service.mjs';
import { createHttpSecurity, createRequestLimiter } from './lib/http-security.mjs';
import { createMetaConversions, metaConfig } from './lib/meta-conversions.mjs';
import { CONSENT_VERSION } from './public/analytics/consent.js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const types = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export function createHandler({ store, claims, meta, env = process.env, limiter = createRequestLimiter() } = {}) {
  const config = claimConfig(env);
  const security = createHttpSecurity(env, config);
  const metaSettings = metaConfig(env, config.origin);
  const conversions = meta || createMetaConversions(metaSettings);
  const sendMeta = (event, request, ip) => {
    try { conversions.send(event, { ip, userAgent: request.headers['user-agent'] }); }
    catch { /* Ad measurement must not interrupt a claim or local analytics. */ }
  };
  const sessionName = config.local ? 'dana_session' : '__Host-dana_session';
  const sessionPattern = new RegExp(`(?:^|;\\s*)${sessionName}=([a-f0-9]{64})(?:;|$)`);
  return async function handle(request, response) {
    const send = (status, value, type = 'application/json') => {
      const body = type === 'application/json' ? JSON.stringify(value) : value;
      response.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', ...security.headers, ...(status === 413 ? { connection: 'close' } : {}) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname !== '/healthz' && !security.validHost(request.headers.host)) return send(403, { error: 'Invalid host' });
      const ip = security.clientIP(request);
      if (pathname !== '/healthz') {
        const retry = limiter.check(`http:${ip}`, 300);
        if (retry) { response.setHeader('retry-after', String(retry)); return send(429, { error: 'rate_limited', retryAfter: retry }); }
      }
      if (security.isReportPath(pathname)) {
        const status = security.authorizeReport(request.headers.authorization);
        if (status !== 200) {
          if (status === 401) response.setHeader('www-authenticate', 'Basic realm="Dana Kaget reports", charset="UTF-8"');
          return send(status, { error: status === 404 ? 'Not found' : 'Authentication required' });
        }
      }
      if (['/api/events', '/api/code/request', '/api/claim'].includes(pathname) && request.method === 'POST') {
        const origin = request.headers.origin;
        if (request.headers['sec-fetch-site'] === 'cross-site' || !security.validOrigin(origin)) return send(403, { error: 'Same-origin requests only' });
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return send(415, { error: 'JSON required' });
        let length = 0;
        const chunks = [];
        for await (const chunk of request) {
          length += Buffer.byteLength(chunk);
          if (length > 32_768) return send(413, { error: 'Batch too large' });
          chunks.push(Buffer.from(chunk));
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { error: 'Invalid JSON' }); }
        if (pathname !== '/api/events') {
          if (!claims) return send(503, { error: 'service_unavailable' });
          if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'invalid_request' });
          const session = request.headers.cookie?.match(sessionPattern)?.[1];
          if (!session) return send(401, { error: 'session_expired' });
          const result = pathname === '/api/code/request' ? await claims.request(body, session, ip) : await claims.claim(body, session, ip);
          if (pathname === '/api/claim' && result.recovered === false && metaSettings.enabled
              && body.analyticsConsent === 'granted' && body.consentVersion === CONSENT_VERSION) {
            sendMeta({ name: 'CompleteRegistration', id: randomUUID(), at: Date.now() }, request, ip);
          }
          return send(200, result);
        }
        if (!body || body.consent !== 'granted') return send(403, { error: 'Consent required' });
        if (!Array.isArray(body.events) || !body.events.length || body.events.length > 20) return send(400, { error: 'Send 1 to 20 events' });
        const retry = limiter.check(`events:${ip}`, 600, body.events.length);
        if (retry) { response.setHeader('retry-after', String(retry)); return send(429, { error: 'rate_limited', retryAfter: retry }); }
        const accepted = await store.append(body.events);
        if (metaSettings.enabled && body.metaConsent === true && body.consentVersion === CONSENT_VERSION) {
          for (const raw of body.events) {
            if (raw?.name !== 'dk_page_view') continue;
            const event = cleanEvent(raw);
            if (event) sendMeta({ name: 'PageView', id: event.id, at: event.at }, request, ip);
          }
        }
        return send(200, { accepted });
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('allow', 'GET, HEAD');
        return send(405, { error: 'Method not allowed' });
      }
      if (pathname === '/healthz') return send(200, { status: 'ok' });
      if (pathname === '/api/config') {
        if (!sessionPattern.test(request.headers.cookie || '')) {
          response.setHeader('set-cookie', `${sessionName}=${randomBytes(32).toString('hex')}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${config.local ? '' : '; Secure'}`);
        }
        return send(200, {
        ga4MeasurementId: env.GA4_MEASUREMENT_ID || '', grovsApiKey: env.GROVS_API_KEY || '',
        grovsTestEnvironment: env.GROVS_TEST_ENVIRONMENT !== 'false', debug: env.ANALYTICS_DEBUG !== 'false',
        turnstileSiteKey: config.siteKey, localMode: config.local, reportsAvailable: security.reportsAvailable,
        metaConversionsEnabled: metaSettings.enabled,
      });
      }
      if (pathname === '/api/report') return send(200, { ...buildReport(store.all()), meta: conversions.snapshot() });
      if (pathname === '/api/events/export') {
        response.setHeader('content-disposition', 'attachment; filename="dana-kaget-events.json"');
        return send(200, store.all());
      }
      if (pathname.startsWith('/api/')) return send(404, { error: 'Not found' });
      const aliases = { '/': 'index.html', '/dana-kaget': 'index.html', '/dana-kaget/': 'index.html', '/bpu': 'index.html', '/bpu/': 'index.html', '/analytics': 'report.html', '/analytics/': 'report.html' };
      const requested = aliases[pathname] || pathname.slice(1);
      if (requested.split(/[\\/]/).some(part => part.startsWith('.')) || requested.includes('\0')) return send(404, { error: 'Not found' });
      let file;
      try { file = await realpath(resolve(root, requested)); } catch { return send(404, { error: 'Not found' }); }
      const subpath = relative(await realpath(root), file);
      if (subpath === '..' || subpath.startsWith(`..${sep}`)) return send(404, { error: 'Not found' });
      try { return send(200, await readFile(file), types[extname(file)] || 'application/octet-stream'); }
      catch { return send(404, { error: 'Not found' }); }
    } catch (error) {
      const status = error instanceof URIError ? 400 : error.status || 500;
      if (error.retryAfter) response.setHeader('retry-after', String(error.retryAfter));
      if (error.status && /^[a-z_]+$/.test(error.code || '')) return send(status, { error: error.code, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
      send(status, { error: status === 500 ? 'Server unavailable' : status === 507 ? 'Local demo store is full' : 'Invalid request' });
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const store = await createEventStore(resolve(process.env.DATA_DIR || './data'));
  const config = claimConfig();
  const inventory = await createClaimStore(resolve(process.env.DATA_DIR || './data'), config);
  const claims = claimService(inventory, delivery(config));
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5000, maxHeaderSize: 8192 }, createHandler({ store, claims }));
  server.maxRequestsPerSocket = 100;
  server.setTimeout(35_000, socket => socket.destroy());
  server.on('error', error => { console.error(`Cannot start server: ${error.code}`); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Dana Kaget: http://${host}:${port}/dana-kaget | Analytics: /analytics | Mode: ${config.mode}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => inventory.close()));
}
