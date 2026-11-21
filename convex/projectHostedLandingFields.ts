// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { landingCapsulePointer } from './projectLandingCapsuleFields';
/** Server-only accounting checkpoint; existing state/reply readers ignore it. Cleared at check binding. */
const supersededCheck = v.optional(
  v.object({
    runId: v.string(),
    runnerSeconds: v.optional(v.number()),
    unknownBefore: v.optional(v.literal(true)),
  }),
);
export const runnerAccounting = v.optional(
  v.object({
    root: v.string(),
    pending: v.number(),
    lastCancelled: v.optional(v.string()),
    // Last applied Stats contribution after a derived day write or read failed.
    // Retained only until the day can be corrected or a newer close includes the current state.
    statsBaseline: v.optional(
      v.object({
        at: v.number(),
        lastMissedAt: v.number(),
        pending: v.boolean(),
        discardedSeconds: v.union(v.number(), v.null()),
        unknown: v.boolean(),
      }),
    ),
  }),
);
/** One main-red hold of a landing (receipt and Lane landing stamp `mainRedHolds`, Item 687d1eda). */
export const mainRedHoldValidator = v.object({
  kind: v.union(v.literal('parked'), v.literal('publication')),
  heldAt: v.string(),
  releasedAt: v.optional(v.string()),
});
const alarm = v.optional(
  v.union(
    v.object({
      taskId: v.id('_scheduled_functions'),
      lastProgressAt: v.string(),
    }),
    v.null(),
  ),
);
const phase = v.union(
  v.literal('queued'),
  v.literal('checking'),
  v.literal('ready'),
  v.literal('terminal-failed'),
  v.literal('landed'),
);
const lease = v.object({
  owner: v.string(),
  token: v.number(),
  until: v.number(),
  submissionId: v.string(),
  attemptId: v.string(),
  /** The row version this claim wrote (19328518): unchanged at the next claim
   * means its advance never committed. */
  claimed: v.optional(v.number()),
  /** Consecutive re-claims of this attempt whose advance never committed. */
  retries: v.optional(v.number()),
});
export const hostedLandingTables = {
  projectHostedLandingQueueStatus: defineTable({
    projectId: v.id('hostedProjects'),
    page: v.number(),
    value: v.string(),
  }).index('by_project_and_page', ['projectId', 'page']),
  /** One row per stall alert tier sent; replays and late alarms find it and send nothing. */
  projectHostedStallAlerts: defineTable({
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    lastProgressAt: v.string(),
    tier: v.union(v.literal(1), v.literal(2), v.literal(3)),
    value: v.string(),
  }).index('by_project_and_submission', ['projectId', 'submissionId']),
  projectHostedLandingBatches: defineTable({
    capsuleWaits: v.optional(v.array(v.object({ submissionId: v.string(), dueAt: v.number() }))),
    projectId: v.id('hostedProjects'),
    batchId: v.string(),
    composeOperationId: v.string(),
    value: v.string(),
  })
    .index('by_project_and_batch', ['projectId', 'batchId'])
    .index('by_project_and_compose', ['projectId', 'composeOperationId']),
  projectHostedLandingDesired: defineTable({
    runnerAccounting,
    supersededCheck,
    alarm,
    preparing: v.optional(v.boolean()),
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    submissionId: v.string(),
    composeOperationId: v.string(),
    selectionKey: v.string(),
    request: v.string(),
    value: v.string(),
    /** The submitting agent run's slug (d730121f); server-only, copied to the landing row. */
    agentRun: v.optional(v.string()),
    /** Its client: harness and declared model (81d12a32); copied to the landing row. */
    agentClient: v.optional(v.string()),
    /** Tokens the agent reported for this landing (feature landing-tokens, Item a61d3c91); copied to the landing row. */
    agentTokens: v.optional(v.number()),
    /** Guard-set evidence from the land gate (13ea93bf); copied to the landing row. */
    preflightRan: v.optional(v.string()),
    preflightRuns: v.optional(v.number()),
    wake: v.union(v.object({ id: v.string(), taskId: v.id('_scheduled_functions') }), v.null()),
  })
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_submission', ['projectId', 'submissionId'])
    .index('by_project_and_runner_cost_root', ['projectId', 'runnerAccounting.root'])
    .index('by_project_and_selection', ['projectId', 'selectionKey'])
    .index('by_project_and_preparing', ['projectId', 'preparing'])
    .index('by_project_and_compose', ['projectId', 'composeOperationId']),
  projectHostedLandingAliases: defineTable({
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    requestHash: v.string(),
    submissionId: v.string(),
  }).index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId']),
  projectHostedLandingObservations: defineTable({
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    version: v.number(),
    value: v.string(),
  }).index('by_project_and_submission_and_version', ['projectId', 'submissionId', 'version']),
  projectHostedLandingCheckWakes: defineTable({
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    version: v.optional(v.number()),
    wake: v.union(v.object({ taskId: v.id('_scheduled_functions'), id: v.string() }), v.null()),
  }).index('by_project_and_run', ['projectId', 'runId']),
  projectHostedLandingQueues: defineTable({
    projectId: v.id('hostedProjects'),
    channel: v.literal('main'),
    sequence: v.number(),
    train: v.optional(v.array(v.string())),
    status: v.optional(
      v.object({
        total: v.number(),
        /** Pending entries held for a person or a dependency, listed after `total`. */
        held: v.optional(v.number()),
        groups: v.number(),
        runningGroups: v.optional(v.number()),
        horizon: v.array(v.string()),
        lastProgressAt: v.string(),
        serviceMs: v.optional(v.number()),
      }),
    ),
    fence: v.number(),
    wake: v.union(
      v.object({
        taskId: v.id('_scheduled_functions'),
        id: v.string(),
        at: v.number(),
      }),
      v.null(),
    ),
    lease: v.union(lease, v.null()),
    /** Recent cohort outcomes for sizing (`1` passed, `0` a test failed), newest last. */
    /** Retired sample window: tolerated for stored rows; no reader or writer uses it. */
    earlyResolveSamples: v.optional(v.string()),
    checkHistory: v.optional(
      v.object({
        first: v.optional(v.string()),
        admitted: v.optional(v.string()),
      }),
    ),
    /** CI-down hold (FORGE_QUEUE_HOLD_ON_CI_DOWN, incident e62d834b line 5): consecutive landing checks
     * that ended on one infrastructure cause with no verdict between, and while that streak trips the
     * hold, its one probe wake. Written only on an infrastructure end or its clear. */
    ciDown: v.optional(
      v.object({
        cause: v.string(),
        since: v.number(),
        streak: v.number(),
        reason: v.optional(v.string()),
        probes: v.optional(v.number()),
        probeAt: v.optional(v.number()),
        wakeId: v.optional(v.id('_scheduled_functions')),
      }),
    ),
  }).index('by_project_and_channel', ['projectId', 'channel']),
  // S3: cold immutable request and batch selection; owned and deleted through its ticket.
  projectHostedLandingBodies: defineTable({
    value: v.string(),
    // Immutable message bodies retain raw text. Existing request/selection bodies have no project column.
    messageProjectId: v.optional(v.id('hostedProjects')),
  }),
  projectHostedLandingRequests: defineTable({
    runnerAccounting,
    supersededCheck,
    requestBodyId: v.optional(v.id('projectHostedLandingBodies')),
    selectionBodyId: v.optional(v.id('projectHostedLandingBodies')),
    capsule: v.optional(landingCapsulePointer),
    alarm,
    projectId: v.id('hostedProjects'),
    channel: v.literal('main'),
    submissionId: v.string(),
    operationId: v.string(),
    candidateId: v.optional(v.string()),
    /** The submitting agent run's slug (d730121f); server-only, the receipt records it. */
    agentRun: v.optional(v.string()),
    /** Its client: harness and declared model (81d12a32); the receipt records it. */
    agentClient: v.optional(v.string()),
    /** Tokens the agent reported for this landing (Item a61d3c91): display-only, never billing; the Stats day close sums
     * them. */
    agentTokens: v.optional(v.number()),
    /** Test files the landing's preflight ran (`ranKey`s) and its local runs (land gate, 13ea93bf);
     * server-only, read once if its check fails, to learn the preflight guard set. */
    preflightRan: v.optional(v.string()),
    preflightRuns: v.optional(v.number()),
    batchSelection: v.optional(v.string()),
    batchable: v.optional(v.boolean()),
    /** Server-only admission run of this submission's own Candidate (not in the state body). */
    admission: v.optional(
      v.object({
        runId: v.string(),
        status: v.union(
          v.literal('checking'),
          v.literal('passed'),
          v.literal('failed'),
          v.literal('unavailable'),
        ),
        endedAt: v.optional(v.number()),
        /** Pre-queue Lane check (`admissionCheck: "full"`). */
        full: v.optional(v.literal(true)),
        /** Platform-failure restarts of the Lane check, at most HOSTED_PLATFORM_RETRIES. */
        retries: v.optional(v.number()),
        /** The admitted change has tried its own Lane run as acceptance evidence. */
        reuse: v.optional(v.literal('tried')),
        /** Keep the run (fa2c1383): main moved under this admission run and the keep rule kept it. The
         * run still settles as the admission (first-check history), but the entry holds queue order
         * from the keep on, as the retire it replaced would have. Kept after it settles, for receipts. */
        kept: v.optional(v.literal(true)),
        /** Why that Lane run did not carry the landing (receipt `firstCheck`, 7fe54c7c). */
        recheck: v.optional(v.string()),
        /** Its one cohort hold for peers still deciding their own Lane proof (10b0a94b). */
        hold: v.optional(
          v.object({
            since: v.number(),
            /** The hold's one-shot wake at its bound, armed with the hold. */
            taskId: v.id('_scheduled_functions'),
            done: v.optional(v.literal(true)),
          }),
        ),
      }),
    ),
    admitting: v.optional(v.literal(true)),
    /** The bound check's kind, stamped with its start (the write that binds `runId`): a whole run, a
     * scoped main-race recheck, or a cohort's shared run. The accepted one joins the landing-speed
     * sample, which gives per-kind p50s and the keep rule's measured costs (fa2c1383, ecd6e610). */
    checkKind: v.optional(v.union(v.literal('full'), v.literal('scoped'), v.literal('batch'))),
    /** Admission end of an admitted change still deciding its own Lane proof
     * (untried, or bound to its Lane run): refused peers wait for it (10b0a94b). */
    deciding: v.optional(v.number()),
    revertOf: v.optional(v.string()),
    actor: v.string(),
    sequence: v.number(),
    priority: v.optional(v.union(v.literal('urgent'), v.literal('normal'))),
    priorityReason: v.optional(v.string()),
    priorityVersion: v.optional(v.number()),
    priorityChange: v.optional(
      v.object({
        operationId: v.string(),
        actor: v.string(),
        priority: v.union(v.literal('urgent'), v.literal('normal')),
        expectedVersion: v.number(),
        asOwner: v.optional(v.literal(true)),
      }),
    ),
    selectionKey: v.optional(v.string()),
    hold: v.optional(v.union(v.literal('main-red'), v.literal('ci-down'))),
    /** Set when main changed a file this queued, not-yet-checked entry changes (JSON). */
    wouldConflict: v.optional(v.string()),
    earlyResolveDependents: v.optional(v.literal(true)),
    earlyResolveWatch: v.optional(v.string()),
    earlyResolveObserved: v.optional(v.string()),
    runnable: v.boolean(),
    /** Holds its place in submission order: no newer entry may take main first. */
    orderLive: v.optional(v.literal(true)),
    /** A passed entry waiting for this older submission to land or stop (server-only). */
    orderWait: v.optional(v.string()),
    /** Set on the older submission when a newer one waits for it, so only then its exit wakes waiters. */
    orderWaited: v.optional(v.literal(true)),
    /** The holder a wake handed this passed entry to (it takes main first), until the entry's own
     * claim decides a wait: the new-run wake may then drive it (incident 43b51a5e case 2). */
    orderWaitHanded: v.optional(v.string()),
    /** Set by a claim that found this change touches a global-risk file: every older live entry
     * holds it, so the new-run wake and batons never drive it (43b51a5e). Its paths are pinned.
     * Not for an urgent entry, whose claim skips non-urgent older ones. */
    ownGlobalRisk: v.optional(v.literal(true)),
    /** The check generation a newer passed entry overtook (`overtakeMark`); later ones hold order. */
    overtaken: v.optional(v.string()),
    /** Why this entry's pass cannot be carried across a moved main (scoped re-check, or a proof
     * refused for a reason no dependent change caused); set once, it stops graph-sealed overtakes. */
    unsealed: v.optional(v.string()),
    /** When this submission first became ready (its check passed), in ms; set once and kept across
     * recompositions, so the landing's pass-to-land time starts at its first pass (42200ce4). */
    passedAt: v.optional(v.number()),
    /** Each older submission this passed entry waited for, why, and whether the two changes'
     * footprints overlapped (receipt `orderWaits`, Issue c6b81429). At most HOSTED_ORDER_WAITS. */
    orderWaits: v.optional(
      v.array(
        v.object({
          submissionId: v.string(),
          held: v.string(),
          footprints: v.union(v.literal('overlap'), v.literal('disjoint'), v.literal('unknown')),
        }),
      ),
    ),
    /** Each main-red hold this entry waited under, newest last (receipt `mainRedHolds`, Item
     * 687d1eda): set when it parks or its publication holds, closed when main's green releases it. */
    mainRedHolds: v.optional(v.array(mainRedHoldValidator)),
    /** The Candidate's Intent, so the next submission of the same work finds this one (10d253c6). */
    intentId: v.optional(v.string()),
    /** Supersessions after a passed check in a row, ending with the previous landing of this Intent. */
    superseded: v.optional(v.number()),
    /** Landing reservation end (src/landing-reservation.ts): landings that change this one's files
     * wait for it until then. Cleared when this landing lands or fails. */
    reservedUntil: v.optional(v.number()),
    phase,
    runId: v.union(v.string(), v.null()),
    /** Last delivered event of the current run, independent of queue phase. */
    checkWakeVersion: v.optional(v.number()),
    attemptId: v.string(),
    /** This exact solo generation is recomposing and cannot back a successor. */
    pipelineRetiredAttemptId: v.optional(v.string()),
    /** The owner's explicit approval of one exact held attempt (fe5bea80); server-only. */
    ownerGrant: v.optional(
      v.object({
        actor: v.string(),
        attemptId: v.string(),
        inputs: v.string(),
        dependencies: v.string(),
        policyDigest: v.string(),
        paths: v.union(v.array(v.string()), v.null()),
        at: v.number(),
        /** The Candidate head the owner accepted (shown as acceptedBy.head once it lands). */
        head: v.optional(v.string()),
      }),
    ),
    value: v.string(),
  })
    // index-order: caller: convex/projectSelfMetrics.ts#page; order: metrics bound _creationTime for submission windows.
    .index('by_project', ['projectId'])
    .index('by_project_and_submission', ['projectId', 'submissionId'])
    .index('by_project_and_runner_cost_root', ['projectId', 'runnerAccounting.root'])
    .index('by_project_and_channel_and_orderLive_and_sequence', [
      'projectId',
      'channel',
      'orderLive',
      'sequence',
    ])
    .index('by_project_and_orderWait_and_sequence', ['projectId', 'orderWait', 'sequence'])
    .index('by_project_and_hold', ['projectId', 'hold'])
    .index('by_project_and_revert_and_sequence', ['projectId', 'revertOf', 'sequence'])
    .index('by_project_and_candidate_and_sequence', ['projectId', 'candidateId', 'sequence'])
    .index('by_project_and_candidate_and_phase_and_sequence', [
      'projectId',
      'candidateId',
      'phase',
      'sequence',
    ])
    .index('by_project_and_selection', ['projectId', 'selectionKey'])
    .index('by_project_and_operation', ['projectId', 'operationId'])
    .index('by_project_and_actor_and_operation', ['projectId', 'actor', 'operationId'])
    .index('by_project_and_channel_and_runnable_and_priority_and_sequence', [
      'projectId',
      'channel',
      'runnable',
      'priority',
      'sequence',
    ])
    .index('by_project_and_channel_and_phase_and_priority_and_sequence', [
      'projectId',
      'channel',
      'phase',
      'priority',
      'sequence',
    ])
    .index('by_project_and_channel_and_runnable_and_sequence', [
      'projectId',
      'channel',
      'runnable',
      'sequence',
    ])
    .index('by_project_channel_runnable_batchable_priority_sequence', [
      'projectId',
      'channel',
      'runnable',
      'batchable',
      'priority',
      'sequence',
    ])
    .index('by_project_and_channel_and_batchable_and_phase_and_sequence', [
      'projectId',
      'channel',
      'batchable',
      'phase',
      'sequence',
    ])
    .index('by_project_and_channel_and_phase_and_sequence', ['projectId', 'channel', 'phase', 'sequence'])
    .index('by_project_and_channel_and_sequence', ['projectId', 'channel', 'sequence'])
    .index('by_project_and_channel_and_admitting_and_sequence', [
      'projectId',
      'channel',
      'admitting',
      'sequence',
    ])
    .index('by_project_and_channel_and_deciding', ['projectId', 'channel', 'deciding'])
    .index('by_project_and_intent', ['projectId', 'intentId'])
    .index('by_project_and_channel_and_reservedUntil', ['projectId', 'channel', 'reservedUntil'])

    .index('by_project_run_phase_checkWakeVersion', ['projectId', 'runId', 'phase', 'checkWakeVersion']),
  projectHostedLandingAttempts: defineTable({
    sourceCreatedAt: v.optional(v.number()),
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    attemptId: v.string(),
    number: v.number(),
    progress: v.optional(v.string()),
    value: v.string(),
  })
    // index-order: caller: convex/projectSelfMetrics.ts#page; order: metrics bound _creationTime for attempt windows.
    .index('by_project', ['projectId'])
    .index('by_project_and_attempt', ['projectId', 'attemptId'])
    .index('by_project_and_submission_and_number', ['projectId', 'submissionId', 'number']),
};
