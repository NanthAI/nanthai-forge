// SPDX-License-Identifier: Apache-2.0
// Cache key for the trusted control dependencies (`npm ci` output plus the npm download cache).
// Any CI can call it: `node scripts/control-deps-key.mjs [ROOT]` prints one key. Plain Node.
//
// Contract for every CI adapter (GitHub Actions today; BYOCI runners the same way):
//  - The key hashes only the lockfile of the pinned control checkout (the main commit that
//    selected the supervisor), never a Candidate file, so a Lane cannot choose or collide with it.
//  - Only a job running that control checkout on the default branch may write the entry, and it
//    writes before any Candidate code runs. Lane checks restore read-only; a miss installs cold.
//  - Candidate installs are never cached: they read the main-seeded download cache and verify
//    every package against their own lockfile integrity hashes.
import { isMainModule } from './main-module.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function controlDepsKey(root = '.', runtime = process) {
  const lock = readFileSync(join(resolve(root), 'package-lock.json'));
  const node = runtime.versions.node;
  return `forge-control-deps-v2-${runtime.platform}-${runtime.arch}-node-${node}-${createHash('sha256').update(lock).digest('hex')}`;
}

if (isMainModule(import.meta.url)) console.log(controlDepsKey(process.argv[2] ?? '.'));
