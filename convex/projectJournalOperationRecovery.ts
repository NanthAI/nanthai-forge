// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { digest } from '../src/state/hash';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
/** Operation transport is immutable after terminal, while the recovery ledger beside it
 * can still advance. Export the current ledger once; keep every prior object retained. */
export async function journalOperationRecoveryRow(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  text: string,
) {
  const original = JSON.parse(text);
  const current = await ctx.db.get(original._id as Id<'projectHostedOperations'>);
  invariant(
    !current || current.projectId === projectId,
    'EVIDENCE_CHANGED',
    'Journal operation project differs.',
  );
  if (current) {
    if (!current.journalSegment) return null; // The live export already owns this physical row.
    if (current.journalDigest && current.journalDigest !== digest(text)) return null;
    if (current.recovery === undefined) delete original.recovery;
    else original.recovery = current.recovery;
    return canonicalPayload(original);
  }
  const owner = await ctx.db
    .query('projectJournalReceipts')
    .withIndex('by_project_and_operation', q =>
      q.eq('projectId', projectId).eq('operationId', `journal-operation:${original._id}`),
    )
    .unique();
  return owner && owner.hash !== digest(text) ? null : text;
}
