// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { GithubSyncCommit } from '../src/github-sync-types';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { mirrorMessage } from '../src/landing-message';
import { landingMessageText } from './projectHostedLandingMessageBody';
import {
  cohortMessageFields,
  cohortReceipt,
  readCohortReceipts,
  selectCohortReceipts,
} from './projectHostedAcceptanceMessage';
import { acceptanceRow } from './projectHostedAcceptanceStore';

/** Adjacent publishes resolve the selected receipt or cohort. Catch-up uses the same bounded
 * receipts. seed() pins the message before GitHub IO, including on a lost-reply replay. */
export async function mirrorPublishMessage(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  receipt: HostedAcceptance,
  sequence: number,
  binding: GithubSyncCommit | null,
  fallback: () => Promise<string>,
) {
  const input = {
    ...receipt,
    state: receipt.candidate.head,
    acceptanceId: receipt.id,
    viewId: receipt.candidate.id,
  };
  if (!binding || receipt.previous.head === binding.state) {
    const fields = cohortReceipt(receipt)
      ? await cohortMessageFields(
          ctx,
          projectId,
          receipt,
          sequence,
          await readCohortReceipts(ctx, projectId, receipt, sequence),
        )
      : undefined;
    const message = fields?.members.at(-1)?.message ?? (await landingMessageText(ctx, projectId, receipt));
    return mirrorMessage({
      ...input,
      ...fields,
      message,
      fallback: message !== undefined || fields?.cohortMessages.length ? '' : await fallback(),
    });
  }
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
  const landings = covered
    .slice(0, 20)
    .map(row => ({ sequence: row.sequence, receipt: hostedAcceptanceSchema.parse(JSON.parse(row.value)) }));
  const members = await Promise.all(
    landings.map(async ({ receipt: landing }) => ({
      message: await landingMessageText(ctx, projectId, landing),
      agentClient: landing.agentClient,
    })),
  );
  const selected = new Map(landings.map(({ receipt }, index) => [receipt.id, members[index]!]));
  const lines = await Promise.all(
    landings.map(async ({ receipt: landing, sequence }, index) => {
      let cohortSubject = landing.cohortMessages?.[0];
      if (landing.cohortSize !== undefined) {
        const candidates =
          sequence - landing.cohortSize < landings[0]!.sequence
            ? await readCohortReceipts(ctx, projectId, landing, sequence)
            : landings;
        for (const member of selectCohortReceipts(projectId, landing, sequence, candidates)) {
          const cached = selected.get(member.id);
          cohortSubject = cached ? cached.message : await landingMessageText(ctx, projectId, member);
          if (cohortSubject !== undefined) break;
        }
      }
      const subject = (cohortSubject ?? members[index]!.message ?? 'Forge landing').split('\n')[0];
      return `- ${subject || 'Forge landing'} (${landing.id.slice(0, 8)})`;
    }),
  );
  if (count > lines.length) lines.push(`…and ${count - lines.length} more`);
  return mirrorMessage({
    ...input,
    message: undefined,
    cohortMessages: undefined,
    members,
    fallback: `Catch up ${count} Forge landings\n\n${lines.join('\n')}`,
  });
}
