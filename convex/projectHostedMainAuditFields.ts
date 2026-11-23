// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v, type Infer } from 'convex/values';

const controlBuildChange = v.union(v.literal('same-source'), v.literal('source-also-changed'));
export type ControlBuildChange = Infer<typeof controlBuildChange>;
export function controlBuildReason(change: ControlBuildChange) {
  return change === 'same-source'
    ? "Forge's check harness changed. The same source passed before the change."
    : "Forge's check harness changed. The source also changed, leaving the cause unproven.";
}

export const checkGate = v.object({
  mode: v.union(
    v.literal('contract'),
    v.literal('scoped'),
    v.literal('audit'),
    v.literal('probe'),
    v.literal('full'),
  ),
  tests: v.optional(v.array(v.string())),
  contractVersion: v.optional(v.number()),
  reason: v.optional(v.string()),
  effective: v.optional(v.union(v.literal('contract'), v.literal('full'), v.literal('docs'))),
});
export const drillRecord = v.object({
  startedAt: v.string(),
  redAt: v.optional(v.string()),
  recoveredAt: v.optional(v.string()),
  endedAt: v.optional(v.string()),
  outcome: v.optional(v.union(v.literal('recovered'), v.literal('late'), v.literal('flake'))),
});
export const mainAuditFields = {
  projectId: v.id('hostedProjects'),
  lastGreen: v.optional(
    v.object({
      sequence: v.number(),
      /** Exact source checked by runId; docs-only coverage never changes this pin. */
      head: v.string(),
      runId: v.string(),
      coveredHead: v.optional(v.string()),
    }),
  ),
  unaudited: v.optional(v.object({ count: v.number(), firstAt: v.union(v.string(), v.null()) })),
  pendingFirstSequence: v.optional(v.number()),
  audit: v.optional(
    v.object({
      runId: v.string(),
      head: v.string(),
      sequence: v.number(),
      /** Coverage receipt for this occurrence, even when the check result was reused. */
      coverage: v.optional(v.string()),
      alreadyVerified: v.optional(v.number()),
      firstUnverifiedAt: v.optional(v.string()),
      status: v.union(
        v.literal('queued'),
        v.literal('preparing'),
        v.literal('dispatching'),
        v.literal('running'),
        v.literal('unknown'),
        v.literal('passed'),
        v.literal('failed'),
        v.literal('cancelled'),
        v.literal('interrupted'),
        v.literal('runner-unavailable'),
      ),
    }),
  ),
  red: v.optional(
    v.object({
      since: v.string(),
      sequence: v.optional(v.number()),
      auditedCount: v.optional(v.number()),
      /** Head of the work newer than this failed audit, even while the next audit is active. */
      firstNewerAt: v.optional(v.string()),
      head: v.string(),
      runId: v.string(),
      culprit: v.optional(v.string()),
      controlBuildChange: v.optional(controlBuildChange),
      /** Item 687d1eda: the latest failed audit's failing files (at most 20) and how many more, the
       * recovery's reason and fix Intent, and the receipt that made newly covered tests run. */
      tests: v.optional(v.array(v.string())),
      moreTests: v.optional(v.number()),
      reason: v.optional(v.string()),
      intentId: v.optional(v.string()),
      covered: v.optional(v.string()),
      /** The prepared reverse of the culprit waits for a person to accept it (autoRevertHold): nothing reverts on its own. */
      held: v.optional(v.boolean()),
      /** The failed audit the reason was decided for; a later failed audit in the episode marks it older. */
      reasonRunId: v.optional(v.string()),
    }),
  ),
  /** The last recovered episode's test evidence, kept for checks still pinned to its red head. */
  lastRed: v.optional(
    v.object({
      head: v.string(),
      passedAt: v.optional(v.string()),
      tests: v.optional(v.array(v.string())),
    }),
  ),
  debt: v.optional(v.boolean()),
  /** Newest main revision that landed on its first check (7fe54c7c); audited promptly. */
  firstCheck: v.optional(v.number()),
  wake: v.optional(
    v.object({ taskId: v.id('_scheduled_functions'), at: v.number(), retry: v.optional(v.literal(true)) }),
  ),
  lastAuditStartAt: v.optional(v.number()),
  /** A coverage change (or revert) can arrive while the single audit is in flight. */
  coverageThrough: v.optional(v.number()),
  failedFullCheck: v.optional(v.boolean()),
  donorSignal: v.optional(v.object({ evaluated: v.number(), refusals: v.number(), unevaluated: v.number() })),
  coverageSamples: v.optional(
    v.array(v.object({ landings: v.number(), threshold: v.number(), wallMs: v.optional(v.number()) })),
  ),
  /** Circuit breaker (509a0ffa): at most 50 compact verdicts, written only by existing
   * audit/landing transactions. Missing starts empty, without a history backfill. */
  window: v.optional(
    v.array(
      v.object({
        red: v.optional(v.object({ age: v.number(), count: v.number(), drill: v.number() })),
        audit: v.optional(
          v.object({
            verdict: v.union(v.literal('green'), v.literal('red'), v.literal('unclear'), v.literal('drill')),
            runId: v.optional(v.string()),
            landings: v.optional(v.number()),
            auditedLandings: v.optional(v.number()),
          }),
        ),
      }),
    ),
  ),
  /** Retired counters: validator only, to accept existing rows during deployment.
   * No runtime reader. The next verdict removes them in its existing row write. */
  earned: v.optional(
    v.object({
      audited: v.number(),
      unclear: v.number(),
      drill: v.optional(
        v.object({
          at: v.string(),
          sequence: v.number(),
          reverted: v.boolean(),
          started: v.optional(v.string()),
          red: v.optional(v.string()),
        }),
      ),
      lost: v.optional(v.object({ at: v.string(), reason: v.literal('red') })),
    }),
  ),
  /** An owner's red-audit drill in progress (fe7d67a8): started by the owner person, it claims the
   * first red audit in its window. Cleared when that red ends or a later red finds it expired. */
  drill: v.optional(
    v.object({
      startedAt: v.string(),
      red: v.optional(v.object({ at: v.string(), runId: v.string(), sequence: v.number() })),
    }),
  ),
  /** Consecutive audit starts that could not run (53b07031); cleared once one does. */
  startFailure: v.optional(
    v.object({ attempts: v.number(), code: v.string(), message: v.string(), at: v.string() }),
  ),
};
export const hostedMainAuditTables = {
  projectHostedMainAudits: defineTable(mainAuditFields).index('by_project', ['projectId']),
  projectHostedMainAuditEvents: defineTable({
    projectId: v.id('hostedProjects'),
    kind: v.union(
      v.literal('red'),
      v.literal('green'),
      v.literal('flake'),
      v.literal('stalled'),
      v.literal('culprit'),
    ),
    at: v.string(),
    head: v.string(),
    runId: v.string(),
    sequence: v.number(),
    coverage: v.optional(v.string()),
    culprit: v.optional(v.string()),
    /** On a 'culprit'-kind event with no `culprit`: the receipt that made a newly covered red's tests
     * run (Item 687d1eda). Written once per episode, so the name survives recovery; never a culprit. */
    covered: v.optional(v.string()),
    /** Comparison from the first failed audit. The passing run may have been a full landing
     * that wrote no audit event, so keep its exact pin on the red. */
    controlBuild: v.optional(
      v.object({
        change: controlBuildChange,
        lastGreen: v.object({
          sequence: v.number(),
          head: v.string(),
          runId: v.string(),
          at: v.string(),
          audited: v.boolean(),
        }),
      }),
    ),
    /** Confirmed compensation on the green verdict; absent on legacy events. */
    reverted: v.optional(v.boolean()),
    /** On the red an owner's drill claimed, and on the verdict that ended it: its start, red,
     * recovery and end times, and whether it counted (recovered in time) or was a real red. */
    drill: v.optional(drillRecord),
  }).index('by_project_and_sequence', ['projectId', 'sequence']),
};
