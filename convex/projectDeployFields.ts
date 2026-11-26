// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const deployTarget = v.string();
export const deployOutcome = v.union(v.literal('succeeded'), v.literal('failed'), v.literal('smoke-failed'));
export const deployStatus = v.union(v.literal('queued'), deployOutcome);
export const deployFailureWork = v.union(
  v.object({ kind: v.literal('lane'), id: v.string() }),
  v.object({ kind: v.literal('item'), id: v.string() }),
);
export const deploySmokeCheck = v.object({
  name: v.string(),
  ok: v.boolean(),
  status: v.optional(v.number()),
  detail: v.optional(v.string()),
});
export const deploySmoke = v.object({
  ok: v.boolean(),
  checks: v.array(deploySmokeCheck),
});

/** Deploy outcomes reported by CI workflows (Item 8b6efb50). One small row per deploy run; indexed so
 * receipts and lane-history find the first successful deploy containing a landing (sequence >= L) in
 * one point-first read, wait subscribes without polling, and Needs you reads the newest row per target. */
export const deployTables = {
  projectDeploys: defineTable({
    projectId: v.id('hostedProjects'),
    target: deployTarget,
    workflow: v.optional(v.string()),
    sequence: v.number(),
    head: v.string(),
    status: deployStatus,
    runId: v.string(),
    at: v.string(),
    url: v.optional(v.string()),
    summary: v.optional(v.string()),
    smoke: v.optional(deploySmoke),
    failure: v.optional(
      v.object({
        key: v.string(),
        cause: v.string(),
        since: v.string(),
        sinceSequence: v.number(),
        liveSequence: v.union(v.number(), v.null()),
        work: v.optional(deployFailureWork),
      }),
    ),
    /** True when CI verified served bytes did not change (skipped upload or no served files changed). */
    unchanged: v.optional(v.literal(true)),
    /** Actual live deploy sequence currently served when `unchanged` is true. */
    liveSequence: v.optional(v.number()),
    /** Actual live deploy Forge State currently served when `unchanged` is true. */
    liveHead: v.optional(v.string()),
  })
    .index('by_project_and_target_and_status_and_sequence', ['projectId', 'target', 'status', 'sequence'])
    .index('by_project_and_target_and_sequence', ['projectId', 'target', 'sequence'])
    .index('by_project_and_target_and_run', ['projectId', 'target', 'runId']),
};
