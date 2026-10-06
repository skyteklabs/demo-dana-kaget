import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStorePage } from '../lib/store-page.mjs';
import { detectStorePlatform, startStoreRedirect, mountStoreRedirect } from '../public/store-redirect.js';

const stores = {
  android: 'https://play.google.com/store/apps/details?id=test.fixture&hl=id',
  ios: 'https://apps.apple.com/id/app/test-fixture/id123456789',
};

function redirectFixture(overrides = {}) {
  const navigation = [];
  const status = [];
  const timers = new Map();
  const controller = startStoreRedirect({
    page: 'platform', navigator: {}, stores,
    navigate: value => navigation.push(value), setStatus: value => status.push(value),
    schedule: (callback, delay) => { assert.equal(delay, 1000); timers.set(1, callback); return 1; },
    cancel: id => timers.delete(id), ...overrides,
  });
  const run = () => { for (const callback of [...timers.values()]) callback(); timers.clear(); };
  return { controller, navigation, status, timers, run };
}

test('store HTML has usable native links without JavaScript and no claim or analytics modules', () => {
  for (const page of ['android', 'ios', 'platform']) {
    const html = renderStorePage(page, stores);
    assert.match(html, new RegExp(`data-store-page="${page}"`));
    assert.match(html, /role="status"/);
    assert.match(html, /name="referrer" content="no-referrer"/);
    assert.match(html, /src="\/store-redirect.js"/);
    assert.doesNotMatch(html, /src="\/app.js"|analytics\/|fbq|gtag|http-equiv="refresh"|target="_blank"/);
    assert.equal((html.match(/data-store="/g) || []).length, page === 'platform' ? 2 : 1);
    assert.equal((html.match(/rel="noreferrer"/g) || []).length, page === 'platform' ? 2 : 1);
    if (page !== 'ios') assert.match(html, /href="https:\/\/play.google.com\/store\/apps\/details\?id=test.fixture&amp;hl=id"/);
    if (page !== 'android') assert.match(html, /href="https:\/\/apps.apple.com\/id\/app\/test-fixture\/id123456789"/);
  }
});

test('store rendering escapes URL attributes and rejects unknown route selectors', () => {
  const html = renderStorePage('android', { android: 'https://play.google.com/?x="<fixture>\'&y=1' });
  assert.match(html, /x=&quot;&lt;fixture&gt;&#39;&amp;y=1/);
  assert.doesNotMatch(html, /<fixture>/);
  assert.throws(() => renderStorePage('android" onload="fixture', stores), /Invalid store page/);
});

test('device detection covers Android, iOS, iPadOS desktop identification and unknown devices', () => {
  assert.equal(detectStorePlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), 'android');
  for (const name of ['iPhone', 'iPad', 'iPod']) assert.equal(detectStorePlatform({ userAgent: `Mozilla/5.0 (${name}; CPU OS 18)` }), 'ios');
  assert.equal(detectStorePlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }), 'ios');
  for (const navigator of [{}, { userAgent: 'Windows NT 10.0' }, { platform: 'MacIntel', maxTouchPoints: 0 }, { platform: 'MacIntel', maxTouchPoints: 1 }]) {
    assert.equal(detectStorePlatform(navigator), null);
  }
});

test('explicit store routes override device detection and redirect only after the delay', () => {
  for (const page of ['android', 'ios']) {
    const f = redirectFixture({ page, navigator: { userAgent: page === 'ios' ? 'Android' : 'iPhone' } });
    assert.equal(f.controller.platform, page);
    assert.equal(f.navigation.length, 0);
    f.run();
    assert.deepEqual(f.navigation, [stores[page]]);
    assert.match(f.status.at(-1), /gunakan tautan/);
  }
});

test('platform route auto-selects mobile stores and leaves desktops as a chooser', () => {
  for (const [navigator, expected] of [[{ userAgent: 'Android' }, 'android'], [{ platform: 'MacIntel', maxTouchPoints: 5 }, 'ios'], [{ userAgent: 'Windows NT' }, null]]) {
    const f = redirectFixture({ navigator });
    assert.equal(f.controller.platform, expected);
    f.run();
    assert.deepEqual(f.navigation, expected ? [stores[expected]] : []);
  }
});

test('failed navigation retains a visible fallback and unsafe destinations never navigate', () => {
  const f = redirectFixture({ page: 'android', navigate() { throw new Error('Navigation blocked'); } });
  assert.doesNotThrow(f.run);
  assert.match(f.status.at(-1), /tidak berhasil/);
  for (const android of ['javascript:alert(1)', 'http://play.google.com/', 'https://user:password@play.google.com/']) {
    const blocked = redirectFixture({ page: 'android', stores: { android } });
    blocked.run();
    assert.equal(blocked.navigation.length, 0);
    assert.match(blocked.status.at(-1), /belum tersedia/);
  }
});

test('manual selection cancels automatic navigation and ignores inbound query/hash values', () => {
  const handlers = new Map();
  const timers = new Map();
  const navigation = [];
  const status = {};
  const links = ['android', 'ios'].map(platform => ({
    dataset: { store: platform },
    getAttribute: name => name === 'href' ? stores[platform] : null,
    addEventListener: (event, listener) => handlers.set(`${platform}:${event}`, listener),
  }));
  mountStoreRedirect({
    document: { body: { dataset: { storePage: 'platform' } }, querySelector: () => status, querySelectorAll: () => links },
    window: {
      navigator: { userAgent: 'Android' },
      location: { search: '?redirect=https://other.example/private', hash: '#private', replace: url => navigation.push(url) },
      setTimeout: callback => { timers.set(1, callback); return 1; }, clearTimeout: id => timers.delete(id),
      addEventListener: (event, listener) => handlers.set(event, listener),
    },
  });
  timers.get(1)();
  assert.deepEqual(navigation, [stores.android]);
  handlers.get('android:click')();
  assert.doesNotThrow(() => handlers.get('pagehide')());
  const f = redirectFixture({ page: 'ios' });
  f.controller.stop();
  f.run();
  assert.equal(f.navigation.length, 0);
});
