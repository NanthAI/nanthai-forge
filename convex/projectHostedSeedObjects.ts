// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { isStored } from './projectObjectFields';
import { findSourceObjects, findStoredObjects, type ObjectView } from './projectObjectFind';
import { retainSourceKey } from './projectSourceKeyProtection';
import { invariant } from '../src/errors';
import { requireSourceAuthority } from '../src/hosted-source-authority';
import { r2Key } from './r2';

export const seedRow = (ctx: QueryCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedSeeds')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();

export async function requireCatalogSeed(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  operationId: string,
  pending: boolean,
) {
  const project = await activeOwnedProject(ctx, projectId, owner);
  const seed = await seedRow(ctx, projectId);
  invariant(
    seed?.objectCatalog && seed.owner === owner && seed.operationId === operationId,
    'WORK_OPERATION_CHANGED',
    'Select the original catalog seed.',
  );
  if (pending) {
    invariant(!seed.backupId, 'SEED_COMMITTED', 'This seed already selected its source.');
    requireSourceAuthority(project, seed.authority);
  }
  return { seed, project };
}

/** Only seed-private reservations can lose their ID. Legacy, shared and
 * cleanup-rotated rows keep their exact binding and existing replay path. */
export async function seedObjectPins(ctx: MutationCtx, row: Doc<'projectObjects'>, operationId: string) {
  if (row.seedOperationId !== operationId || row.r2SweepKey || row.r2Key !== r2Key(row.projectId, row.digest))
    return null;
  const members = row.packMembers ?? [];
  const digests = members.map(member => member.digest);
  const stored = await findStoredObjects(ctx, row.projectId, digests);
  const pins: Pick<ObjectView, 'digest' | 'size' | 'pack'>[] = [];
  const carrier = (await findSourceObjects(ctx, row.projectId, [row.digest])).get(row.digest);
  if (!carrier) pins.push({ digest: row.digest, size: row.size });
  else {
    invariant(carrier.size === row.size, 'SOURCE_HASH_MISMATCH', 'Seed carrier size differs.');
    if (members.length && carrier.r2Key !== row.r2Key)
      await retainSourceKey(ctx, row.projectId, {
        sha256: row.digest,
        size: row.size,
        r2Key: row.r2Key,
      });
  }
  let offset = 0;
  for (const [index, member] of members.entries()) {
    const previous = stored[index];
    const pack = { digest: row.digest, size: row.size, offset };
    offset += member.size;
    if (previous) {
      invariant(
        !previous.removed && previous.size === member.size,
        'INVALID_WORK_BACKUP',
        'Content differs from its original binding.',
      );
      if (!isStored(previous) && previous._id && previous.location === 'r2') {
        // A pending carrier could also be a logical member of this pack.
        // Give it a readable fallback and let its own commit verify its members.
        if (previous.packMembers) pins.push({ ...member, pack });
        else
          await ctx.db.patch(previous._id, {
            pack,
            r2Key: row.r2Key,
            r2Committed: true,
            sourceReferenced: true,
          });
      }
    } else pins.push({ ...member, pack });
  }
  // The carrier has a protected raw binding as well as its logical members.
  return pins;
}
