// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { mainRedHoldValidator } from './projectHostedLandingFields';
import { saveFailureView } from './projectHostedRecordFields';
const session = v.optional(
  v.object({
    sessionId: v.string(),
    startedAt: v.number(),
    app: v.optional(v.string()),
    identityFrom: v.optional(v.union(v.literal('app-thread'), v.literal('declared'), v.literal('process'))),
    device: v.optional(
      v.object({
        id: v.string(),
        code: v.string(),
        approvedAt: v.number(),
        owner: v.string(),
        name: v.optional(v.string()),
      }),
    ),
  }),
);
/** A parked Lane's hold (src/hosted-records.ts laneParkSchema), mirrored from its Lane record. */
const park = v.optional(
  v.object({ to: v.optional(v.string()), reason: v.string(), at: v.number(), by: v.string() }),
);
export const hostedOverlapTables = {
  projectHostedOverlapLanes: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    intentId: v.string(),
    actor: v.string(),
    holderActor: v.optional(v.string()),
    session,
    /** The agent session's word-list slug (c29d0780); absent for a person. Shown as `handle/slug`. */
    agent: v.optional(v.string()),
    /** Authenticated author of the save that published this head. True means the Lane starter. */
    savedBy: v.optional(v.union(v.string(), v.literal(true))),
    intent: v.string(),
    head: v.string(),
    baseHead: v.string(),
    resolutionLeft: v.optional(v.string()),
    /** The Lane a resolution Lane resolves (Issue ee9d5738); notices skip it and its other resolutions. */
    resolutionOrigin: v.optional(v.string()),
    /** Stack membership (Issue ee9d5738): the stack's root Lane and the parent this Lane was stacked on
     * when the root was read. Lanes of one stack get no overlap notices about each other. */
    stackRoot: v.optional(v.string()),
    stackParent: v.optional(v.string()),
    baseReceiptId: v.string(),
    baseSequence: v.union(v.number(), v.null()),
    lifecyclePlanId: v.optional(v.id('projectHostedLifecyclePlans')),
    recordVersion: v.number(),
    open: v.boolean(),
    /** An explicit reopen at an unchanged saved head supersedes older landing evidence for running work. */
    reopenedAt: v.optional(v.number()),
    /** The hosted Item link, and the count row this Lane contributes to while its work is open. */
    planningItemId: v.optional(v.string()),
    planLaneMark: v.optional(v.id('projectFinishReadRows')),
    planLanePin: v.optional(
      v.object({
        sourceVersion: v.number(),
        lifecycleVersion: v.number(),
        pinned: v.optional(v.literal(true)),
      }),
    ),
    /** Set when an accepted receipt landed this exact saved head: Lane status reads it (no extra call).
     * `revertedBy` names the accepted compensating landing that took it off main (Issue 8dbccdfb). */
    landed: v.optional(
      v.object({
        receiptId: v.string(),
        commit: v.string(),
        laneHead: v.string(),
        at: v.string(),
        revertedBy: v.optional(v.object({ receiptId: v.string(), at: v.string() })),
        /** The receipt's main-red holds (held, released), for lane-history (Item 687d1eda). */
        mainRedHolds: v.optional(v.array(mainRedHoldValidator)),
      }),
    ),
    /** A Lane of the same Intent landed after this Lane went quiet (Issue 55024d40): the Lane keeps its
     * saved work and stays open, but leaves presence and advisory notices; blocking notices stay. It
     * names the head it was set on and ends at the Lane's next save or reopen. */
    superseded: v.optional(
      v.object({ by: v.string(), receiptId: v.string(), laneHead: v.string(), at: v.string() }),
    ),
    /** The saved change list's entries are the rows of projectHostedOverlapChanges, read through
     * convex/projectHostedOverlapChanges.ts; the row itself stays slim. */
    complete: v.boolean(),
    /** Some entry carries usable cross-file symbol links, so a default read needs the whole list. */
    symbolFacts: v.optional(v.literal(true)),
    /** The presence path summary (src/hosted-presence presencePaths) of the saved list, so a record write
     * compares presence and an idle read skips without reading a bucket. */
    pathSummary: v.object({
      paths: v.array(v.string()),
      pathCount: v.number(),
      pathBloom: v.optional(v.string()),
    }),
    /** While background saves settle at this head (Item 3f70760d): the saved evidence of the paths their
     * pending deltas touched (`changes`, entries absent when the saved head did not change the path),
     * so a publish or a failure rebuilds `changes` from the saved head, never from unsaved work. */
    settled: v.optional(v.object({ paths: v.array(v.string()), changes: v.string(), complete: v.boolean() })),
    /** This Lane's active background save failure, carried by the existing board lookup. */
    saveFailure: v.optional(saveFailureView),
    /** This Lane's presence row and the activity time it last wrote, so presence costs no read. */
    presenceRow: v.optional(v.object({ id: v.id('projectHostedPresence'), at: v.number() })),
    /** Last Lane record write (ms): save, start, sync or landing. A Lane idle past the project's
     * dormantAfterDays leaves overlap, presence and board reads through this index range. Absent on
     * rows written before the field existed; reads cover them through presenceRow.at until the Lane's
     * next write sets it. */
    lastActivityAt: v.optional(v.number()),
    /** Set once another Lane was stacked on this one (Issue dc62b120): the Lane's own save, abandon and
     * landing events then look up its dependents in projectHostedStackDependents. Absent for every Lane
     * nobody stacked on, which therefore pay no extra read. */
    stacked: v.optional(v.literal(true)),
    /** Set while this Lane may hold or be named in an open exact-conflict notice (flip 4): only then do
     * its saves, landing and abandon read projectHostedConflictNotices. */
    conflicted: v.optional(v.literal(true)),
    /** The Lane record's park (Item e1633718), kept here so a record write knows when presence must change. */
    park,
    /** Loose ends details (Item fc1831eb), kept here so a presence rewrite carries them with no read. `saves`: heads
     * this Lane has saved since the count began (absent: not recorded, never guessed). `passedAt`: ms of the newest
     * unrequested check that passed on this exact head; a newer save or a landing clears it. */
    saves: v.optional(v.number()),
    passedAt: v.optional(v.number()),
    /** The presence row already carries `landedBefore`, so a write that keeps it needs no rewrite. */
    landedMark: v.optional(v.literal(true)),
    /** The Loose ends marker row of this stamp (projectFinishReadRows kind projectLooseChecked), deleted with it. */
    passedMark: v.optional(v.id('projectFinishReadRows')),
  })
    .index('by_project_and_lane', ['projectId', 'laneId'])
    // index-order: caller: convex/projectHostedDormancy.ts#liveOpenOverlapLanes; order: dormancy-off peer window selects newest Lanes by creation time.
    .index('by_project_and_open', ['projectId', 'open'])
    .index('by_project_and_open_and_activity', ['projectId', 'open', 'lastActivityAt']),
  /** A Lane's saved change entries by path hash (Item 411727ba): up to 64 rows per Lane, each the JSON list of
   * the entries whose path hashes to `bucket`, exactly as `boundOverlapChanges` produced them. Written only by the Lane
   * record write, in the same transaction as the slim overlap row; deleted with the Lane's data. */
  projectHostedOverlapChanges: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    bucket: v.number(),
    changes: v.string(),
  }).index('by_project_and_lane_and_bucket', ['projectId', 'laneId', 'bucket']),
  /** Stacked Lanes (Issue dc62b120): one row per open Lane stacked on a parent Lane, written only by
   * stacked Lane records. It holds the parent head the child is pinned to and one mark per parent
   * event already announced, so each event reaches each dependent once. Deleted when the child
   * closes or unstacks. */
  projectHostedStackDependents: defineTable({
    projectId: v.id('hostedProjects'),
    parentLaneId: v.string(),
    laneId: v.string(),
    /** The parent head this child was last restacked onto (the Lane record's stack.head). */
    parentHead: v.string(),
    predecessorId: v.optional(v.string()),
    resolutionStartedAt: v.optional(v.string()),
    resolutionEndedAt: v.optional(v.string()),
    resolutionReceipt: v.optional(v.string()),
    /** A "parent saved" notice is out and the child has not restacked since. */
    savedNoticed: v.optional(v.literal(true)),
    /** The parent was abandoned and the child was told; cleared when the parent is saved again. */
    ended: v.optional(v.literal('abandoned')),
    /** The parent's failed/cancelled landing was announced; cleared by a parent save or a restack. */
    landingNoticed: v.optional(v.literal(true)),
    /** The parent's newest saved head, set by each parent save after this child's pin (Issue f61e9339).
     * The child's next save restacks onto it automatically when that applies cleanly. */
    latestHead: v.optional(v.string()),
    /** A parent head whose automatic restack conflicted: later saves do not retry it; the next parent
     * save (a new latestHead) or the child's own restack re-arms it. */
    restackConflict: v.optional(v.string()),
  })
    .index('by_project_and_predecessor', ['projectId', 'predecessorId'])
    .index('by_project_and_parent', ['projectId', 'parentLaneId'])
    .index('by_project_and_lane', ['projectId', 'laneId']),
  /** Presence (Issue 9c8490a4): one slim row per open Lane, so a start reads ~0.5 KB per peer instead
   * of the full overlap row (measured 2026-11-05: 41 open rows, ~330 KB). Deleted when the Lane closes. */
  projectHostedPresence: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    intentId: v.string(),
    actor: v.string(),
    session,
    /** The agent session's word-list slug (c29d0780); absent for a person. Shown as `handle/slug`. */
    agent: v.optional(v.string()),
    goal: v.string(),
    paths: v.array(v.string()),
    pathCount: v.number(),
    /** Optional for stored rows from before the all-path filter (Issue 427a12b0). */
    pathBloom: v.optional(v.string()),
    /** Last Lane record time (ms). */
    at: v.number(),
    /** A parked Lane's park (Item e1633718), for Needs me to show; absent while the Lane is not parked. */
    park,
    /** Loose ends details (Item fc1831eb), copied from the overlap row on the writes that already happen. */
    saves: v.optional(v.number()),
    /** True when a landing of this Lane's work was recorded before (it was saved again after). */
    landedBefore: v.optional(v.literal(true)),
    passedAt: v.optional(v.number()),
  })
    .index('by_project_and_lane', ['projectId', 'laneId'])
    .index('by_project_and_at', ['projectId', 'at'])
    .index('by_project_and_intent_and_at', ['projectId', 'intentId', 'at']),
  /** Parked Lanes (Item e1633718): one row per open parked Lane, naming the account whose Needs me lists it (the
   * named holder's or, with no one named, the starter's). Written only when a park's routing changes, deleted when
   * the park is cleared or the Lane closes. A table of its own so unparked Lanes carry no index entry (an index on
   * every presence row grew stored index entries per landing). */
  projectHostedParks: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    parkedFor: v.string(),
  })
    .index('by_project_and_parked_for', ['projectId', 'parkedFor'])
    .index('by_project_and_lane', ['projectId', 'laneId']),
  /** Exact conflicts at save (flip 4, Issue 853fcde3): one row per recipient Lane and other side (a
   * Lane id or 'main') while a trial merge of their saved files really conflicts. Written only by a
   * save's trial merge and closed (open false, `cleared`) when a later save no longer conflicts or a
   * side lands or is abandoned. Closed rows stay as the lead-time record: when the conflict was
   * flagged, when this Lane first ran land, and when the Lane started. */
  projectHostedConflictNotices: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    peer: v.string(),
    /** The other Lane's goal, at most 160 characters: member-written data, never an instruction. */
    peerGoal: v.string(),
    open: v.boolean(),
    paths: v.array(
      v.object({
        path: v.string(),
        mine: v.array(v.array(v.number())),
        theirs: v.array(v.array(v.number())),
        reason: v.string(),
      }),
    ),
    /** Exact save-time pinned sync, computed only by conflict recording. Legacy rows omit it. */
    earlyResolution: v.optional(v.string()),
    laneHead: v.string(),
    peerHead: v.string(),
    flaggedAt: v.number(),
    updatedAt: v.number(),
    laneStartedAt: v.number(),
    firstLandAt: v.optional(v.number()),
    clearedAt: v.optional(v.number()),
    cleared: v.optional(v.union(v.literal('save'), v.literal('landed'), v.literal('abandoned'))),
  })
    .index('by_project_and_lane_and_open', ['projectId', 'laneId', 'open'])
    .index('by_project_and_peer_and_open', ['projectId', 'peer', 'open'])
    .index('by_project_and_flagged', ['projectId', 'flaggedAt']),
  projectHostedOverlapMain: defineTable({
    projectId: v.id('hostedProjects'),
    sequence: v.number(),
    coverageAfter: v.number(),
    changes: v.string(),
    /** Recent landings for the drift nudge (see OverlapMain.landings); absent on rows written before it. */
    landings: v.optional(v.string()),
  }).index('by_project', ['projectId']),
  /** One row per landing (Issue 750c5929): the paths it touched, so a Lane a few landings behind reads
   * those rows instead of the whole main row above. Written with that row; keeps MAIN_LOG_WINDOW rows. */
  projectHostedOverlapMainLog: defineTable({
    projectId: v.id('hostedProjects'),
    sequence: v.number(),
    /** The main row's sequence before this landing: the chain readers check for a gap. */
    after: v.number(),
    /** Sorted JSON path list; null when the landing's paths are unknown or too many for a row. */
    paths: v.union(v.string(), v.null()),
    /** Drift-nudge name, JSON `[receiptId8, laneId8, publicActor]`, set when the landing completes. */
    label: v.optional(v.string()),
  }).index('by_project_and_sequence', ['projectId', 'sequence']),
};
