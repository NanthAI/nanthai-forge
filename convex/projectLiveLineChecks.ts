// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { effectivePolicy } from '../src/autonomy-policy';
import { hostedBatching, hostedPipelineWidth } from '../src/hosted-landing-batch';
import type { HostedCheckRun } from '../src/hosted-check';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import { landingSuspect } from '../src/hosted-landing-suspect';
import type { QueueStatusKey } from '../src/hosted-queue-status';
import { landingRequestOriginalDb } from './projectLandingRequestBody';

export const lineChecksView = v.object({
  runs: v.array(
    v.object({
      groups: v.array(v.string()),
      lanes: v.number(),
      at: v.number(),
      reserved: v.optional(v.literal(true)),
      /** The check holds a slot but its CI run has not started (Item 9e748e41): `at` is when it was requested. */
      starting: v.optional(v.literal(true)),
    }),
  ),
  free: v.optional(v.number()),
  /** The middle of this project's recent pickup times (request to CI start), in ms, from the runs in view: a start that
   * waits several times longer is slow. */
  pickupMs: v.optional(v.number()),
  partial: v.optional(v.literal(true)),
});

async function freeCheckSlots(db: QueryCtx['db'], project: Doc<'hostedProjects'>, checking: boolean) {
  // Read capacity from the existing policy receipt without watching the project's mutable Work header.
  const latest = await db
    .query('projectPolicyChanges')
    .withIndex('by_project', q => q.eq('projectId', project._id))
    .order('desc')
    .first();
  // A plan-visibility row (Item 65b6d701) carries the default policy on a project that never stored one; it is not a receipt.
  const receipt = latest?.planChange && !project.autonomyPolicy ? undefined : latest?.policy;
  const policy = receipt ?? (project.autonomyPolicy ? effectivePolicy(project) : undefined);
  if (!policy && !checking) return undefined;
  const queue = await db
    .query('projectHostedLandingQueues')
    .withIndex('by_project_and_channel', q => q.eq('projectId', project._id).eq('channel', 'main'))
    .unique();
  const train = queue?.train ?? [];
  if (!train.length) return policy && hostedBatching(policy) ? hostedPipelineWidth(policy) : undefined;

  // The dispatcher reserves groups from the retained train. Independent admission
  // checks can appear in the directory but cannot consume these speculative slots.
  const pages = await db
    .query('projectHostedLandingQueueStatus')
    .withIndex('by_project_and_page', q => q.eq('projectId', project._id))
    .order('desc')
    .take(3);
  const directory = new Map(
    pages.flatMap(page => (JSON.parse(page.value) as QueueStatusKey[]).map(key => [key.id, key] as const)),
  );
  const keys = train.flatMap(id => directory.get(id) ?? []);
  if (keys.length !== train.length) return undefined;
  const tailKey = keys.filter(key => key.held !== 'review').at(-1);
  if (!tailKey) return undefined;
  const tail = await landingRequestOriginalDb(db)
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', project._id).eq('submissionId', tailKey.id),
    )
    .unique();
  if (!tail || tail.hold || tail.pipelineRetiredAttemptId === tail.attemptId) return undefined;
  const state = JSON.parse(tail.value) as HostedLandingState;
  if (landingSuspect(state)) return undefined;
  const row = await db
    .query('projectHostedLandingAttempts')
    .withIndex('by_project_and_attempt', q => q.eq('projectId', project._id).eq('attemptId', tail.attemptId))
    .unique();
  if (!row) return undefined;
  const attempt = JSON.parse(row.value) as HostedLandingAttempt;
  if (!attempt.policy || !hostedBatching(attempt.policy)) return undefined;
  const occupied = new Set(keys.map(key => key.batchId ?? key.id)).size;
  return Math.max(0, hostedPipelineWidth(attempt.policy) - occupied);
}

export async function lineChecks(
  db: QueryCtx['db'],
  project: Doc<'hostedProjects'>,
  marks: Pick<Doc<'projectLiveLineLanes'>, 'check' | 'held' | 'stage'>[],
) {
  const laneCounts = new Map<string, number>();
  let partial = marks.length === 101;
  for (const mark of marks) {
    if (mark.stage !== 'checking' || mark.held) continue;
    if (mark.check) laneCounts.set(mark.check, (laneCounts.get(mark.check) ?? 0) + 1);
    else partial = true;
  }
  const [landings, free] = await Promise.all([
    laneCounts.size
      ? landingRequestOriginalDb(db)
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
            q.eq('projectId', project._id).eq('channel', 'main').eq('phase', 'checking'),
          )
          .paginate({ cursor: null, numItems: 64, maximumRowsRead: 64, maximumBytesRead: 512 * 1024 })
      : null,
    freeCheckSlots(db, project, laneCounts.size > 0),
  ]);
  const groups = new Map<string, Set<string | null>>();
  // When each group was requested (its earliest landing row), for a check whose CI run has not started.
  const requested = new Map<string, number>();
  for (const landing of landings?.page ?? []) {
    const state = JSON.parse(landing.value) as {
      batchId?: string;
      timing?: { checkReservedAt?: string | number };
    };
    const key = (state.batchId ?? landing.submissionId).slice(0, 8);
    if (!laneCounts.has(key)) continue;
    const group = groups.get(key) ?? new Set<string | null>();
    group.add(landing.runId ?? null);
    groups.set(key, group);
    // When this check was requested: its reservation (not the landing's creation, which includes the queue wait).
    const reserved = state.timing?.checkReservedAt;
    const asked = typeof reserved === 'number' ? reserved : Date.parse(reserved ?? '');
    requested.set(
      key,
      Math.min(requested.get(key) ?? Infinity, Number.isFinite(asked) ? asked : landing._creationTime),
    );
  }
  const runGroups = new Map<string, { lanes: number; groups: string[] }>();
  const starting: (typeof lineChecksView.type)['runs'] = [];
  for (const [key, lanes] of laneCounts) {
    const runs = groups.get(key);
    const runId = runs?.values().next().value;
    if (!landings?.isDone || runs?.size !== 1) {
      // A split may briefly associate one group of marks with several runs.
      // No one of those runs can claim all of the group's Lanes.
      partial = true;
      continue;
    }
    if (!runId) {
      // In the checking phase with no CI run yet: it holds a slot, so it is drawn and counted as starting.
      starting.push({ groups: [key], lanes, at: requested.get(key)!, starting: true });
      continue;
    }
    const group = runGroups.get(runId) ?? { lanes: 0, groups: [] };
    group.lanes += lanes;
    group.groups.push(key);
    runGroups.set(runId, group);
  }
  // Convex allows one paginate per query. This indexed range is bounded by
  // nine documents even if unrelated check-only runs are also in flight.
  const active = runGroups.size
    ? await db
        .query('projectHostedCheckRuns')
        .withIndex('by_project_and_status', q => q.eq('projectId', project._id).eq('status', 'running'))
        .order('desc')
        .take(9)
    : [];
  const runs: (typeof lineChecksView.type)['runs'] = [];
  const pickups: number[] = [];
  const seen = new Set<string>();
  for (const row of active.slice(0, 8).reverse()) {
    const group = runGroups.get(row.runId);
    if (!group) continue;
    seen.add(row.runId);
    if (row.shardStartedAt !== undefined) {
      runs.push({ ...group, at: row.shardStartedAt });
      const asked = Date.parse((JSON.parse(row.value) as Pick<HostedCheckRun, 'at'>).at);
      if (Number.isFinite(asked) && row.shardStartedAt >= asked) pickups.push(row.shardStartedAt - asked);
    } else {
      const run = JSON.parse(row.value) as Pick<HostedCheckRun, 'at'>;
      const at = Date.parse(run.at);
      if (Number.isFinite(at)) runs.push({ ...group, at, reserved: true });
      else partial = true;
    }
  }
  // A run the landing names but that is not running yet (queued at the CI provider) holds its slot too. Only said when the
  // read of running runs was not capped: a capped read cannot tell a run that has not started from one it did not list.
  for (const [runId, group] of runGroups)
    if (!seen.has(runId) && active.length < 9)
      starting.push({
        ...group,
        at: Math.min(...group.groups.map(key => requested.get(key) ?? Infinity)),
        starting: true,
      });
  runs.push(...starting.filter(run => Number.isFinite(run.at)));
  const pickupMs = pickups.sort((a, b) => a - b)[Math.floor(pickups.length / 2)];
  return {
    runs,
    ...(pickupMs === undefined ? {} : { pickupMs }),
    ...(free === undefined ? {} : { free }),
    ...(partial || active.length === 9 || (landings && !landings.isDone) ? { partial: true as const } : {}),
  };
}
