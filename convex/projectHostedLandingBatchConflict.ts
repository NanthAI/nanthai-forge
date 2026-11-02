import { candidateOwnerInputs } from './projectHostedProvenance';
import { activeProject } from './projectAuthority';
// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import type { BatchDropped } from '../src/hosted-landing-batch';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { insertLandingAttempt, loadLanding, writeLanding } from './projectHostedLandingStore';
import { failFinish } from './projectHostedFinishStore';
import { hostedRecordSchema } from '../src/hosted-records';
import { ForgeError, invariant } from '../src/errors';
import { hostedStartMain } from './projectHostedChannels';

/** Retain a resolvable Candidate for this particular rejected merge, including
 * the worker's exact conflict root. The original clean selection is immutable. */
export async function retainBatchConflict(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    member: HostedLandingAttempt;
    main: HostedLandingAttempt['main'];
    conflict: BatchDropped[number];
    peerLanes: string[];
    ownerInputs: boolean;
    at: string;
  },
) {
  const { member } = input;
  const main = await hostedStartMain(ctx, input.projectId);
  invariant(
    input.main.head === main.head && input.main.receiptId === main.receipt.id,
    'CHANNEL_CHANGED',
    'Retain terminal conflicts only on the current accepted main base; recompose speculative or stale bases.',
  );
  const row = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: member.actor.id,
    kind: 'candidate',
    key: member.candidate.id,
  });
  invariant(row?.digest === member.candidate.digest, 'EVIDENCE_CHANGED', 'The conflicting member changed.');
  const old = hostedRecordSchema.options[3].parse(JSON.parse(row.value));
  const project = await activeProject(ctx, input.projectId, member.actor.id);
  const candidate = {
    ...old,
    id: crypto.randomUUID(),
    at: input.at,
    base: input.main,
    result: { status: 'conflict' as const, conflicts: input.conflict.conflicts },
  };
  const record = await writeHostedRecord(ctx, {
    projectId: input.projectId,
    actor: member.actor.id,
    authorityEpoch: member.authorityEpoch,
    expectedVersion: null,
    // The draft also contains the composed prefix, not only this member.
    ownerOnly: input.ownerInputs && candidateOwnerInputs(project, row, old, member.authorityEpoch),
    record: candidate,
  });
  const { deferredCheck, ...pins } = member;
  void deferredCheck;
  const attempt = {
    ...pins,
    id: crypto.randomUUID(),
    parentAttemptId: member.id,
    number: member.number + 1,
    check: null,
    candidate: { ...member.candidate, id: candidate.id, digest: record.digest, head: null },
  };
  await insertLandingAttempt(ctx, attempt);
  const current = await loadLanding(ctx, { projectId: input.projectId, submissionId: member.submissionId });
  await writeLanding(
    ctx,
    current.row,
    { ...current.state, version: current.state.version + 1, attemptId: attempt.id },
    false,
  );
  await failFinish(
    ctx,
    { projectId: input.projectId, submissionId: member.submissionId },
    'COMPOSITION_CONFLICT',
    `Candidate ${candidate.id} conflicts in ${(input.conflict.paths ?? []).join(', ')}${input.conflict.more ? ` (and ${input.conflict.more} more files)` : ''} against composed prefix ${input.main.head}${input.peerLanes.length ? ` (peer Lane(s) ${input.peerLanes.join(', ')})` : ''}; retained conflict root ${input.conflict.conflicts.sha256}. Run nforge agent . sync '${JSON.stringify({ candidateId: candidate.id })}', edit the returned conflict files, then run its resolve command.`,
  );
}

/** A rejected member owns its evidence/authority failure. Never let that error
 * retire an independently checked survivor generation in the caller. */
export async function settleMemberBatchConflict(...args: Parameters<typeof retainBatchConflict>) {
  try {
    await retainBatchConflict(...args);
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    const [ctx, input] = args;
    await failFinish(
      ctx,
      { projectId: input.projectId, submissionId: input.member.submissionId },
      error.code,
      error.message,
    );
  }
}
