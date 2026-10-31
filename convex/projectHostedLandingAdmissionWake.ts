// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { HOSTED_BATCH_MEMBERS } from '../src/hosted-landing-batch';
import { wakeLandingQueue } from './projectHostedLandingEvents';

/** An admission left the admitting set. Admitted members that held for their
 * peers become selectable again; one bounded indexed window, no scan or timer. */
export async function releaseAdmissionWaiters(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const rows = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_batchable_and_phase_and_sequence', q =>
      q.eq('projectId', projectId).eq('channel', 'main').eq('batchable', true).eq('phase', 'queued'),
    )
    .take(2 * HOSTED_BATCH_MEMBERS);
  let released = false;
  for (const row of rows)
    if (!row.runnable && row.admission?.status === 'passed') {
      await ctx.db.patch(row._id, { runnable: true });
      released = true;
    }
  if (released) await wakeLandingQueue(ctx, { projectId, channel: 'main' });
}
