// SPDX-License-Identifier: Apache-2.0
// Grading branches (oracle/<cellId>) are created by the harness while no agent runs and must
// not outlive their cell. A network blip can leave one behind; the next batch reset then
// removes it, but only when it is provably this harness's own finished cell.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

/** Cell ids are `<arm>-n<N>-r<rep>[-dry|-modelcheck]-a<attempt>-<UTC stamp>` (run-cell.mjs). */
const CELL_ID = /^(?:github|forge)-n\d+-r\d+(?:-dry|-modelcheck)?-a\d+-\d{8}T\d{6}$/;

/** The cell id a harness-owned grading branch name encodes, or null for any other branch. */
export const oracleBranchCell = name => {
  const m = /^oracle\/(.+)$/.exec(String(name));
  return m && CELL_ID.test(m[1]) ? m[1] : null;
};

/** Delays between delete attempts: at most 5 tries per branch (4 pauses, about 3 minutes in
 * all, long enough to ride out a short outage); grading is outside timing. */
export const DELETE_BACKOFF_MS = [5000, 15_000, 45_000, 120_000];
export const MAX_DELETE_TRIES = DELETE_BACKOFF_MS.length + 1;

/** Delete a ref, retrying every failure with backoff (a network blip is the usual cause).
 * A ref that is already gone counts as deleted. Never throws: the outcome is recorded so the
 * cell result and the next reset can see a branch that is still there. */
export async function deleteRefWithBackoff(request, path, { pause = wait, delays = DELETE_BACKOFF_MS } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await request(['api', '-X', 'DELETE', path]);
      return { deleted: true, attempts: attempt + 1 };
    } catch (error) {
      const text = `${error.stderr ?? ''}\n${error.message ?? ''}`;
      if (/Reference does not exist|HTTP 404/i.test(text)) return { deleted: true, attempts: attempt + 1 };
      lastError = String(error.stderr || error.message || error).slice(0, 300);
      if (attempt < delays.length) await pause(delays[attempt]);
    }
  }
  return { deleted: false, attempts: delays.length + 1, error: lastError };
}

/** The batch-ledger entry for a cell's grading branch: the delete outcome from the cell
 * result, or null when grading never created one. A failed delete stays visible there. */
export const oracleBranchRecord = result => result?.oracle?.branchCleanup ?? null;

/** Is this cell finished (its process wrote a result, or died without one)? Only then may a
 * later reset remove its grading branch. `runs` is the harness runs directory. */
export function cellFinished(runs, cellId, alive = pidAlive) {
  const dir = join(runs, cellId);
  if (existsSync(join(dir, 'result.json'))) return true;
  try {
    const { pid } = JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8'));
    return !alive(pid);
  } catch {
    return false; // unknown cell: not ours to remove
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
