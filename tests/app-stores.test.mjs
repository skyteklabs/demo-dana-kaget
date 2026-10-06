import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { appStoreConfig } from '../lib/app-stores.mjs';
import { createHandler } from '../server.mjs';

async function request(handler, url, method = 'GET') {
  const req = Readable.from([]);
  Object.assign(req, { url, method, headers: { host: 'localhost:4173' } });
  const res = {
    headers: {}, setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body?.toString() || ''; },
  };
  await handler(req, res);
  return res;
}

test('store destinations default to the supplied Google Translate listings and accept configured official listings', () => {
  assert.deepEqual(appStoreConfig({}), {
    android: 'https://play.google.com/store/apps/details?id=com.google.android.apps.translate&hl=en',
    ios: 'https://apps.apple.com/us/app/google-translate/id414706506',
  });
  const android = 'https://play.google.com/store/apps/details?id=example.test&hl=id';
  const ios = 'https://apps.apple.com/id/app/example/id123456789';
  assert.deepEqual(appStoreConfig({ ANDROID_STORE_URL: android, IOS_STORE_URL: ios }), { android, ios });
  assert.deepEqual(appStoreConfig({ ANDROID_STORE_URL: '', IOS_STORE_URL: '' }), appStoreConfig({}));
});

test('store destination configuration rejects unsafe or misleading URLs without reflecting values', () => {
  for (const [key, host] of [['ANDROID_STORE_URL', 'play.google.com'], ['IOS_STORE_URL', 'apps.apple.com']]) {
    for (const value of [
      'javascript:alert(1)', '//'+host+'/app', 'http://'+host+'/app',
      'https://'+host+'.attacker.test/app', 'https://attacker.test/'+host,
      'https://'+host+':8443/app', 'https://private:secret@'+host+'/app',
      'https://'+host+'\\@attacker.test/app', 'https://'+host+'/\nprivate',
      'https://'+host+'/'+ 'a'.repeat(2048), 'not-a-url', { private: 'must-not-export' },
    ]) {
      assert.throws(() => appStoreConfig({ [key]: value }), error => {
        assert.equal(error.code, 'invalid_store_configuration');
        assert.equal(error.status, 503);
        assert.equal(error.message, 'invalid_store_configuration');
        return true;
      });
    }
  }
});

test('store pages serve native fallback links without claim sessions, analytics or query-controlled redirects', async () => {
  const handler = createHandler({ env: {
    ANDROID_STORE_URL: 'https://play.google.com/store/apps/details?id=example.test&hl=id',
    IOS_STORE_URL: 'https://apps.apple.com/id/app/example/id123456789',
    META_PIXEL_ID: '123456789', META_ACCESS_TOKEN: 'private-fixture-token', GA4_MEASUREMENT_ID: 'G-TEST',
  } });
  for (const name of ['android', 'ios', 'platform']) {
    for (const suffix of ['', '/', '?url=https://attacker.test&email=private-input#reward']) {
      const result = await request(handler, '/'+name+suffix);
      assert.equal(result.status, 200);
      assert.match(result.headers['content-type'], /^text\/html/);
      assert.equal(result.headers['referrer-policy'], 'no-referrer');
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['set-cookie'], undefined);
      assert.equal(result.headers.location, undefined);
      assert.match(result.body, /<a[^>]+href="https:\/\/(?:play\.google\.com|apps\.apple\.com)\//);
      if (name !== 'ios') assert.match(result.body, /details\?id=example\.test&amp;hl=id/);
      assert.equal(/attacker\.test|private-input|private-fixture-token|G-TEST|<script[^>]+src="\/app\.js"|googletagmanager|\/api\/config/.test(result.body), false);
    }
    const head = await request(handler, '/'+name, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal((await request(handler, '/'+name, 'POST')).status, 405);
  }
  for (const path of ['/android/extra', '/ios/extra', '/platform/extra']) {
    assert.equal((await request(handler, path)).status, 404);
  }
});
