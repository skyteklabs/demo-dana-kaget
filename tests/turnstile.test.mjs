import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnstileLoader } from '../public/turnstile.js';

const api = () => ({ render() {}, reset() {}, remove() {} });
function fixture(initialGlobal) {
  const window = { turnstile: initialGlobal };
  const scripts = [];
  const timers = new Map();
  let timerId = 0;
  const document = {
    createElement: () => ({ removed: false, remove() { this.removed = true; } }),
    head: { append(script) { scripts.push(script); } },
  };
  const load = createTurnstileLoader({ window, document, schedule: callback => { timers.set(++timerId, callback); return timerId; }, cancel: id => timers.delete(id) });
  return { load, window, scripts, timers };
}

test('an element exposed as window.turnstile does not suppress SDK loading', async () => {
  const element = { tagName: 'DIV', id: 'turnstile', remove() {} };
  const f = fixture(element);
  const loaded = f.load();
  assert.equal(f.scripts.length, 1);
  assert.equal(f.scripts[0].src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  const sdk = api(); f.window.turnstile = sdk; f.scripts[0].onload();
  assert.equal(await loaded, sdk);
  assert.equal(f.timers.size, 0);
});

test('concurrent calls share one script and a loaded SDK is reused', async () => {
  const f = fixture();
  const first = f.load(); const second = f.load();
  assert.equal(first, second);
  assert.equal(f.scripts.length, 1);
  f.window.turnstile = api(); f.scripts[0].onload();
  await first;
  assert.equal(await f.load(), f.window.turnstile);
  assert.equal(f.scripts.length, 1);
});

test('network failure removes the failed script and allows a new attempt', async () => {
  const f = fixture();
  const first = f.load();
  f.scripts[0].onerror();
  await assert.rejects(first, /turnstile_load_failed/);
  assert.equal(f.scripts[0].removed, true);
  assert.equal(f.timers.size, 0);
  const retry = f.load();
  assert.equal(f.scripts.length, 2);
  f.window.turnstile = api(); f.scripts[1].onload();
  assert.equal(await retry, f.window.turnstile);
});

test('a script load event without an SDK is rejected rather than treated as ready', async () => {
  const f = fixture({ id: 'turnstile' });
  const first = f.load(); f.scripts[0].onload();
  await assert.rejects(first, /turnstile_sdk_missing/);
  assert.equal(f.scripts[0].removed, true);
});

test('timeout detaches stale callbacks and a retry can load successfully', async () => {
  const f = fixture();
  const first = f.load();
  [...f.timers.values()][0]();
  await assert.rejects(first, /turnstile_load_timeout/);
  assert.equal(f.scripts[0].onload, null);
  assert.equal(f.scripts[0].onerror, null);
  const retry = f.load();
  f.window.turnstile = api(); f.scripts[1].onload();
  assert.equal(await retry, f.window.turnstile);
});
