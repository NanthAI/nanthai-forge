// SPDX-License-Identifier: Apache-2.0
// The control supervisor's runtime packages: what scripts/hosted-actions-job.mjs and the executor
// it spawns import from node_modules once dist/ is built. A check job that restores the cached
// build needs only these, not the full install (compilers, bundlers, browsers, ~150 MB). Any CI
// can call it: `node scripts/control-runtime-deps.mjs key [ROOT]` prints the cache key,
// `node scripts/control-runtime-deps.mjs paths [PREFIX]` prints one path per line.
// tests/control-runtime-deps.test.mjs fails when the import closure reaches a package not listed.
// Same trust contract as scripts/control-deps-key.mjs: keyed on the pinned control lockfile only,
// written by default-branch control jobs before any Candidate code runs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const controlRuntimePackages = ['zod', '@noble/hashes', 'typescript'];
export const controlRuntimeEntries = ['scripts/hosted-actions-job.mjs', 'scripts/hosted-actions-execute.mjs'];

export function controlRuntimeKey(root = '.', runtime = process) {
  const lock = readFileSync(join(resolve(root), 'package-lock.json'));
  return `forge-control-runtime-v1-${runtime.platform}-${runtime.arch}-node-${runtime.versions.node}-${createHash('sha256').update(lock).update(controlRuntimePackages.join('\n')).digest('hex')}`;
}

export const controlRuntimePaths = (prefix = '') =>
  controlRuntimePackages.map(name => posix.join(prefix, 'node_modules', name));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  if (command === 'key') console.log(controlRuntimeKey(argument ?? '.'));
  else if (command === 'paths') console.log(controlRuntimePaths(argument ?? '').join('\n'));
  else {
    console.error('Usage: control-runtime-deps.mjs key [ROOT] | paths [PREFIX]');
    process.exitCode = 2;
  }
}
