import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClaimStore, parseInventory } from '../lib/claims.mjs';
import { claimConfig } from '../lib/delivery.mjs';

let store;
try {
  process.umask(0o077);
  const file = process.argv[2];
  if (!file) throw new Error('Supply a private TXT file (one code/link per line) or a JSON array. Use --demo for local test codes.');
  const config = claimConfig();
  if (file === '--demo' && !config.local) throw new Error('Demo inventory is available only in local mode.');
  let input = '';
  if (file === '-') for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 20_000_000) throw new Error('Inventory too large');
  }
  const text = file === '--demo' ? Array.from({ length: 20 }, (_, i) => `DEMO-NOT-REDEEMABLE-${String(i + 1).padStart(3, '0')}`).join('\n') : file === '-' ? input : await readFile(resolve(file), 'utf8');
  const entries = parseInventory(text);
  store = await createClaimStore(resolve(process.env.DATA_DIR || './data'), config);
  const result = store.import(entries);
  console.log(`Imported ${result.added}; duplicates skipped ${result.duplicates}; available ${store.stock()}.`);
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Inventory file not found.' : error.code || 'Import failed. Check file format and configuration.');
  process.exitCode = 1;
} finally { store?.close(); }
