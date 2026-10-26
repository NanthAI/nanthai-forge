// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { selectedGeneration, recordPartition } from './projectWorkIndexStore';
import { invariant } from '../src/errors';

/** Current indexed predicates are OCC reads in the same transaction as the
 * authority CAS. Terminal history is not scanned or rewritten. */
export async function requireHostedOwnerDrained(
  ctx: MutationCtx | QueryCtx,
  project: Doc<'hostedProjects'>,
  drain?: { revision: number; fingerprint: string },
) {
  const blockers: { kind: string; id: string; status: string }[] = [];
  const requested = await ctx.db
    .query('ownerAcceptanceRequests')
    .withIndex('by_project_state', q => q.eq('projectId', project._id).eq('state', 'requested'))
    .take(100);
  blockers.push(...requested.map(r => ({ kind: 'owner-acceptance', id: r.operationId, status: r.state })));
  const generation = await selectedGeneration(ctx, project);
  if (generation) {
    for (const [collection, statuses] of [
      ['landingEntries', ['queued', 'checking', 'awaiting-review']],
      ['landingBatches', ['composing', 'checking']],
    ] as const) {
      for (const status of statuses) {
        const rows = await ctx.db
          .query('projectWorkRecords')
          .withIndex('by_generation_and_collection_and_status_and_position', q =>
            q
              .eq('generationId', recordPartition(generation))
              .eq('collection', collection)
              .eq('status', status),
          )
          .take(100);
        blockers.push(...rows.map(row => ({ kind: collection, id: row.key, status })));
      }
    }
  }
  invariant(
    !blockers.length,
    'SOURCE_AUTHORITY_DRAIN_REQUIRED',
    `Owner landing work must settle before switching authority: ${JSON.stringify(blockers)}. Resume the original requests; none were cancelled.`,
  );
  if (project.currentBackup !== null) {
    const backup = await ctx.db.get(project.currentBackup);
    invariant(
      drain && backup && backup.preview.revision === drain.revision,
      'SOURCE_AUTHORITY_DRAIN_REQUIRED',
      'Switch through the bound owner after its queue and journals drain, with the exact seeded owner revision.',
    );
  }
}
