// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { GithubSyncCommit } from '../src/github-sync-types';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { mirrorMessage } from '../src/landing-message';
import { HOSTED_BATCH_MEMBERS } from '../src/hosted-landing-batch';
import { acceptanceRow } from './projectHostedAcceptanceStore';

/** Normal adjacent publishes add no reads. Only skipped landings need a bounded history summary;
 * seed() pins the resulting message before GitHub IO, including on a lost-reply replay. */
export async function mirrorPublishMessage(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  receipt: HostedAcceptance,
  sequence: number,
  binding: GithubSyncCommit | null,
  fallback: string,
) {
  const input = {
    ...receipt,
    fallback,
    state: receipt.candidate.head,
    acceptanceId: receipt.id,
    viewId: receipt.candidate.id,
  };
  if (!binding || receipt.previous.head === binding.state)
    return mirrorMessage({ ...input, members: await batchMembers(ctx, projectId, receipt, sequence) });
  const previous = await acceptanceRow(ctx, { projectId, receiptId: binding.acceptanceId });
  const covered = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_sequence', q =>
      q
        .eq('projectId', projectId)
        .gt('sequence', previous?.sequence ?? 0)
        .lte('sequence', sequence),
    )
    .order('asc')
    .take(21);
  // Native/import mappings may precede the first hosted receipt and its nonzero source revision.
  const count = sequence - (previous?.sequence ?? (covered[0]?.sequence ?? sequence) - 1);
  const landings = covered.slice(0, 20).map(row => hostedAcceptanceSchema.parse(JSON.parse(row.value)));
  const lines = landings.map(landing => {
    const subject = (landing.cohortMessages?.[0] ?? landing.message ?? 'Forge landing').split('\n')[0];
    return `- ${subject || 'Forge landing'} (${landing.id.slice(0, 8)})`;
  });
  if (count > lines.length) lines.push(`…and ${count - lines.length} more`);
  return mirrorMessage({
    ...input,
    message: undefined,
    cohortMessages: undefined,
    // Each covered landing's own agent, from the rows already read (no added reads).
    members: landings.map(landing => ({ message: landing.message, agentClient: landing.agentClient })),
    fallback: `Catch up ${count} Forge landings\n\n${lines.join('\n')}`,
  });
}

/** A batch's last receipt carries every member's message but only its own agent client. Its
 * members are the receipts up to it with the same batchId: consecutive sequences, at most
 * HOSTED_BATCH_MEMBERS. One bounded indexed read, only for a batch's last receipt. */
export async function batchMembers(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  receipt: HostedAcceptance,
  sequence: number,
) {
  if (!receipt.batchId || !receipt.cohortMessages) return undefined;
  const rows = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_sequence', q =>
      q
        .eq('projectId', projectId)
        .gt('sequence', sequence - HOSTED_BATCH_MEMBERS)
        .lte('sequence', sequence),
    )
    .order('asc')
    .take(HOSTED_BATCH_MEMBERS);
  return rows
    .map(row => hostedAcceptanceSchema.parse(JSON.parse(row.value)))
    .filter(member => member.batchId === receipt.batchId)
    .map(member => ({ message: member.message, agentClient: member.agentClient }));
}
