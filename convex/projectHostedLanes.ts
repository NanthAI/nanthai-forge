// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { hostedRecordPage, readHostedRecord, recordHead } from './projectHostedRecords';
import { effectiveLifecycleRecord } from './projectHostedLifecycleOverlay';
import { hostedLaneSchema, hostedLaneSelectionSchema, hostedIntentSchema } from '../src/hosted-lane';
import { sourceAuthority } from '../src/hosted-source-authority';
import { invariant } from '../src/errors';
import { report } from './errors';

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
  }),
  handler: async (ctx, input) => {
    try {
      const { lane } = await laneRecord(ctx, input);
      return {
        lastActivityAt: lane.at,
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
/** Lifecycle state of up to 100 Lanes in one call (client idle listing and prune).
 * Reads heads and lifecycle overlays only, never record bodies; `pinned` rides on the same row. Unknown ids are "missing". */
export const states = query({
  args: { projectId: v.id('hostedProjects'), laneIds: v.array(v.string()) },
  returns: v.array(
    v.object({ laneId: v.string(), state: v.string(), version: v.number(), pinned: v.optional(v.boolean()) }),
  ),
  handler: async (ctx, input) => {
    try {
      invariant(input.laneIds.length <= 100, 'BAD_ARGUMENT', 'Read at most 100 Lanes per call.');
      await caller(ctx, input.projectId);
      const result = [];
      for (const laneId of new Set(input.laneIds)) {
        const head = await recordHead(ctx, input.projectId, 'lane', laneId);
        const row = head ? await ctx.db.get(head.recordId) : null;
        const effective = row ? await effectiveLifecycleRecord(ctx, row) : null;
        result.push(
          effective
            ? {
                laneId,
                state: String(effective.status),
                version: effective.version,
                ...(effective.pinned ? { pinned: true } : {}),
              }
            : { laneId, state: 'missing', version: 0 },
        );
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
