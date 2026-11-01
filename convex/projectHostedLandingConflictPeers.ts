// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import { loadFinish } from './projectHostedFinishStore';
import { loadLanding } from './projectHostedLandingStore';
import { loadBatch, type LandingBatch } from './projectHostedLandingBatchState';
import { acceptancePlan, acceptancePage } from './projectHostedAcceptanceStore';
import { composeRow } from './projectHostedComposeStore';
import { hostedPipelineWidth } from '../src/hosted-landing-batch';

/** Conflict attribution follows the retained exact prefix, including an
 * unaccepted speculative predecessor. It never infers independence from paths
 * or reads current Lane heads. Only metadata is read, only on a real conflict. */
export async function batchConflictPeers(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  batch: LandingBatch,
  candidateId: string,
  excluded: string[],
) {
  const lanes = new Set<string>();
  async function selection(member: HostedLandingAttempt) {
    const { value } = await loadFinish(ctx, { projectId, submissionId: member.submissionId });
    let after = '',
      remaining = value.source.inputs.count;
    while (remaining > 0) {
      const page = await ctx.db
        .query('projectHostedComposeSelections')
        .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
          q
            .eq('projectId', projectId)
            .eq('actor', member.actor.id)
            .eq('operationId', value.source.operationId)
            .eq('kind', 'inputs')
            .gt('key', after),
        )
        .take(Math.min(100, remaining));
      for (const entry of page) lanes.add(entry.key);
      if (!page.length) break;
      after = page.at(-1)!.key;
      remaining -= page.length;
    }
  }
  for (const member of batch.members) {
    if (member.candidate.id === candidateId) break;
    if (excluded.includes(member.candidate.id)) continue;
    if (!batch.included || batch.included.includes(member.submissionId)) await selection(member);
  }
  let previous = batch;
  for (
    let depth = 1;
    previous.predecessor && depth < hostedPipelineWidth(batch.members[0]!.policy);
    depth++
  ) {
    const { state } = await loadLanding(ctx, { projectId, submissionId: previous.predecessor.submissionId });
    if (!state.batchId) break;
    previous = (await loadBatch(ctx, { projectId, batchId: state.batchId })).batch;
    for (const member of previous.members)
      if (!previous.included || previous.included.includes(member.submissionId)) await selection(member);
  }
  const first = previous.members[0]!;
  const source = await composeRow(ctx, {
    projectId,
    actor: first.actor.id,
    operationId: previous.composeOperationId,
  });
  const receiptId = source ? JSON.parse(source.value).request.expectedMain.receiptId : first.main.receiptId;
  const identity = { projectId, receiptId };
  const plan = await acceptancePlan(ctx, identity);
  for (let index = 0; index < (plan?.inputPages ?? 0); index++) {
    const page = await acceptancePage(ctx, { ...identity, kind: 'inputs', index });
    if (page) for (const entry of JSON.parse(page.value).entries) lanes.add(entry.laneId);
  }
  return [...lanes];
}
