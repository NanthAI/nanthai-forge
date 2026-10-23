// SPDX-License-Identifier: Apache-2.0
// Bundle the existing locked production dependencies only in disposable staging.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out'))
  throw new Error('Use package-local.mjs [--out DIRECTORY].');
const output = args.length ? resolve(args[1]) : join(root, '.forge', 'packages');
mkdirSync(output, { recursive: true, mode: 0o700 });
const stage = mkdtempSync(join(tmpdir(), 'forge-pack-stage-'));
try {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
  for (const path of manifest.files) cpSync(join(root, path), join(stage, path), { recursive: true });
  writeFileSync(
    join(stage, 'package.json'),
    `${JSON.stringify({ ...manifest, bundledDependencies: Object.keys(manifest.dependencies), files: [...manifest.files, 'forge-package-lock.json'] }, null, 2)}\n`,
  );
  const lock = readFileSync(join(root, 'package-lock.json'));
  const parsed = JSON.parse(lock);
  if (parsed.name !== manifest.name || parsed.version !== manifest.version)
    throw new Error('Package and locked runtime identities differ.');
  writeFileSync(join(stage, 'package-lock.json'), lock);
  writeFileSync(join(stage, 'forge-package-lock.json'), lock);
  const npm = process.env.npm_execpath || createRequire(import.meta.url).resolve('npm/bin/npm-cli.js');
  const install = spawnSync(
    process.execPath,
    [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: stage, encoding: 'utf8' },
  );
  if (install.status !== 0) throw new Error(install.stderr || 'Locked production staging install failed.');
  // npm can omit installed optional peers from bundling; select its actual packed dependency inventory.
  const inventory = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: stage,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (inventory.status !== 0)
    throw new Error(inventory.stderr || inventory.error?.message || 'Staged package inventory failed.');
  const inventoryPath = join(stage, 'forge-pack-inventory.json');
  writeFileSync(inventoryPath, inventory.stdout);
  const notices = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'package-notices.mjs'), '--root', stage, '--inventory', inventoryPath],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (notices.status !== 0)
    throw new Error(notices.stderr || notices.error?.message || 'Staged upstream notices are incomplete.');
  const result = spawnSync(
    process.execPath,
    [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', output],
    { cwd: stage, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || result.error?.message || 'Local package staging failed.');
  console.log(result.stdout.trim());
} finally {
  rmSync(stage, { recursive: true, force: true });
}
