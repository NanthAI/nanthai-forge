// SPDX-License-Identifier: Apache-2.0
// One landed Lane's own timing for its Lane page (Item a61d3c91): its time to main and stops, read from the
// receipt and the landing row the daily Stats close reads, measured the same way (src/stats-estimate.ts). Two point
// reads, only for a Lane that landed.
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { landingRow } from './projectHostedLandingStore';
import { statsLanding } from './projectStats';
import { landingStops } from '../src/stats-estimate';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedLandingState } from '../src/hosted-landing';

export async function landedTiming(ctx: QueryCtx, projectId: Id<'hostedProjects'>, receiptId: string) {
  const acceptance = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId).eq('receiptId', receiptId))
    .unique();
  if (!acceptance) return null;
  const request = await landingRow(ctx, { projectId, submissionId: acceptance.submissionId }, false);
  const state = request ? (JSON.parse(request.value) as HostedLandingState) : null;
  const stops = landingStops(statsLanding(JSON.parse(acceptance.value) as HostedAcceptance, state));
  const round = (s: number | null) => (s === null ? null : Math.round(s));
  return {
    toMain: round(stops.toMain),
    queue: round(stops.queue),
    check: round(stops.check),
    land: round(stops.land),
  };
}
