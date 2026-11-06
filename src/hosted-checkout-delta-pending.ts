// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { ForgeError } from './errors.js';
import { syncDirectory } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { checkoutPathExists as exists } from './hosted-checkout-files.js';
import { deltaJournalName } from './hosted-checkout-delta.js';
import { settleCheckoutDelta } from './hosted-checkout-delta-settle.js';

/** Lock-free: an in-place apply is running or was interrupted in this checkout. */
export function deltaApplyPending(root: string) {
  try {
    return exists(join(clientCacheRoot(canonicalRoot(root)), deltaJournalName));
  } catch {
    return false;
  }
}
/** Every command that trusts the checkout marker (save, abandon keepPatch, preflight, rebase,
 * lifecycle) calls this first. Without a journal it costs one lstat. Otherwise it takes the work
 * lock and finishes or rolls back the interrupted apply, so the marker again describes the bytes on
 * disk. A rollback caused by a local edit leaves that edit under the prior marker, which is exactly
 * what a save records. Bytes kept aside refuse once, naming the folder; an apply that cannot finish
 * refuses with the typed `delta-apply-pending` obstruction. */
export function finishPendingCheckoutDelta(root: string) {
  root = canonicalRoot(root);
  const cacheRoot = clientCacheRoot(root);
  if (!exists(join(cacheRoot, deltaJournalName))) return null;
  const settled = workLocked(join(cacheRoot, 'lock'), () => settleCheckoutDelta(root, cacheRoot));
  if (settled?.retained.length)
    throw new ForgeError(
      'WORK_CONFLICT',
      `An interrupted local apply finished first. Bytes that differed from the saved baseline were kept at ${settled.retained.join(', ')}; copy back what you need, then rerun the command.`,
      undefined,
      { obstruction: { kind: 'delta-retained', path: settled.retained[0] } },
    );
  return settled;
}
/** For marker writers already holding the work lock: finish or roll back an interrupted apply so
 * their marker compare-and-swap sees the bytes on disk. A rollback leaves the prior marker over
 * the prior bytes plus local edits, which is a consistent baseline for them. */
export function settlePendingCheckoutDelta(root: string) {
  root = canonicalRoot(root);
  return settleCheckoutDelta(root, clientCacheRoot(root));
}
/** Explicit apply recovery restores a whole verified baseline over a checkout it already moved
 * aside, so an interrupted in-place apply no longer describes anything. Its moved-aside bytes move
 * into the recovery directory beside the preserved checkout; its stage is regenerable. Call under
 * the work lock, only once the checkout root itself is preserved. */
export function retireCheckoutDelta(cacheRoot: string, directory: string): string | null {
  const journalPath = join(cacheRoot, deltaJournalName);
  if (!exists(journalPath)) return null;
  let names: { stage?: unknown; backup?: unknown } = {};
  try {
    names = JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch {
    names = {};
  }
  const valid = (name: unknown): name is string =>
    typeof name === 'string' && /^delta-[A-Za-z0-9_-]+$/.test(name);
  let kept: string | null = null;
  if (valid(names.backup)) {
    const moved = join(directory, names.backup);
    if (exists(join(cacheRoot, names.backup)) && !exists(moved)) {
      renameSync(join(cacheRoot, names.backup), moved);
      syncDirectory(directory);
    }
    if (exists(moved)) kept = moved;
  }
  rmSync(journalPath, { force: true });
  syncDirectory(cacheRoot);
  if (valid(names.stage)) rmSync(join(cacheRoot, names.stage), { recursive: true, force: true });
  return kept;
}
const abandonedStageMs = 24 * 60 * 60 * 1000;
/** Private stages a killed process left before journaling (or a full swap left before its
 * receipt). Only day-old stages no journal names are removed, under the work lock, so a stage
 * another process is still building is never touched. Moved-aside folders are user bytes and stay. */
export function sweepCheckoutStages(cacheRoot: string, now = Date.now()) {
  const journalPath = join(cacheRoot, deltaJournalName);
  let owned: unknown;
  try {
    owned = exists(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')).stage : undefined;
  } catch {
    return;
  }
  for (const name of readdirSync(cacheRoot)) {
    if (!/^(delta|checkout)-[A-Za-z0-9_-]+$/.test(name) || name.endsWith('-displaced') || name === owned)
      continue;
    const stat = lstatSync(join(cacheRoot, name));
    if (stat.isDirectory() && !stat.isSymbolicLink() && now - stat.mtimeMs > abandonedStageMs)
      rmSync(join(cacheRoot, name), { recursive: true, force: true });
  }
}
