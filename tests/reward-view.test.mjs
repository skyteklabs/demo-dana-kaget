import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRewardView } from '../public/reward-view.js';

const url = 'https://link.dana.id/kaget?c=synthetic%2Btest&source=qr';
function fixture(renderQr) {
  const elements = Object.fromEntries(['qr', 'hint', 'link', 'value', 'fallback'].map(name => [name, {
    hidden: true, textContent: '', children: [],
    replaceChildren(...children) { this.children = children; },
  }]));
  const opened = [], events = [], encoded = [];
  const view = createRewardView(elements, {
    renderQr: renderQr || ((container, value) => { encoded.push(value); container.replaceChildren({ qr: true }); container.hidden = false; return true; }),
    openWindow: (...args) => opened.push(args),
    onOpen: (...args) => events.push(args),
  });
  return { elements, opened, events, encoded, view };
}

test('reward QR, visible link and navigation use the exact same URL without passing it to analytics', () => {
  const { view, elements, encoded, opened, events } = fixture();
  assert.equal(view.open(), false);
  assert.equal(view.render({ kind: 'link', value: url }), true);
  assert.deepEqual(encoded, [url]);
  assert.equal(elements.link.textContent, url);
  assert.equal(elements.link.hidden, false);
  assert.equal(elements.qr.hidden, false);
  assert.equal(elements.hint.hidden, false);
  assert.equal(elements.value.hidden, true);
  assert.equal(elements.fallback.hidden, true);
  assert.equal(view.open(), true);
  assert.deepEqual(opened, [[url, '_blank', 'noopener,noreferrer']]);
  assert.deepEqual(events, [[]]);
});

test('reset and replacement remove the old QR, link text and navigation destination', () => {
  const { view, elements, opened } = fixture();
  view.render({ kind: 'link', value: url });
  view.clear();
  assert.deepEqual(elements.qr.children, []);
  assert.equal(elements.link.textContent, '');
  assert.equal(elements.value.textContent, '');
  assert.ok(Object.values(elements).every(element => element.hidden));
  assert.equal(view.open(), false);
  assert.deepEqual(opened, []);
  const next = 'https://dana.id/synthetic-second';
  view.render({ kind: 'link', value: next });
  assert.equal(elements.qr.children.length, 1);
  assert.equal(elements.link.textContent, next);
  view.open();
  assert.equal(opened[0][0], next);
});

test('invalid or unexpected rewards clear prior private data and cannot navigate', () => {
  const { view, elements, opened } = fixture();
  for (const invalid of [null, {}, { kind: 'other', value: url }, ...[
    'javascript:alert(1)', 'https://attacker.example/x', 'https://dana.id.attacker.example/x',
    'https://user:secret@dana.id/x', 'http://dana.id/x', 'https://dana.id/<placeholder>', 'https://dana.id/' + 'x'.repeat(2048),
  ].map(value => ({ kind: 'link', value }))]) {
    view.render({ kind: 'link', value: url });
    assert.equal(view.render(invalid), false);
    assert.equal(view.open(), false);
    assert.equal(elements.link.textContent, '');
    assert.deepEqual(elements.qr.children, []);
  }
  assert.deepEqual(opened, []);
});

test('QR failures retain the clickable link and show a text fallback', () => {
  for (const renderQr of [() => false, () => { throw new Error('QR unavailable'); }]) {
    const { view, elements, opened } = fixture(renderQr);
    assert.equal(view.render({ kind: 'link', value: url }), true);
    assert.equal(elements.qr.hidden, true);
    assert.equal(elements.hint.hidden, true);
    assert.equal(elements.fallback.hidden, false);
    assert.equal(elements.link.textContent, url);
    view.open();
    assert.equal(opened[0][0], url);
  }
});

test('legacy demo codes retain text and copy support without a QR or outgoing link', () => {
  const { view, elements, encoded, opened } = fixture();
  view.render({ kind: 'link', value: url });
  assert.equal(view.render({ kind: 'code', value: 'DEMO-NOT-REDEEMABLE-001' }), true);
  assert.equal(elements.value.textContent, 'DEMO-NOT-REDEEMABLE-001');
  assert.equal(elements.value.hidden, false);
  assert.equal(elements.link.hidden, true);
  assert.equal(elements.qr.hidden, true);
  assert.equal(elements.fallback.hidden, true);
  assert.equal(encoded.length, 1);
  assert.equal(view.open(), false);
  assert.deepEqual(opened, []);
});

test('clickable reward keeps native keyboard activation and no outbound anchor for automatic analytics', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const control = html.match(/<button\b[^>]*id="open-reward"[^>]*>/)?.[0];
  assert.ok(control);
  assert.match(control, /type="button"/);
  assert.match(control, /role="link"/);
  assert.match(control, /aria-label="[^"]*tab baru"/);
  assert.doesNotMatch(control, /(?:href|src|data-href)=/);
  assert.ok(html.indexOf('id="reward-qr"') < html.indexOf('id="open-reward"'));
});
