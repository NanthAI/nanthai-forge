// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { durableReplace } from './native-durability.js';
import { retainedRootSibling } from './root-paths.js';

/** How long this project's hosted landing checks ran, from the landing timing the client already
 * holds when `land` or `wait` sees a check end (`ciObservedAt` or `checkReservedAt` to `ciEndedAt`).
 * Preflight prices a package command it has never timed here with it: a hosted check runs the
 * project's whole CI build, so it bounds any subset of packages. A disposable clone-local record
 * shared by sibling Lanes, never uploaded; no server call. */
const MAX_RUNS = 8;
/** Longer than any check a landing waits for; a bogus span never prices a plan. */
const MAX_MS = 6 * 60 * 60 * 1000;
const storeSchema = z
  .array(z.object({ endedAt: z.string(), ms: z.number().positive() }).strict())
  .max(MAX_RUNS);
const storePath = (root: string) =>
  join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-hosted.json');

function read(root: string) {
  try {
    return storeSchema.parse(JSON.parse(readFileSync(storePath(root), 'utf8')));
  } catch {
    return [];
  }
}

type Timing = { checkReservedAt?: unknown; ciObservedAt?: unknown; ciEndedAt?: unknown };

/** Records one ended hosted check from a landing's timing; repeated observations of the same check
 * (wait replays) record it once. Never throws. */
export function rememberHostedCheck(root: string, timing: Timing | undefined) {
  try {
    const ended = typeof timing?.ciEndedAt === 'string' ? timing.ciEndedAt : null;
    const start = [timing?.ciObservedAt, timing?.checkReservedAt].find(
      (value): value is string => typeof value === 'string',
    );
    if (!ended || !start) return;
    const ms = Date.parse(ended) - Date.parse(start);
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_MS) return;
    const runs = read(root);
    if (runs.some(run => run.endedAt === ended)) return;
    mkdirSync(join(storePath(root), '..'), { recursive: true, mode: 0o700 });
    durableReplace(storePath(root), JSON.stringify([...runs, { endedAt: ended, ms }].slice(-MAX_RUNS)));
  } catch {
    /* A timing hint never changes a landing outcome. */
  }
}

/** The median of the recent hosted check durations (seconds), or null when none was seen. */
export function hostedCheckSeconds(root: string): number | null {
  const runs = read(root)
    .map(run => run.ms)
    .sort((a, b) => a - b);
  if (!runs.length) return null;
  const middle = Math.floor(runs.length / 2);
  const ms = runs.length % 2 ? runs[middle]! : (runs[middle - 1]! + runs[middle]!) / 2;
  return ms / 1000;
}
