// SPDX-License-Identifier: Apache-2.0
// Removal markers: when a person loses write access to a project, every active sealed set of the project marks
// that account's entries. Holders see the marker on their next read, and a person's next write on an owner device
// removes the entries and re-keys (design 5.5). The server opens nothing and changes no signed record.
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { forgeSecretId } from '../src/sealed-portable';
import { markersForRemovedAccount } from './sealedSecretGate';

/** One indexed read per set kind (at most three rows) and one patch per set that changes; no other call. */
export async function markRemovedAccount(ctx: MutationCtx, projectId: Id<'hostedProjects'>, account: string) {
  const accountId = forgeSecretId('account', account);
  for (const kind of [1, 2, 3] as const) {
    const set = await ctx.db
      .query('sealedSecretSets')
      .withIndex('by_project_and_kind_and_active', q =>
        q.eq('projectId', projectId).eq('kind', kind).eq('active', true),
      )
      .unique();
    const next = set && markersForRemovedAccount(set, accountId);
    if (next)
      await ctx.db.patch(set._id, {
        revoked: next.revoked.length ? next.revoked : undefined,
        joinRequests: next.joinRequests.length ? next.joinRequests : undefined,
      });
  }
}
