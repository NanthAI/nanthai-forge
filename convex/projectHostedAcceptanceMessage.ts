// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { hostedAcceptanceSchema, type HostedAcceptance } from '../src/hosted-acceptance';
import { HOSTED_BATCH_MEMBERS } from '../src/hosted-landing-batch';
import { invariant } from '../src/errors';
import { landingMessageText } from './projectHostedLandingMessageBody';

type ReceiptEntry = { sequence: number; receipt: HostedAcceptance };

export function cohortReceipt(receipt: HostedAcceptance) {
  return receipt.cohortSize !== undefined || Boolean(receipt.batchId && receipt.cohortMessages !== undefined);
}

/** Receipts share a batch id and a contiguous sequence interval. Use the whole
 * bounded cohort when rendering one shared commit. */
export async function readCohortReceipts(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  receipt: HostedAcceptance,
  sequence: number,
) {
  // The immediately preceding sequence detects a marker whose size lost its first member.
  const count = receipt.cohortSize === undefined ? HOSTED_BATCH_MEMBERS : receipt.cohortSize + 1;
  const rows = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_sequence', q =>
      q
        .eq('projectId', projectId)
        .gt('sequence', sequence - count)
        .lte('sequence', sequence),
    )
    .order('asc')
    .take(count);
  return rows.map(row => ({
    sequence: row.sequence,
    receipt: hostedAcceptanceSchema.parse(JSON.parse(row.value)),
  }));
}

export function selectCohortReceipts(
  projectId: Id<'hostedProjects'>,
  receipt: HostedAcceptance,
  sequence: number,
  candidates: ReceiptEntry[],
) {
  const cohort = candidates.filter(
    member =>
      member.receipt.batchId === receipt.batchId && member.receipt.candidate.head === receipt.candidate.head,
  );
  if (receipt.cohortSize !== undefined)
    invariant(
      receipt.batchId &&
        receipt.projectId === projectId &&
        cohort.length === receipt.cohortSize &&
        cohort.at(-1)?.receipt.id === receipt.id &&
        cohort.every(
          (member, index) =>
            member.receipt.projectId === projectId &&
            member.sequence === sequence - cohort.length + 1 + index,
        ),
      'EVIDENCE_CHANGED',
      'The ordered landing cohort is incomplete.',
    );
  return cohort.map(member => member.receipt);
}

export async function cohortMessageFields(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  receipt: HostedAcceptance,
  sequence: number,
  candidates: ReceiptEntry[],
) {
  const cohort = selectCohortReceipts(projectId, receipt, sequence, candidates);
  const members = await Promise.all(
    cohort.map(async member => ({
      message: await landingMessageText(ctx, projectId, member),
      agentClient: member.agentClient,
      acceptanceId: member.id,
    })),
  );
  return {
    cohortMessages:
      receipt.cohortMessages ??
      members.flatMap(member => (member.message === undefined ? [] : [member.message])),
    members,
  };
}

export async function receiptMessageForReader(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  receipt: HostedAcceptance,
  sequence: number,
) {
  if (receipt.messageRef === undefined && receipt.cohortSize === undefined) return receipt;
  const { messageRef, cohortSize, ...result } = receipt;
  const fields =
    cohortSize === undefined
      ? undefined
      : await cohortMessageFields(
          ctx,
          projectId,
          receipt,
          sequence,
          await readCohortReceipts(ctx, projectId, receipt, sequence),
        );
  const message =
    fields?.members.at(-1)?.message ??
    (await landingMessageText(ctx, projectId, { messageRef, message: result.message }));
  return {
    ...result,
    ...(message === undefined ? {} : { message }),
    ...(fields ? { cohortMessages: fields.cohortMessages } : {}),
  };
}
