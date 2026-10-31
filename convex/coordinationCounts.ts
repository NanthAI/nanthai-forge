// SPDX-License-Identifier: Apache-2.0
import { collapseSessions } from '../src/presence';
import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import { coordinationQuery } from './cliServer';
import type { Doc } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { liveSession } from './coordinationSessions';
import { COORDINATION_LANE_ACTIVE_MS, COORDINATION_STALE_MS } from '../src/coordination-types';
import type { HostedLaneSummary, HostedRunSummary, HostedViewSummary } from '../src/work-hosted-summary';
import { invariant } from '../src/errors';
import { report } from './errors';

const countFields = v.object({
  activeAgents: v.number(),
  activeSubagents: v.number(),
  activePeople: v.number(),
  activeLanes: v.number(),
  unannouncedActiveLanes: v.number(),
});
/** Never return rows from this helper: its public caller must expose counts only. */
async function activityCounts(ctx: QueryCtx, project: Doc<'hostedProjects'>) {
  const now = Date.now(),
    since = now - COORDINATION_LANE_ACTIVE_MS;
  const result = {
    activeAgents: 0,
    activeSubagents: 0,
    activePeople: 0,
    activeLanes: 0,
    unannouncedActiveLanes: 0,
  };
  const attributed = new Set<string>(),
    lanes = new Set<string>();
  const live = new Set<string>();
  const sessions: Doc<'projectCoordinationSessions'>[] = [];
  for await (const row of ctx.db
    .query('projectCoordinationSessions')
    .withIndex('by_project_and_lastSeen', q =>
      q.eq('projectId', project._id).gte('lastSeen', now - COORDINATION_STALE_MS),
    )) {
    sessions.push(row);
  }
  for (const row of collapseSessions(sessions)) {
    if (!liveSession(row, now)) continue;
    live.add(row.sessionId);
    if (row.context.laneId) attributed.add(row.context.laneId);
    const kind = row.kind ?? 'agent';
    if (kind === 'person') result.activePeople++;
    else if (kind === 'subagent' || row.parentSessionId) result.activeSubagents++;
    else result.activeAgents++;
  }
  for await (const row of ctx.db
    .query('projectCoordinationEvents')
    .withIndex('by_project_and_at', q => q.eq('projectId', project._id).gte('at', since))) {
    const command = row.command;
    const laneId = 'laneId' in command ? command.laneId : undefined;
    if (!laneId) continue;
    if (
      command.kind === 'claim' ||
      (command.kind === 'change' &&
        (command.source === 'return' || ['checkpoint', 'run-check', 'run'].includes(command.action ?? '')))
    )
      lanes.add(laneId);
  }
  for await (const claim of ctx.db
    .query('projectCoordinationClaims')
    .withIndex('by_project_and_expiresAt', q => q.eq('projectId', project._id).gt('expiresAt', now))) {
    if (!claim.releasedAt && claim.laneId && claim.sessionId && live.has(claim.sessionId))
      attributed.add(claim.laneId);
  }
  // Imported saves/checks also count: agents without an announcement do not disappear.
  // Read summaries only, never hydrate source, prompts, logs or full Work payloads.
  const generation = await selectedGeneration(ctx, project);
  if (generation) {
    const partition = recordPartition(generation);
    const rows = (collection: string) =>
      ctx.db
        .query('projectWorkRecords')
        .withIndex('by_generation_and_collection_and_activityAt', q =>
          q.eq('generationId', partition).eq('collection', collection).gte('activityAt', since),
        );
    for await (const row of rows('lanes')) {
      const lane = JSON.parse(row.value) as HostedLaneSummary;
      if (lane.lastCheckpointAt && Date.parse(lane.lastCheckpointAt) >= since) lanes.add(lane.id);
    }
    for await (const row of rows('runs')) {
      const run = JSON.parse(row.value) as HostedRunSummary;
      if (!(Math.max(Date.parse(run.startedAt), Date.parse(run.endedAt ?? run.startedAt)) >= since)) continue;
      const viewRow = await record(ctx, partition, 'views', run.viewId);
      const view = viewRow ? (JSON.parse(viewRow.value) as HostedViewSummary) : null;
      for (const input of view?.inputs ?? []) lanes.add(input.laneId);
    }
    for await (const request of ctx.db
      .query('projectCheckRequests')
      .withIndex('by_project_and_updatedAt', q => q.eq('projectId', project._id).gte('updatedAt', since))) {
      if (!request.report?.startedAt) continue;
      const viewRow = await record(ctx, partition, 'views', request.viewId);
      const view = viewRow ? (JSON.parse(viewRow.value) as HostedViewSummary) : null;
      for (const input of view?.inputs ?? []) lanes.add(input.laneId);
    }
  }
  result.activeLanes = lanes.size;
  result.unannouncedActiveLanes = [...lanes].filter(id => !attributed.has(id)).length;
  return result;
}
// Reactive on server writes only: a client-supplied time argument would re-run this per project per minute
// for every idle tab. Counts stay as of the last write until the next one.
const args = { projectId: v.id('hostedProjects') };
export const counts = coordinationQuery({
  args,
  returns: countFields,
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project activity.');
      return await activityCounts(ctx, await accessibleProject(ctx, projectId, user.subject));
    } catch (error) {
      return report(error);
    }
  },
});
export const publicCounts = coordinationQuery({
  args,
  returns: countFields,
  handler: async (ctx, { projectId }) => {
    try {
      const project = await ctx.db.get(projectId);
      invariant(
        project?.visibility === 'public' && !project.removal,
        'PROJECT_UNAVAILABLE',
        'This public project is unavailable.',
      );
      return await activityCounts(ctx, project);
    } catch (error) {
      return report(error);
    }
  },
});
