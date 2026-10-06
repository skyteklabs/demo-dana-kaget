import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const source = resolve(process.argv[2] || 'public/vendor/grovs/grovs.js');
const upstreamHash = 'e32a34d0cd9a26c1d4d33f7dd29b567733dd9aab2d944c46f55bf37833e2fa86';
let bundle = await readFile(source, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
if (hash(bundle) !== upstreamHash) throw new Error('Expected the pinned, unmodified Grovs 2.0.0 bundle');

const changes = [
  ['autoTrackScreenViews:s.autoTrackScreenViews??!0,requireConsent:',
    'autoTrackScreenViews:s.autoTrackScreenViews??!0,captureDeepLinks:s.captureDeepLinks??!0,requireConsent:'],
  ['this.sessionPath=this.deeplinks.capture(),',
    'this.sessionPath=this.config.captureDeepLinks?this.deeplinks.capture():null,'],
  ['addEvents(e,t=!1){return this.transport.send(',
    'addEvents(e,t=!1){if(!this.config.captureDeepLinks)e=e.map(({path,...event})=>event);return this.transport.send('],
];
for (const [before, after] of changes) {
  if (bundle.split(before).length !== 2) throw new Error('Grovs patch target is not unique');
  bundle = bundle.replace(before, after);
}
await writeFile(source, bundle);
console.log(`Grovs privacy patch SHA-256: ${hash(bundle)}`);
