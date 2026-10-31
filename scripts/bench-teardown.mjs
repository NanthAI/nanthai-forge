// SPDX-License-Identifier: Apache-2.0
// Remove the checkouts a benchmark run leaves behind; keep logs, JSON and summaries.
// Usage: node scripts/bench-teardown.mjs WORK_DIR [--dry-run]; also imported by bench harnesses.
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const maxDepth = 3;
/** A checkout carries a Git or Forge store, an installed dependency tree, or is a bare repository. */
const marker = dir =>
  ['.git', '.forge', 'node_modules'].some(name => existsSync(join(dir, name))) ||
  ['HEAD', 'objects', 'refs'].every(name => existsSync(join(dir, name)));

/** Directory entries that are checkouts below `work`, without descending into one. */
export function benchCheckouts(work, depth = 0) {
  if (depth >= maxDepth) return [];
  const found = [];
  for (const entry of readdirSync(work, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // Symlinks and files (logs, json, summaries) stay.
    const dir = join(work, entry.name);
    if (existsSync(join(dir, '.bench-keep'))) continue;
    if (marker(dir) || entry.name.startsWith('.bench-seed-')) found.push(dir);
    else found.push(...benchCheckouts(dir, depth + 1));
  }
  return found;
}

/** Idempotent and best effort per checkout: one stuck directory never hides the rest or the run result. */
export function teardownBench(work, { dryRun = false, log = () => {} } = {}) {
  const root = resolve(work);
  if (root === sep || root === homedir() || !existsSync(root) || !lstatSync(root).isDirectory())
    return { removed: [], failed: [] };
  const removed = [],
    failed = [];
  for (const dir of benchCheckouts(root)) {
    try {
      if (!dryRun) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed.push(dir);
    } catch (error) {
      failed.push({ dir, error: error.message });
      log(`bench teardown: could not remove ${dir}: ${error.message}`);
    }
  }
  return { removed, failed };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [work, ...flags] = process.argv.slice(2);
  if (!work || flags.some(flag => flag !== '--dry-run')) {
    console.error('Usage: node scripts/bench-teardown.mjs WORK_DIR [--dry-run]');
    process.exit(2);
  }
  const result = teardownBench(work, { dryRun: flags.length > 0, log: console.error });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.failed.length ? 1 : 0;
}
