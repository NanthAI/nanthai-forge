// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from './server';
import type { HostedRecord } from '../src/hosted-records';
import { invariant } from '../src/errors';
import { indexedSaveStatus, saveHeadFact, unindexedSaveHeads } from './projectMetricSaveHeads';

const batchSize = 80;

/** The changed status removes a completed fact from the front of this index in
 * the same transaction that inserts it. Retries can never project a head twice. */
export const backfillPage = internalMutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.optional(v.string()) },
  returns: v.object({ complete: v.boolean(), inserted: v.number() }),
  handler: async (ctx, { projectId, operationId }) => {
    const project = await ctx.db.get(projectId);
    if (!project || project.removal) return { complete: true, inserted: 0 };
    if (
      operationId !== undefined &&
      (project.metricSaveHeadResume?.operationId !== operationId ||
        project.metricSaveHeadResume.phase !== 'scheduled')
    )
      return { complete: true, inserted: 0 };

    const heads = await unindexedSaveHeads(ctx, projectId).take(batchSize);
    for (const head of heads) {
      const save = await ctx.db.get(head.recordId);
      invariant(
        save?.projectId === projectId && save.kind === 'save' && save.key === head.key,
        'EVIDENCE_CHANGED',
        'Metric save version is missing.',
      );
      const body = await ctx.db.get(save.bodyId);
      invariant(body?.projectId === projectId, 'EVIDENCE_CHANGED', 'Metric record body is missing.');
      const record = JSON.parse(body.value) as HostedRecord;
      invariant(
        record.kind === 'save' && record.id === head.key && record.laneId === head.parent,
        'EVIDENCE_CHANGED',
        'Metric save identity changed.',
      );
      await ctx.db.insert('projectMetricFacts', saveHeadFact(projectId, save._creationTime, record));
      await ctx.db.patch(head._id, { status: indexedSaveStatus });
    }
    const complete = heads.length < batchSize;
    if (!complete && operationId !== undefined)
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('projectMetricSaveHeadBackfill:backfillPage'),
        {
          projectId,
          operationId,
        },
      );
    return { complete, inserted: heads.length };
  },
});

/** Start the initial bounded fill once a compatible writer is deployed. The
 * original request can be replayed without creating another scheduled chain. */
export const start = internalMutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.object({ scheduled: v.boolean(), started: v.boolean() }),
  handler: async (ctx, { projectId, operationId }) => {
    const project = await ctx.db.get(projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'The project is unavailable.');
    if (project.metricSaveHeadResume?.operationId === operationId)
      return { scheduled: project.metricSaveHeadResume.phase === 'scheduled', started: false };
    if (!(await unindexedSaveHeads(ctx, projectId).first())) return { scheduled: false, started: false };
    await ctx.db.patch(projectId, {
      metricSaveHeadResume: { operationId, requestedAt: Date.now(), phase: 'scheduled' },
    });
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectMetricSaveHeadBackfill:backfillPage'),
      { projectId, operationId },
    );
    return { scheduled: true, started: true };
  },
});

/** Before rolling back the writer, return reports to canonical reads and hand
 * bounded repair to the next save made after the compatible writer returns. */
export const invalidate = internalMutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId, operationId }) => {
    const project = await ctx.db.get(projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'The project is unavailable.');
    if (project.metricSaveHeadResume?.operationId === operationId) return false;
    await ctx.db.patch(projectId, {
      metricSaveHeadResume: { operationId, requestedAt: Date.now(), phase: 'pending' },
    });
    return true;
  },
});
