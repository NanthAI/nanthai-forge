// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { projectPrefix } from './r2Operations';
import { projectRetentionMs } from './projectRetention';

export type PurgeAuthority = { prefix: string; operationId: string };
/** The only R2 delete grant a project purge has: its own prefix, for its own purge
 * operation, once the tombstone is final. The global FORGE_R2_MAINTENANCE flag is not
 * consulted; live, trashed (restorable), restored and foreign projects get nothing. */
export function purgeAuthority(
  project: Doc<'hostedProjects'> | null,
  now = Date.now(),
): PurgeAuthority | null {
  const purge = project?.purge;
  if (!project || project.removal !== 'deleting' || project.retention || !purge?.operationId.trim())
    return null;
  // Owner-confirmed: written only by the slug-confirmed delete transition.
  const confirmed = purge.reason === 'owner';
  // Day-90 expiry: written only by projectRetention:expire for this exact tombstone.
  const expired =
    purge.reason === 'retention' &&
    project.removedAt !== undefined &&
    purge.operationId === `retention:${project._id}:${project.removedAt}` &&
    now >= project.removedAt + projectRetentionMs;
  return confirmed || expired ? { prefix: projectPrefix(project._id), operationId: purge.operationId } : null;
}
/** Refuse any key outside the authorized project's prefix before a DELETE is signed. */
export function authorizedKeys(authority: PurgeAuthority, projectId: string, keys: string[]) {
  invariant(
    authority.prefix === projectPrefix(projectId) && keys.every(key => key.startsWith(authority.prefix)),
    'R2_PURGE_UNAUTHORIZED',
    'R2 deletes are limited to the purged project prefix.',
  );
  return keys;
}
