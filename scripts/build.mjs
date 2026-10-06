import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const file of ['public', 'lib', 'scripts', 'server.mjs', 'package.json']) {
  await cp(file, 'dist/' + file, { recursive: true });
}
console.log('Built dist/. Run with: cd dist && npm start');
