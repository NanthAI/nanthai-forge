// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableReplace } from './state/durability.js';
import { retainedRootSibling } from './root-paths.js';
import { type GuardCandidates, guardCandidatesSchema } from './hosted-lane.js';

/** The project's learned preflight guard-set candidates as the last Lane start delivered them
 * (13ea93bf). One small file shared by the clone and its Lane folders; read by preflight planning,
 * written only when a start reply carries a new revision. */
const cachePath = (root: string) =>
  join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-guards.json');
export function cachedGuardCandidates(root: string): GuardCandidates | null {
  try {
    return guardCandidatesSchema.parse(JSON.parse(readFileSync(cachePath(root), 'utf8')));
  } catch {
    return null;
  }
}
/** The revision a start sends: the server replies with candidates only when its own differs. */
export const cachedGuardRevision = (root: string) => cachedGuardCandidates(root)?.rev ?? '';
/** A start reply's candidates replace the cached ones. A hint: never fails the start. */
export function storeGuardCandidates(root: string, candidates: GuardCandidates) {
  try {
    mkdirSync(join(cachePath(root), '..'), { recursive: true, mode: 0o700 });
    durableReplace(cachePath(root), JSON.stringify(candidates));
  } catch {
    /* The next start delivers them again. */
  }
}
