// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { mkdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { durableReplace } from './state/durability.js';
import { canonicalRoot, retainedRootSibling } from './root-paths.js';
import { type GuardCandidates, guardCandidatesSchema } from './hosted-lane.js';

/** The project's learned preflight guard-set candidates as the server last delivered them (13ea93bf):
 * on a Lane start, or on the capability read of `open`, `preflight` and `land`. One small file per
 * project on this machine, so every checkout of the project finds it: the clone, its Lane folders
 * and a Lane opened at any other path. Read by preflight planning; written only when a reply carries
 * a new revision, and touched when a reply says it is current. */
const projectOf = (root: string) => {
  // The checkout's own marker names its project: a Lane folder's, or the clone's main checkout.
  for (const marker of ['hosted-lane.json', 'hosted-main.json'])
    try {
      const id = (
        JSON.parse(readFileSync(join(canonicalRoot(root), '.forge', marker), 'utf8')) as {
          selection?: { projectId?: unknown };
        }
      ).selection?.projectId;
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
    } catch {
      /* No such marker here. */
    }
  return null;
};
/** Where planning looks: the project file, or beside the checkout when nothing names a project. */
export function guardCachePath(root: string, projectId: string | null = projectOf(root)) {
  return projectId && /^[A-Za-z0-9_-]{1,64}$/.test(projectId)
    ? join(
        process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
        'forge',
        'preflight-guards',
        `${projectId}.json`,
      )
    : join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-guards.json');
}
export function cachedGuardCandidates(root: string, projectId?: string): GuardCandidates | null {
  try {
    return guardCandidatesSchema.parse(JSON.parse(readFileSync(guardCachePath(root, projectId), 'utf8')));
  } catch {
    return null;
  }
}
/** The revision a start sends: the server replies with candidates only when its own differs. */
export const cachedGuardRevision = (root: string, projectId?: string) =>
  cachedGuardCandidates(root, projectId)?.rev ?? '';
/** A copy the server confirmed or replaced this recently is not asked about again by `open`,
 * `preflight` or `land` (starts always ask): at most one extra read per project per machine-hour. */
const FRESH_MS = 3600_000;
/** The revision those commands' capability read sends, or undefined while the copy is fresh. */
export function guardRevisionToAsk(root: string, projectId: string) {
  try {
    if (Date.now() - statSync(guardCachePath(root, projectId)).mtimeMs < FRESH_MS) return undefined;
  } catch {
    /* No copy yet: ask. */
  }
  return cachedGuardRevision(root, projectId);
}
/** A reply's candidates replace the cached ones; null (the server holds the same revision) marks the
 * copy current. A hint: never fails the command. */
export function storeGuardCandidates(root: string, candidates: GuardCandidates | null, projectId?: string) {
  try {
    const path = guardCachePath(root, projectId);
    if (!candidates) {
      const now = new Date();
      utimesSync(path, now, now);
      return;
    }
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    durableReplace(path, JSON.stringify(candidates));
  } catch {
    /* The next start delivers them again. */
  }
}
