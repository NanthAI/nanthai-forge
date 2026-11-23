// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { clientCacheRoot } from './root-paths.js';
import { digest } from './hash.js';

/** Static check results a preflight passed before something later in the same run stopped it (a
 * local error after a node_modules relink, an interrupted test phase: Item 3f76a3df). The next
 * preflight of the same Lane head with the same selected checks keeps them instead of running them
 * again. One small local file per Lane, replaced by each run and removed once a run records its
 * receipt; never uploaded. */
const keptSchema = z.object({
  head: z.string(),
  scope: z.string(),
  names: z.array(z.string()),
  results: z.array(z.object({ name: z.string(), outcome: z.string(), ms: z.number() }).passthrough()),
});
const keptPath = (root: string, laneId: string) =>
  join(clientCacheRoot(root), 'agent', 'preflight', `${laneId}.static.json`);
/** Outcomes that let the tests run and need no rerun: a timed-out or unjudged check is never kept. */
const settled = new Set(['passed', 'pre-existing', 'forge-metadata']);
/** The run's judging scope (its saved changed paths, or none): a different scope reruns the checks. */
export const staticScopeKey = (changed: readonly string[] | null | undefined) =>
  changed === undefined ? 'all' : changed === null ? 'unknown' : digest([...changed].sort().join('\0'));
const sameNames = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().every((name, index) => name === [...right].sort()[index]);

export function keepPassedStatic<T extends { name: string; outcome: string; ms: number }>(
  root: string,
  laneId: string,
  head: string,
  scope: string,
  names: readonly string[],
  results: readonly T[],
) {
  if (!results.length || results.some(result => !settled.has(result.outcome))) return;
  try {
    const path = keptPath(root, laneId);
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, JSON.stringify({ head, scope, names, results }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch {
    /* Keeping results is an optimisation: the next run simply runs the checks again. */
  }
}

/** The kept results for exactly this head and check selection, or undefined. */
export function keptPassedStatic<T>(
  root: string,
  laneId: string,
  head: string,
  scope: string,
  names: readonly string[],
) {
  try {
    const kept = keptSchema.parse(JSON.parse(readFileSync(keptPath(root, laneId), 'utf8')));
    return kept.head === head &&
      kept.scope === scope &&
      sameNames(kept.names, names) &&
      kept.results.every(result => settled.has(result.outcome))
      ? (kept.results as T[])
      : undefined;
  } catch {
    return undefined;
  }
}

export function dropKeptStatic(root: string, laneId: string) {
  rmSync(keptPath(root, laneId), { force: true });
}
