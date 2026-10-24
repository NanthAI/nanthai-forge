// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { SaveIdentity } from './projectHostedSaveStore';
import { saveObject } from './projectHostedSaveStore';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { hostedWriteProject, writeHostedRecord } from './projectHostedRecords';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import type { SyncRequest } from '../src/hosted-sync';
import type { HostedOperation } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

/** One indexed receipt lookup, never a requested Lane head, latest Candidate,
 * history scan or inference from matching bytes after a lost acceptance reply. */
export async function prepareHostedRevert(
  ctx: MutationCtx,
  auth: SaveIdentity,
  request: Extract<SyncRequest, { kind: 'revert' }>,
  first: HostedOperation['firstAttempt'],
) {
  await hostedWriteProject(ctx, auth.projectId, auth.actor, request.authorityEpoch);
  const target = request.target;
  const row =
    target.kind === 'receipt'
      ? await acceptanceRow(ctx, { projectId: auth.projectId, receiptId: target.receiptId })
      : await ctx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_submission', q =>
            q.eq('projectId', auth.projectId).eq('submissionId', target.submissionId),
          )
          .unique();
  invariant(
    row,
    'NOT_FOUND',
    'The selected acceptance has no retained receipt; resolve its original outcome first.',
  );
  const receipt = hostedAcceptanceSchema.parse(JSON.parse(row.value));
  invariant(
    receipt.projectId === auth.projectId &&
      receipt.id === row.receiptId &&
      (target.kind === 'receipt'
        ? receipt.id === target.receiptId
        : receipt.submissionId === target.submissionId),
    'SOURCE_UNAVAILABLE',
    'The retained acceptance identity differs.',
  );
  const intentId = first.ids.intent!,
    base = { head: receipt.candidate.head, receiptId: receipt.id };
  await writeHostedRecord(ctx, {
    ...auth,
    authorityEpoch: request.authorityEpoch,
    expectedVersion: null,
    record: {
      kind: 'intent',
      id: intentId,
      version: 0,
      at: first.at,
      outcome: `Revert acceptance ${receipt.id}`,
      constraints: '',
      creatorAccountId: auth.actor,
      assigneeAccountIds: [],
      base,
      status: 'active',
    },
  });
  return {
    intentId,
    base,
    work: {
      mode: 'revert' as const,
      receiptId: receipt.id,
      previous: await saveObject(ctx, auth.projectId, { sha256: receipt.previous.head }),
      accepted: await saveObject(ctx, auth.projectId, { sha256: receipt.candidate.head }),
    },
  };
}
