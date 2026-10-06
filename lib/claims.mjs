import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { isRewardLink } from '../public/reward.js';

export const OTP_TTL = 10 * 60_000;
export const RESEND_WAIT = 60_000;
export function fail(code, status = 400, retryAfter) {
  return Object.assign(new Error(code), { code, status, retryAfter });
}
export function normalizeEmail(value) {
  if (typeof value !== 'string') throw fail('invalid_email');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)) throw fail('invalid_email');
  return email;
}
export function parseRewardLink(value = '') {
  if (typeof value !== 'string') throw fail('invalid_dana_reward_link', 503);
  const link = value.trim();
  if (link && (link.length > 2048 || /[\x00-\x20\x7f]/.test(link) || !isRewardLink(link))) throw fail('invalid_dana_reward_link', 503);
  return link;
}
export function parseInventory(text) {
  const entries = text.trim().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  if (!Array.isArray(entries) || !entries.length || entries.length > 100_000) throw fail('invalid_inventory');
  return entries.map(value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\x00-\x20\x7f]/.test(value.trim())) throw fail('invalid_inventory');
    value = value.trim();
    let kind = 'code';
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      if (!isRewardLink(value)) throw fail('invalid_inventory');
      kind = 'link';
    }
    return { value, kind };
  });
}

export async function createClaimStore(directory, { secret, mode = 'local', clock = Date.now, rewardLink = '' } = {}) {
  rewardLink = parseRewardLink(rewardLink);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keyFile = join(directory, `dana-${mode}.key`);
  if (!secret) {
    try { await writeFile(keyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    secret = await readFile(keyFile, 'utf8');
  }
  if (secret.length < 32) throw fail('claim_secret_too_short', 503);
  const hash = (purpose, value) => createHmac('sha256', secret).update(`${purpose}:${value}`).digest('hex');
  const file = join(directory, `dana-${mode}.sqlite`);
  const db = new DatabaseSync(file);
  await chmod(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS rewards (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE, kind TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS claims (email_hash TEXT PRIMARY KEY, reward_id INTEGER NOT NULL UNIQUE REFERENCES rewards(id), claimed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_claims (email_hash TEXT PRIMARY KEY, value TEXT NOT NULL, claimed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, email_hash TEXT NOT NULL, session_hash TEXT NOT NULL, otp_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS challenge_email ON challenges(email_hash, created_at);
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
  `);
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const rateLimit = (identity, maximum) => transaction(() => {
    const now = clock();
    db.prepare('DELETE FROM limits WHERE start <= ?').run(now - 3_600_000);
    const key = hash('limit', identity);
    const old = db.prepare('SELECT * FROM limits WHERE key = ?').get(key);
    if (old && old.count >= maximum) return Math.ceil((old.start + 3_600_000 - now) / 1000);
    db.prepare('INSERT INTO limits VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1').run(key, now);
    return 0;
  });
  return {
    close: () => db.close(),
    rateLimit,
    import(entries) {
      return transaction(() => {
        let added = 0;
        const insert = db.prepare('INSERT OR IGNORE INTO rewards(value, kind) VALUES (?, ?)');
        for (const { value, kind } of entries) added += Number(insert.run(value, kind).changes);
        return { added, duplicates: entries.length - added };
      });
    },
    stock() { return db.prepare('SELECT COUNT(*) AS count FROM rewards WHERE id NOT IN (SELECT reward_id FROM claims)').get().count; },
    prepare(email, session) {
      const emailHash = hash('email', email);
      const sessionHash = hash('session', session);
      const decoyHash = hash('decoy', `${emailHash}:${sessionHash}`);
      const now = clock();
      return transaction(() => {
        db.prepare('DELETE FROM challenges WHERE created_at < ?').run(now - 86_400_000);
        const recent = db.prepare('SELECT created_at, session_hash FROM challenges WHERE email_hash = ? AND created_at > ? ORDER BY created_at DESC').all(emailHash, now - 3_600_000);
        const ownRecent = db.prepare('SELECT created_at FROM challenges WHERE (email_hash = ? OR email_hash = ?) AND session_hash = ? AND created_at > ? ORDER BY created_at DESC').all(emailHash, decoyHash, sessionHash, now - 3_600_000);
        if (ownRecent.length >= 3) throw fail('rate_limited', 429, Math.ceil((ownRecent.at(-1).created_at + 3_600_000 - now) / 1000));
        if (ownRecent[0] && now - ownRecent[0].created_at < RESEND_WAIT) throw fail('resend_wait', 429, Math.ceil((ownRecent[0].created_at + RESEND_WAIT - now) / 1000));
        const challenge = { id: randomUUID(), expiresAt: now + OTP_TTL, resendAt: now + RESEND_WAIT };
        const insert = (identity, code, status) => db.prepare('INSERT INTO challenges(id,email_hash,session_hash,otp_hash,created_at,expires_at,status) VALUES(?,?,?,?,?,?,?)')
          .run(challenge.id, identity, sessionHash, hash('otp', `${challenge.id}:${code}`), now, challenge.expiresAt, status);
        const suppress = () => {
          db.prepare("UPDATE challenges SET status = 'superseded' WHERE email_hash IN (?, ?) AND session_hash = ? AND status IN ('sent', 'suppressed')").run(emailHash, decoyHash, sessionHash);
          insert(decoyHash, randomBytes(32).toString('hex'), 'suppressed');
          return { ...challenge, suppressed: true };
        };
        // Another browser's email activity must not appear in throttle responses.
        if (recent.length >= 3 || (recent[0] && now - recent[0].created_at < RESEND_WAIT)) return suppress();
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        insert(emailHash, code, 'pending');
        return { ...challenge, code };
      });
    },
    sent(id) {
      transaction(() => {
        const row = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
        const decoyHash = hash('decoy', `${row.email_hash}:${row.session_hash}`);
        db.prepare("UPDATE challenges SET status = 'superseded' WHERE email_hash IN (?, ?) AND session_hash = ? AND status IN ('sent', 'suppressed')").run(row.email_hash, decoyHash, row.session_hash);
        db.prepare("UPDATE challenges SET status = 'sent' WHERE id = ?").run(id);
      });
    },
    failed(id) { db.prepare("UPDATE challenges SET status = 'failed' WHERE id = ?").run(id); },
    claim(id, code, session) {
      // Invalid attempts must commit too; returning an error avoids rolling them back.
      const result = transaction(() => {
        const row = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
        if (!row || row.session_hash !== hash('session', session) || !['sent', 'claimed', 'suppressed'].includes(row.status)) return { error: 'invalid_request' };
        if (row.expires_at <= clock()) return { error: 'code_expired' };
        if (row.attempts >= 5) return { error: 'attempts_exhausted' };
        const equal = timingSafeEqual(Buffer.from(row.otp_hash, 'hex'), Buffer.from(hash('otp', `${id}:${code}`), 'hex'));
        if (row.status === 'suppressed' || !equal) {
          db.prepare('UPDATE challenges SET attempts = attempts + 1 WHERE id = ?').run(id);
          return { error: row.attempts + 1 >= 5 ? 'attempts_exhausted' : 'invalid_code' };
        }
        let reward = db.prepare('SELECT r.value, r.kind FROM rewards r JOIN claims c ON c.reward_id = r.id WHERE c.email_hash = ?').get(row.email_hash);
        reward ||= db.prepare("SELECT value, 'link' AS kind FROM shared_claims WHERE email_hash = ?").get(row.email_hash);
        const recovered = Boolean(reward);
        if (!reward) {
          if (rewardLink) {
            reward = { value: rewardLink, kind: 'link' };
            db.prepare('INSERT INTO shared_claims VALUES (?, ?, ?)').run(row.email_hash, rewardLink, clock());
          } else {
            reward = db.prepare('SELECT id, value, kind FROM rewards WHERE id NOT IN (SELECT reward_id FROM claims) ORDER BY id LIMIT 1').get();
            if (!reward) return { error: 'sold_out' };
            db.prepare('INSERT INTO claims VALUES (?, ?, ?)').run(row.email_hash, reward.id, clock());
          }
        }
        db.prepare("UPDATE challenges SET status = 'claimed' WHERE id = ?").run(id);
        return { reward: { value: reward.value, kind: reward.kind }, recovered };
      });
      if (result.error) throw fail(result.error, result.error === 'sold_out' ? 409 : 400);
      return result;
    },
  };
}
