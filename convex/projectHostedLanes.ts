// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { JournalNeeded, journalReadReply } from './projectJournalStore';
import { sourceAuthorship } from '../src/work-actor-types';
import { v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { laneHolderFor } from './projectAudience';
import { accessibleProject } from './projectAuthority';
import { hostedRecordPage, hostedRecordBody, readHostedRecord, recordHead } from './projectHostedRecords';
import { effectiveLifecycleRecord } from './projectHostedLifecycleOverlay';
import { hostedLaneSchema, hostedLaneSelectionSchema, hostedIntentSchema } from '../src/hosted-lane';
import { sourceAuthority } from '../src/hosted-source-authority';
import { invariant } from '../src/errors';
import { supersededSummary } from '../src/hosted-overlap';
import { report } from './errors';
import { findObject } from './projectObjectFind';
import { isStored } from './projectObjectFields';
import { liveLaneFinish } from './projectHostedLaneFinish';
import { saveFailureView } from './projectHostedRecordFields';
import { saveFailureSummary } from './projectHostedSaveStore';

const identity = { projectId: v.id('hostedProjects'), laneId: v.string() };
async function caller(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted work.');
  return { actor: user.subject, project: await accessibleProject(ctx, projectId, user.subject) };
}
async function laneRecord(
  ctx: QueryCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string; version?: number },
) {
  const { actor, project } = await caller(ctx, input.projectId);
  const row = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor,
    kind: 'lane',
    key: input.laneId,
    ...(input.version === undefined ? { withSaveFailure: true } : { version: input.version }),
  });
  invariant(row, 'NOT_FOUND', 'Hosted Lane not found on this project.');
  return {
    lane: hostedLaneSchema.parse(JSON.parse(row.value)),
    project,
    viewer: actor,
    saveFailure: row.saveFailure && saveFailureSummary(row.saveFailure.value),
  };
}
export const head = query({
  args: {
    ...identity,
    includeHolder: v.optional(v.literal(true)),
    includeState: v.optional(v.literal(true)),
    /** Feature lane-status-landing: also name an active Lane's landing still in flight (7da396ed). */
    includeLanding: v.optional(v.literal(true)),
  },
  returns: v.object({
    state: v.optional(v.union(v.literal('active'), v.literal('completed'), v.literal('abandoned'))),
    head: v.string(),
    version: v.number(),
    sourceVersion: v.number(),
    lifecycleVersion: v.number(),
    /** When the Lane's record last changed (save, sync or lifecycle): no extra reads. */
    holder: v.optional(
      v.object({
        sessionId: v.optional(v.string()),
        name: v.union(v.string(), v.null()),
        since: v.number(),
        lastSeen: v.number(),
        mine: v.boolean(),
      }),
    ),
    lastActivityAt: v.string(),
    saveFailure: v.optional(saveFailureView),
    /** Present once an accepted landing carried this Lane's saved head: receipt, accepted commit (State id), time,
     * and whether the Lane's current head is still that head. Absent while nothing has landed. */
    landing: v.optional(
      v.object({
        state: v.literal('landed'),
        receiptId: v.string(),
        commit: v.string(),
        at: v.string(),
        current: v.boolean(),
        unchecked: v.optional(v.literal(true)),
        /** The accepted compensating landing that took this landing off main (Issue 8dbccdfb). */
        revertedBy: v.optional(v.object({ receiptId: v.string(), at: v.string() })),
      }),
    ),
    /** Present while a landing of the Lane's Intent superseded its current head (Issue 55024d40): the
     * Lane that landed, its receipt and one line saying what that means (Item 3f70760d). A save or
     * reopen makes the Lane live again. Same overlap row read, no added call. */
    superseded: v.optional(
      v.object({ by: v.string(), receiptId: v.string(), at: v.string(), summary: v.string() }),
    ),
    /** The Lane's landing that is still composing, queued, checking or ready (includeLanding only), so an
     * agent that lost its Lane folder or operation id recovers it by laneId alone. */
    inFlight: v.optional(
      v.object({
        phase: v.string(),
        submissionId: v.string(),
        operationId: v.string(),
        submittedAt: v.string(),
      }),
    ),
  }),
  handler: async (ctx, input) => {
    try {
      const { lane, project, saveFailure } = await laneRecord(ctx, input);
      const viewer = (await ctx.auth.getUserIdentity())!.subject;
      const holder = input.includeHolder ? await laneHolderFor(ctx, project, viewer, lane.holder) : undefined;
      // Same query, one indexed read: the overlap row carries the landing and supersede stamps.
      const overlap = await ctx.db
        .query('projectHostedOverlapLanes')
        .withIndex('by_project_and_lane', q => q.eq('projectId', input.projectId).eq('laneId', input.laneId))
        .unique();
      const landed = overlap?.landed;
      const superseded =
        lane.state === 'active' && overlap?.superseded?.laneHead === lane.head
          ? overlap.superseded
          : undefined;
      // Bounded: the same compose-selection lookup a save's live-finish refusal makes (at most 8).
      const live =
        input.includeLanding && lane.state === 'active'
          ? await liveLaneFinish(ctx, { projectId: input.projectId, laneId: input.laneId, headWrittenAt: '' })
          : null;
      return {
        ...(input.includeState ? { state: lane.state } : {}),
        ...(holder
          ? {
              holder: {
                ...(holder.sessionId ? { sessionId: holder.sessionId } : {}),
                name: holder.agent ?? null,
                since: holder.since,
                lastSeen: holder.lastSeen,
                mine: holder.actor === viewer,
              },
            }
          : {}),
        lastActivityAt: lane.at,
        ...(saveFailure ? { saveFailure } : {}),
        ...(landed
          ? {
              landing: {
                state: 'landed' as const,
                receiptId: landed.receiptId,
                commit: landed.commit,
                at: landed.at,
                current: landed.laneHead === lane.head && !landed.revertedBy,
                ...(landed.unchecked ? { unchecked: true as const } : {}),
                ...(landed.revertedBy ? { revertedBy: landed.revertedBy } : {}),
              },
            }
          : {}),
        ...(superseded
          ? {
              superseded: {
                by: superseded.by,
                receiptId: superseded.receiptId,
                at: superseded.at,
                summary: supersededSummary(superseded.by, superseded.receiptId),
              },
            }
          : {}),
        ...(live
          ? {
              inFlight: {
                phase: live.phase,
                submissionId: live.submissionId,
                operationId: live.state.operationId,
                submittedAt: live.state.timing?.submittedAt ?? live.state.at,
              },
            }
          : {}),
        head: lane.head,
        version: lane.version,
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: lane.lifecycleVersion,
      };
    } catch (error) {
      return report(error);
    }
  },
});
/** Bounded lifecycle headers only, across projects on the same deployment. Legacy callers
 * retain their 100-Lane shape; prune batches up to 250 identities in one authorized read. */
export const states = query({
  args: {
    projectId: v.id('hostedProjects'),
    laneIds: v.array(v.string()),
    sourcePins: v.optional(v.literal(1)),
    checkoutReceipts: v.optional(v.literal(1)),
    additionalProjects: v.optional(
      v.array(
        v.object({
          projectId: v.id('hostedProjects'),
          laneIds: v.array(v.string()),
        }),
      ),
    ),
  },
  returns: v.array(
    v.object({
      laneId: v.string(),
      state: v.string(),
      version: v.number(),
      pinned: v.optional(v.boolean()),
      source: v.optional(v.object({ head: v.string(), intentId: v.string() })),
      landedHead: v.optional(v.string()),
      reason: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, input) => {
    try {
      const groups = [input, ...(input.additionalProjects ?? [])];
      invariant(
        groups.length <= 250 &&
          groups.reduce((n, group) => n + group.laneIds.length, 0) <=
            (input.checkoutReceipts ? 48 : input.additionalProjects ? 250 : 100),
        'BAD_ARGUMENT',
        'Read one bounded Lane state page.',
      );
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted work.');
      const result = [];
      for (const group of groups) {
        try {
          const project = await accessibleProject(
            ctx,
            group.projectId,
            user.subject,
            Boolean(input.additionalProjects) && !input.sourcePins,
          );
          if (!project) {
            for (const laneId of new Set(group.laneIds))
              result.push({ laneId, state: 'project-deleted', version: 0 });
            continue;
          }
        } catch (error) {
          // No record or lifecycle data is read for an unavailable project. A batched prune
          // can still classify the other projects; a legacy caller keeps its typed failure.
          if (!input.additionalProjects) throw error;
          if ((error as { code?: string }).code !== 'PROJECT_UNAVAILABLE') throw error;
          for (const laneId of new Set(group.laneIds))
            result.push({
              laneId,
              state: 'unknown',
              version: 0,
              reason: 'PROJECT_UNAVAILABLE: restore project access, then rerun nforge prune; copy retained.',
            });
          continue;
        }
        for (const laneId of new Set(group.laneIds)) {
          const head = await recordHead(ctx, group.projectId, 'lane', laneId);
          const row = head ? await ctx.db.get(head.recordId) : null;
          const effective = row ? await effectiveLifecycleRecord(ctx, row) : null;
          const source =
            input.sourcePins && effective
              ? hostedLaneSchema.parse(JSON.parse(await hostedRecordBody(ctx, effective)))
              : null;
          // The operator-only finished sweep needs to distinguish manual completion
          // from an accepted head. This projection can carry up to 128 KiB of changes;
          // receipt pages are capped at 48 even for a cross-project read.
          const overlap =
            input.checkoutReceipts && effective?.status === 'completed'
              ? await ctx.db
                  .query('projectHostedOverlapLanes')
                  .withIndex('by_project_and_lane', q =>
                    q.eq('projectId', group.projectId).eq('laneId', laneId),
                  )
                  .unique()
              : null;
          const landed = overlap?.landed;
          const landedHead =
            landed && !landed.revertedBy && landed.laneHead === overlap?.head ? landed.laneHead : null;
          result.push(
            effective
              ? {
                  laneId,
                  ...(source ? { source: { head: source.head, intentId: source.intentId } } : {}),
                  ...(landedHead ? { landedHead } : {}),
                  state: String(effective.status),
                  version: effective.version,
                  ...(effective.pinned ? { pinned: true } : {}),
                }
              : {
                  laneId,
                  state: 'missing',
                  version: 0,
                  ...(input.additionalProjects
                    ? {
                        reason:
                          'Lane record missing: restore its retained hosted record, then rerun nforge prune; copy retained.',
                      }
                    : {}),
                },
          );
        }
      }
      return result;
    } catch (error) {
      return report(error);
    }
  },
});
/** Detail hydrates one exact record only. History/siblings are separate paged reads. */
export const detail = query({
  args: { ...identity, version: v.optional(v.number()) },
  returns: v.string(),
  handler: journalLaneRead,
});
/** Select is a read: exact expected pins fail explicitly instead of choosing newer source. */
export const select = query({
  args: {
    ...identity,
    expected: v.optional(v.object({ head: v.string(), sourceVersion: v.number(), version: v.number() })),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { lane, project, viewer } = await laneRecord(ctx, input);
      const holder = await laneHolderFor(ctx, project, viewer, lane.holder);
      invariant(
        !input.expected ||
          (input.expected.head === lane.head &&
            input.expected.sourceVersion === lane.sourceVersion &&
            input.expected.version === lane.version),
        'WORK_STALE',
        'The selected Lane changed from its expected source pins.',
      );
      return JSON.stringify(
        hostedLaneSelectionSchema.parse({
          ...sourceAuthorship(lane),
          schema: 2,
          projectId: input.projectId,
          laneId: lane.id,
          intentId: lane.intentId,
          head: lane.head,
          version: lane.version,
          sourceVersion: lane.sourceVersion,
          lifecycleVersion: lane.lifecycleVersion,
          state: lane.state,
          ...(holder ? { holder } : {}),
          ...(lane.stack ? { stack: lane.stack } : {}),
          ...(lane.earlyResolution ? { earlyResolution: lane.earlyResolution } : {}),
          base: lane.base,
          authority: sourceAuthority(project),
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});
export const siblings = query({
  args: { projectId: v.id('hostedProjects'), intentId: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    page: v.array(v.object({ laneId: v.string(), version: v.number(), state: v.string() })),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, input) => {
    try {
      const { actor } = await caller(ctx, input.projectId);
      const rows = await hostedRecordPage(ctx, {
        projectId: input.projectId,
        actor,
        kind: 'lane',
        parent: input.intentId,
        cursor: input.cursor,
      });
      return {
        page: rows.page.map(row => ({ laneId: row.key, version: row.version, state: row.status })),
        isDone: rows.isDone,
        continueCursor: rows.continueCursor,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const intent = query({
  args: { projectId: v.id('hostedProjects'), intentId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor } = await caller(ctx, input.projectId);
      const row = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor,
        kind: 'intent',
        key: input.intentId,
      });
      invariant(row, 'NOT_FOUND', 'Hosted Intent not found on this project.');
      return JSON.stringify(hostedIntentSchema.parse(JSON.parse(row.value)));
    } catch (error) {
      return report(error);
    }
  },
});

/** Exact project object membership, including cache hits. The client verifies State bytes. */
export const source = query({
  args: { projectId: v.id('hostedProjects'), state: v.string() },
  returns: v.object({ head: v.string() }),
  handler: async (ctx, { projectId, state }) => {
    try {
      await caller(ctx, projectId);
      const object = await findObject(ctx, projectId, state);
      invariant(
        object && !object.removed && isStored(object),
        'SOURCE_UNAVAILABLE',
        'The exact source object is unavailable on this project.',
      );
      return { head: state };
    } catch (error) {
      return report(error);
    }
  },
});

export async function journalLaneRead(
  ctx: QueryCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string; version?: number },
) {
  try {
    const { lane, project, viewer, saveFailure } = await laneRecord(ctx, input);
    const { holder: stored, ...rest } = lane;
    const holder = await laneHolderFor(ctx, project, viewer, stored);
    return JSON.stringify({
      ...rest,
      ...(holder ? { holder } : {}),
      ...(saveFailure ? { saveFailure } : {}),
    });
  } catch (error) {
    if (error instanceof JournalNeeded) return journalReadReply(ctx, error, input.projectId);
    return report(error);
  }
}
