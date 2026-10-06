import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createClaimStore, parseInventory } from '../lib/claims.mjs';
import { claimConfig } from '../lib/delivery.mjs';
import { claimService } from '../lib/claim-service.mjs';
import { createHandler } from '../server.mjs';

const sharedLink = 'https://link.dana.id/kaget?c=synthetic-first';
const nextLink = 'https://dana.id/synthetic-second';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dana-shared-'));
  const stores = new Set();
  let now = Date.now();
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const open = async (rewardLink = sharedLink) => {
    const store = await createClaimStore(directory, { rewardLink, clock: () => now });
    stores.add(store);
    let lastMail;
    const service = claimService(store, { verify: async () => {}, send: async mail => { lastMail = mail; } });
    const issue = async (email, session = email) => {
      const result = await service.request({ email, turnstileToken: 'synthetic-token' }, session, 'synthetic-client');
      return { requestId: result.requestId, verificationCode: lastMail.code };
    };
    return { store, service, issue, close() { stores.delete(store); store.close(); } };
  };
  const counts = () => {
    const db = new DatabaseSync(join(directory, 'dana-local.sqlite'), { readOnly: true });
    try {
      return {
        shared: db.prepare('SELECT COUNT(*) AS count FROM shared_claims').get().count,
        exclusive: db.prepare('SELECT COUNT(*) AS count FROM claims').get().count,
        inventory: db.prepare('SELECT COUNT(*) AS count FROM rewards').get().count,
      };
    } finally { db.close(); }
  };
  return { directory, open, counts, advance: ms => { now += ms; } };
}

async function request(handler, url, { body, cookie } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.url = url; req.method = body === undefined ? 'GET' : 'POST';
  req.headers = { host: 'localhost:4173', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(value) { this.text = value?.toString(); } };
  await handler(req, res);
  res.body = JSON.parse(res.text);
  return res;
}

test('shared reward configuration is optional and only accepts bounded HTTPS DANA links', () => {
  assert.equal(claimConfig({}).rewardLink, '');
  assert.equal(claimConfig({ DANA_REWARD_LINK: '   ' }).rewardLink, '');
  assert.equal(claimConfig({ DANA_REWARD_LINK: ` ${sharedLink} ` }).rewardLink, sharedLink);
  assert.equal(claimConfig({ DANA_REWARD_LINK: nextLink }).rewardLink, nextLink);
  for (const value of ['javascript:alert(1)', 'http://dana.id/test', 'https://dana.id/', 'https://link.dana.id.evil.test/test', 'https://dana.id:444/test', 'https://user:secret@dana.id/test', 'https://dana.id/<your-link-token>', 'https://dana.id/%3Ctoken%3E', 'https://dana.id/test\nprivate', `https://dana.id/${'x'.repeat(2048)}`, 12]) {
    assert.throws(() => claimConfig({ DANA_REWARD_LINK: value }), error => {
      assert.equal(error.code, 'invalid_dana_reward_link');
      assert.equal(error.status, 503);
      assert.equal(error.message, 'invalid_dana_reward_link');
      assert.equal(JSON.stringify(error).includes(String(value)), false);
      return true;
    });
  }
});

test('different verified emails receive the shared link without consuming imported inventory', async t => {
  const f = await fixture(t);
  const { store, service, issue } = await f.open();
  store.import(parseInventory('SYNTHETIC-EXCLUSIVE'));
  for (const email of ['first@example.test', 'second@example.test']) {
    const result = service.claim(await issue(email), email, 'synthetic-client');
    assert.deepEqual(result, { reward: { value: sharedLink, kind: 'link' }, recovered: false });
  }
  assert.equal(store.stock(), 1);
  assert.deepEqual(f.counts(), { shared: 2, exclusive: 0, inventory: 1 });
});

test('invalid codes allocate nothing and the same email recovers one claim after a fresh OTP and restart', async t => {
  const f = await fixture(t);
  const first = await f.open();
  const challenge = await first.issue('person@example.test', 'original');
  const wrongCode = challenge.verificationCode === '000000' ? '111111' : '000000';
  assert.throws(() => first.service.claim({ ...challenge, verificationCode: wrongCode }, 'original', 'synthetic-client'), { code: 'invalid_code' });
  assert.equal(f.counts().shared, 0);
  const allocated = first.service.claim(challenge, 'original', 'synthetic-client');
  const repeated = first.service.claim(challenge, 'original', 'synthetic-client');
  assert.equal(allocated.recovered, false);
  assert.equal(repeated.recovered, true);
  first.close();
  f.advance(61_000);
  const restarted = await f.open();
  const newChallenge = await restarted.issue(' PERSON@EXAMPLE.TEST ', 'new-browser');
  const recovered = restarted.service.claim(newChallenge, 'new-browser', 'synthetic-client');
  assert.deepEqual(recovered, { reward: allocated.reward, recovered: true });
  assert.equal(f.counts().shared, 1);
});

test('changing or clearing the shared link preserves previous claims and only changes new allocations', async t => {
  const f = await fixture(t);
  const original = await f.open();
  original.service.claim(await original.issue('first@example.test'), 'first@example.test', 'synthetic-client');
  original.close();
  f.advance(61_000);
  const changed = await f.open(nextLink);
  const recovered = changed.service.claim(await changed.issue('first@example.test'), 'first@example.test', 'synthetic-client');
  assert.deepEqual(recovered, { reward: { value: sharedLink, kind: 'link' }, recovered: true });
  const next = changed.service.claim(await changed.issue('next@example.test'), 'next@example.test', 'synthetic-client');
  assert.equal(next.reward.value, nextLink);
  changed.close();
  f.advance(61_000);
  const cleared = await f.open('');
  const known = cleared.service.claim(await cleared.issue('next@example.test'), 'next@example.test', 'synthetic-client');
  assert.deepEqual(known, { reward: next.reward, recovered: true });
  const empty = await cleared.issue('empty@example.test');
  assert.throws(() => cleared.service.claim(empty, 'empty@example.test', 'synthetic-client'), { code: 'sold_out' });
  cleared.store.import(parseInventory('SYNTHETIC-NEW-INVENTORY'));
  const exclusive = cleared.service.claim(empty, 'empty@example.test', 'synthetic-client');
  assert.deepEqual(exclusive, { reward: { value: 'SYNTHETIC-NEW-INVENTORY', kind: 'code' }, recovered: false });
  assert.deepEqual(f.counts(), { shared: 2, exclusive: 1, inventory: 1 });
});

test('existing exclusive allocations are recovered after enabling the shared link', async t => {
  const f = await fixture(t);
  const exclusive = await f.open('');
  exclusive.store.import(parseInventory('SYNTHETIC-OLD-INVENTORY'));
  const original = exclusive.service.claim(await exclusive.issue('existing@example.test'), 'existing@example.test', 'synthetic-client');
  exclusive.close();
  f.advance(61_000);
  const shared = await f.open();
  const recovered = shared.service.claim(await shared.issue('existing@example.test'), 'existing@example.test', 'synthetic-client');
  assert.deepEqual(recovered, { reward: original.reward, recovered: true });
  assert.deepEqual(f.counts(), { shared: 0, exclusive: 1, inventory: 1 });
});

test('simultaneous processes record only one shared claim even with different configured links', async t => {
  const f = await fixture(t);
  const { issue } = await f.open();
  const challenge = await issue('person@example.test', 'same-session');
  const workers = [sharedLink, nextLink].map(rewardLink => new Worker(new URL('./claim-worker.mjs', import.meta.url), { workerData: { ...challenge, directory: f.directory, session: 'same-session', config: { rewardLink } } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(worker => once(worker, 'message')));
  const pending = workers.map(worker => once(worker, 'message'));
  workers.forEach(worker => worker.postMessage('claim'));
  const results = (await Promise.all(pending)).map(([result]) => result);
  assert.ok(results.every(result => result.success));
  assert.equal(results[0].reward, results[1].reward);
  assert.deepEqual(results.map(result => result.recovered).sort(), [false, true]);
  assert.deepEqual(f.counts(), { shared: 1, exclusive: 0, inventory: 0 });
});

test('the shared link is absent from configuration and email requests and appears only after a valid claim', async t => {
  const f = await fixture(t);
  const { store } = await f.open();
  const mails = [];
  const claims = claimService(store, { verify: async () => {}, send: async mail => { mails.push(mail); } });
  const handler = createHandler({ claims, env: { DANA_REWARD_LINK: sharedLink } });
  const config = await request(handler, '/api/config');
  assert.equal(config.text.includes(sharedLink), false);
  assert.equal(config.text.includes('rewardLink'), false);
  const cookie = config.headers['set-cookie'].split(';')[0];
  const sent = await request(handler, '/api/code/request', { cookie, body: { email: 'person@example.test', turnstileToken: 'synthetic-token' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.text.includes(sharedLink), false);
  assert.equal(JSON.stringify(mails).includes(sharedLink), false);
  const payload = { requestId: sent.body.requestId, verificationCode: mails[0].code };
  const unbound = await request(handler, '/api/claim', { body: payload });
  assert.equal(unbound.status, 401);
  assert.equal(unbound.text.includes(sharedLink), false);
  const claimed = await request(handler, '/api/claim', { cookie, body: payload });
  assert.equal(claimed.status, 200);
  assert.deepEqual(claimed.body, { reward: { value: sharedLink, kind: 'link' }, recovered: false });
});
