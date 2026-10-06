import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRewardQr, renderRewardQr } from '../public/reward-qr.js';

function containerFixture() {
  const ownerDocument = {
    createElementNS(namespace, tagName) {
      return {
        namespace, tagName, attributes: {}, children: [],
        setAttribute(key, value) { this.attributes[key] = value; },
        append(...children) { this.children.push(...children); },
      };
    },
  };
  return {
    ownerDocument, hidden: false, children: ['old reward'],
    replaceChildren(...children) { this.children = children; },
  };
}

// These synthetic matrices were decoded independently with jsQR 1.4.0.
const verifiedFixtures = [
  ['https://dana.id/kaget?c=synthetic-test-123&r=R%2B8%3D&source=web', 37, 'ce64af6b67d23b48e48dfbe2246c90a150aaae68b607687219425d30a290798e'],
  ['https://link.dana.id/fixture?label=hadiah-✓&token=A%2FB%3F%26', 37, 'b9527afe9bdd4491bbb60ab5578d939eea0114e1be5fd43d1cae85b14baee544'],
  [`https://dana.id/${'a'.repeat(270)}`, 65, '45f8a5823d07ea89699c95d9079e8700c1cd0d5ba21ec33b763416682c549ccb'],
];

test('reward QR matrices preserve independently decoded URLs, including query punctuation and Unicode', () => {
  for (const [value, size, digest] of verifiedFixtures) {
    const qr = createRewardQr(value);
    assert.equal(qr.size, size);
    assert.equal(qr.quietZone, 4);
    assert.equal(createHash('sha256').update(JSON.stringify(qr.modules)).digest('hex'), digest);
  }
});

test('SVG contains exactly the encoded modules with a white four-module quiet zone', () => {
  const container = containerFixture();
  const value = verifiedFixtures[0][0];
  const qr = createRewardQr(value);
  assert.equal(renderRewardQr(container, value), true);
  assert.equal(container.hidden, false);
  const [svg] = container.children;
  assert.equal(svg.namespace, 'http://www.w3.org/2000/svg');
  assert.equal(svg.tagName, 'svg');
  const extent = qr.size + 8;
  assert.equal(svg.attributes.viewBox, `0 0 ${extent} ${extent}`);
  assert.equal(svg.attributes.role, 'img');
  assert.equal(svg.attributes['aria-label'], 'Kode QR untuk membuka tautan DANA');
  const [background, path] = svg.children;
  assert.deepEqual(background.attributes, { width: String(extent), height: String(extent), fill: '#fff' });
  assert.equal(path.attributes.fill, '#000');
  const rendered = Array.from({ length: extent }, () => Array(extent).fill(false));
  const runPattern = /M(\d+),(\d+)h(\d+)v1h-(\d+)z/g;
  let matched = '';
  for (const match of path.attributes.d.matchAll(runPattern)) {
    matched += match[0];
    const [x, y, width, backwards] = match.slice(1).map(Number);
    assert.equal(width, backwards);
    assert.ok(x >= 4 && y >= 4 && x + width <= extent - 4 && y < extent - 4);
    for (let i = x; i < x + width; i++) rendered[y][i] = true;
  }
  assert.equal(matched, path.attributes.d);
  assert.deepEqual(rendered.slice(4, -4).map(row => row.slice(4, -4)), qr.modules);
  assert.equal(JSON.stringify(svg).includes(value), false);
});

test('invalid or excessively dense values remove the previous reward QR and remain hidden', () => {
  const container = containerFixture();
  for (const value of [
    null, 42, '', 'DANA-CODE', 'http://dana.id/code', 'https://dana.id/',
    'https://dana.id.attacker.example/code', 'https://attacker.example/code',
    'https://name:password@dana.id/code', 'https://dana.id:8443/code',
    'https://dana.id/code\n', 'https://dana.id/<script>', 'https://dana.id/%3cscript%3e',
    `https://dana.id/${'a'.repeat(2049)}`, `https://dana.id/${'a'.repeat(600)}`,
  ]) {
    container.children = ['previous private QR'];
    assert.equal(createRewardQr(value), null);
    assert.equal(renderRewardQr(container, value), false);
    assert.deepEqual(container.children, []);
    assert.equal(container.hidden, true);
  }
});

test('rendering a second reward replaces the previous SVG', () => {
  const container = containerFixture();
  renderRewardQr(container, verifiedFixtures[0][0]);
  const previous = container.children[0];
  renderRewardQr(container, verifiedFixtures[1][0]);
  assert.equal(container.children.length, 1);
  assert.notEqual(container.children[0], previous);
  assert.notEqual(container.children[0].children[1].attributes.d, previous.children[1].attributes.d);
});

test('vendored encoder matches its pinned provenance hash', async () => {
  const provenance = JSON.parse(await readFile(new URL('../public/vendor/qr/provenance.json', import.meta.url)));
  const bytes = await readFile(new URL('../public/vendor/qr/qrcodegen.js', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.vendored_sha256);
});
