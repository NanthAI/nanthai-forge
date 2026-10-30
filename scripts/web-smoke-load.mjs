// SPDX-License-Identifier: Apache-2.0
// Headless smoke for the built web app: evaluate the Hosted chunk and every other chunk under a stub DOM and fail on
// any module-evaluation error. This is what the browser does before it renders anything, and what failed on
// 2026-10-28 ("Could not load Forge." from createRequire). Usage: node scripts/web-smoke-load.mjs <build dir> [ENV_NAME...]
// Each ENV_NAME must be set and its value baked into a chunk; otherwise the app renders "Forge backend is not configured"
// (the message text ships in every build, so the build-time value is what is checked). Values are never printed.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = resolve(process.argv[2] ?? 'hosted-web-dist');
const assets = join(dir, 'assets');
const hosted = JSON.parse(readFileSync(join(dir, '.vite/manifest.json'), 'utf8'))['src/Hosted.tsx']?.file;
if (!hosted) (console.error('web smoke: src/Hosted.tsx is missing from the build manifest'), process.exit(1));
const chunks = [hosted, ...readdirSync(assets).map(name => `assets/${name}`)].filter(
  (file, index, all) => file.endsWith('.js') && !file.includes('.worker-') && all.indexOf(file) === index,
);
// Chunks are evaluated in a child with the stub DOM preloaded, one import() each, so a throwing chunk cannot hide the rest.
const loader = `
const failures = [];
for (const url of process.argv.slice(1))
  try { await import(url); } catch (error) { failures.push(url.split('/').slice(-2).join('/') + ': ' + String(error).slice(0, 200)); }
process.stdout.write(JSON.stringify(failures));
process.exit(0);`;
const child = spawnSync(
  process.execPath,
  [
    '--import',
    fileURLToPath(new URL('./web-smoke-stub.mjs', import.meta.url)),
    '--input-type=module',
    '-e',
    loader,
    ...chunks.map(file => pathToFileURL(join(dir, file)).href),
  ],
  { encoding: 'utf8' },
);
let failures;
try {
  failures = JSON.parse(child.stdout);
} catch {
  failures = [`the chunk loader did not finish (exit ${child.status}): ${child.stderr.slice(0, 300)}`];
}
const evaluated = chunks.length - failures.length;
const code = chunks.map(file => readFileSync(join(dir, file), 'utf8')).join('\n');
for (const name of process.argv.slice(3)) {
  const value = process.env[name];
  if (!value) failures.push(`${name} is not set; the build would render "Forge backend is not configured"`);
  else if (!code.includes(value)) failures.push(`${name} is not baked into the built chunks`);
}
console.log(`web smoke: ${evaluated}/${chunks.length} chunks evaluated (Hosted chunk: ${hosted})`);
if (failures.length) (console.error(failures.join('\n')), process.exit(1));
process.exit(0);
