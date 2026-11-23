// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
import { hostedCheckRunSchema } from '../src/hosted-check';
import { readHostedRecord } from './projectHostedRecords';
import { coverageLanding } from './projectHostedMainAuditState';

async function catchupEvidence(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  receipt: ReturnType<typeof hostedAcceptanceSchema.parse>,
) {
  if (!receipt.check || receipt.crossHeadProof) return;
  const stored = await ctx.db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_run', q => q.eq('projectId', project._id).eq('runId', receipt.check!.runId))
    .unique();
  const proof = stored ? hostedCheckRunSchema.safeParse(JSON.parse(stored.value)) : null;
  if (
    !proof?.success ||
    proof.data.status !== 'passed' ||
    proof.data.terminalDigest !== receipt.check.terminalDigest
  )
    return;
  const candidate = await readHostedRecord(ctx, {
    projectId: project._id,
    actor: project.owner,
    kind: 'candidate',
    key: receipt.candidate.id,
  });
  const paths: string[] | null = candidate ? (JSON.parse(candidate.value).governance?.paths ?? null) : null;
  return { run: proof.data, paths, coverage: coverageLanding(proof.data, paths) };
}

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
      const evidence = await catchupEvidence(ctx, project, receipt);
      const enqueued = await enqueueGithubMirror(ctx, project, receipt, evidence);
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
