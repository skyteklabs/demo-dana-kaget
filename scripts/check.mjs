import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function check(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'vendor') continue;
    const file = path + '/' + entry.name;
    if (entry.isDirectory()) await check(file);
    else if (/\.m?js$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const path of ['public', 'lib', 'scripts', 'tests']) await check(path);
const result = spawnSync(process.execPath, ['--check', 'server.mjs'], { stdio: 'inherit' });
process.exitCode = result.status || 0;
