// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { BatchIdentity, LandingBatch } from './projectHostedLandingBatchStore';
import { writeBatch } from './projectHostedLandingBatchStore';
import { loadLanding, writeLanding } from './projectHostedLandingStore';
import { wakeLandingQueue } from './projectHostedLandingWake';

/** Re-select before reserving a batch check. Late composition IO cannot revive
 * this retired batch; an already reserved/running check is always left intact. */
export async function releaseUnstartedBatchForPriority(
  ctx: MutationCtx,
  input: BatchIdentity,
  batch: LandingBatch,
) {
  if (batch.phase !== 'composing') return false;
  const members = [];
  for (const member of batch.members)
    members.push(await loadLanding(ctx, { projectId: input.projectId, submissionId: member.submissionId }));
  const urgentMember = members.some(m => m.state.priority === 'urgent');
  const normalMember = members.some(m => m.state.priority !== 'urgent');
  if (!normalMember) return false;
  // Members of another unstarted batch are queued but not runnable. They must
  // retain their priority too; reserved checks have already left queued.
  if (!urgentMember) {
    const urgent = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_channel_and_phase_and_priority_and_sequence', q =>
        q
          .eq('projectId', input.projectId)
          .eq('channel', 'main')
          .eq('phase', 'queued')
          .eq('priority', 'urgent'),
      )
      .order('asc')
      .take(1);
    if (!urgent.length) return false;
  }
  await writeBatch(ctx, input, { ...batch, phase: 'superseded' });
  for (const member of members) {
    if (['landed', 'terminal-failed'].includes(member.state.phase)) continue;
    const { batchId: _batchId, ...state } = member.state;
    void _batchId;
    await writeLanding(ctx, member.row, { ...state, phase: 'queued', version: state.version + 1 }, true);
  }
  await wakeLandingQueue(ctx, { projectId: input.projectId, channel: 'main' });
  return true;
}
