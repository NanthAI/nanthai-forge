// SPDX-License-Identifier: Apache-2.0
// Explicit recovery only: retain the active cursor, then one current-main catch-up. Never on landing.
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { channelRow } from './projectHostedChannels';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { enqueueGithubMirror } from './projectGithubMirrorQueue';
import { mirrorRow, resumeMirrorJob } from './projectGithubMirrorRows';
import { hostedMainV2Schema } from '../src/hosted-main';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { githubSyncCommitSchema } from '../src/github-sync-types';
import { invariant } from '../src/errors';

export async function resumeMirrorQueue(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  replaceTask = false,
) {
  let queue = await mirrorRow(ctx, project._id);
  const channel = await channelRow(ctx, project._id);
  const main = channel ? hostedMainV2Schema.parse(JSON.parse(channel.selection)) : null;
  invariant(
    !main ||
      (main.projectId === project._id &&
        main.authority.mode === 'server' &&
        main.authority.epoch === project.sourceAuthority?.epoch),
    'SOURCE_AUTHORITY_CHANGED',
    'Retain this project’s current main and authority.',
  );
  const mapping = queue?.mapping ? githubSyncCommitSchema.parse(JSON.parse(queue.mapping)) : null;
  if (main && main.head !== mapping?.state) {
    const row = await acceptanceRow(ctx, { projectId: project._id, receiptId: main.receipt.id });
    // A native/import seed has no hosted acceptance yet; its first landing supplies one.
    invariant(
      row || main.receipt.kind !== 'server',
      'SOURCE_UNAVAILABLE',
      'The current main receipt is unavailable.',
    );
    if (row) {
      const receipt = hostedAcceptanceSchema.parse(JSON.parse(row.value));
      invariant(
        receipt.id === main.receipt.id &&
          receipt.projectId === project._id &&
          receipt.candidate.head === main.head &&
          receipt.authorityEpoch === project.sourceAuthority?.epoch,
        'SOURCE_AUTHORITY_CHANGED',
        'Retain the current main receipt and mirror authority.',
      );
      const enqueued = await enqueueGithubMirror(ctx, project, receipt);
      if (enqueued?.scheduled) return { status: 'scheduled' as const, jobId: enqueued.jobId, step: 0 };
      // An inbound acceptance may settle its active job while enqueuing the publish.
      queue = await mirrorRow(ctx, project._id);
    }
  }
  if (!queue?.activeId) return { status: 'nothing-to-resume' as const, jobId: null, step: null };
  const result = await resumeMirrorJob(ctx, queue.activeId, replaceTask);
  return {
    status: result.status === 'missing' ? ('nothing-to-resume' as const) : result.status,
    jobId: queue.activeId,
    step: result.step,
  };
}
