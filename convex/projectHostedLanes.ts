// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { hostedRecordPage, hostedRecordBody, readHostedRecord, recordHead } from './projectHostedRecords';
import { effectiveLifecycleRecord } from './projectHostedLifecycleOverlay';
import { hostedLaneSchema, hostedLaneSelectionSchema, hostedIntentSchema } from '../src/hosted-lane';
import { sourceAuthority } from '../src/hosted-source-authority';
import { invariant } from '../src/errors';
import { report } from './errors';
import { findObject } from './projectObjectFind';
import { isStored } from './projectObjectFields';

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
    ...(input.version === undefined ? {} : { version: input.version }),
  });
  invariant(row, 'NOT_FOUND', 'Hosted Lane not found on this project.');
  return { lane: hostedLaneSchema.parse(JSON.parse(row.value)), project };
}
export const head = query({
  args: identity,
  returns: v.object({
    head: v.string(),
    version: v.number(),
    sourceVersion: v.number(),
    lifecycleVersion: v.number(),
    /** When the Lane's record last changed (save, sync or lifecycle): no extra reads. */
    lastActivityAt: v.string(),
    /** Present once an accepted landing carried this Lane's saved head: receipt, accepted commit (State id), time,
     * and whether the Lane's current head is still that head. Absent while nothing has landed. */
    landing: v.optional(
      v.object({
        state: v.literal('landed'),
        receiptId: v.string(),
        commit: v.string(),
        at: v.string(),
        current: v.boolean(),
        /** The accepted compensating landing that took this landing off main (Issue 8dbccdfb). */
        revertedBy: v.optional(v.object({ receiptId: v.string(), at: v.string() })),
      }),
    ),
  }),
  handler: async (ctx, input) => {
    try {
      const { lane } = await laneRecord(ctx, input);
      // Same query, one indexed read: the overlap row carries the landing stamp.
      const landed = (
        await ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q =>
            q.eq('projectId', input.projectId).eq('laneId', input.laneId),
          )
          .unique()
      )?.landed;
      return {
        lastActivityAt: lane.at,
        ...(landed
          ? {
              landing: {
                state: 'landed' as const,
                receiptId: landed.receiptId,
                commit: landed.commit,
                at: landed.at,
                current: landed.laneHead === lane.head && !landed.revertedBy,
                ...(landed.revertedBy ? { revertedBy: landed.revertedBy } : {}),
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
      reason: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, input) => {
    try {
      const groups = [input, ...(input.additionalProjects ?? [])];
      invariant(
        groups.length <= 250 &&
          groups.reduce((n, group) => n + group.laneIds.length, 0) <= (input.additionalProjects ? 250 : 100),
        'BAD_ARGUMENT',
        'Read one bounded Lane state page.',
      );
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted work.');
      const result = [];
      for (const group of groups) {
        try {
          await accessibleProject(ctx, group.projectId, user.subject);
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
          result.push(
            effective
              ? {
                  laneId,
                  ...(source ? { source: { head: source.head, intentId: source.intentId } } : {}),
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
  handler: async (ctx, input) => {
    try {
      return JSON.stringify((await laneRecord(ctx, input)).lane);
    } catch (error) {
      return report(error);
    }
  },
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
      const { lane, project } = await laneRecord(ctx, input);
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
          schema: 2,
          projectId: input.projectId,
          laneId: lane.id,
          intentId: lane.intentId,
          head: lane.head,
          version: lane.version,
          sourceVersion: lane.sourceVersion,
          lifecycleVersion: lane.lifecycleVersion,
          state: lane.state,
          ...(lane.stack ? { stack: lane.stack } : {}),
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
