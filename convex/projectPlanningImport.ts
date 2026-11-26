// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { mutation, query, type QueryCtx, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { activeOwnedProject, accessibleProject } from './projectAuthority';
import { projectRole } from './projectRole';
import { publicPlanVisible } from '../src/planning-model';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { storeItem } from './projectWorkStoreReads';
import { executeCommand } from './projectWorkCommand';
import { rollupWake } from './projectPlanRollupWake';
import { beginHostedOperation, finishHostedOperation, hostedOperationRow } from './projectHostedOperations';
import { canonicalPayload, hostedPayloadHash, hostedOperationSchema } from '../src/hosted-source-operation';
import { sourceAuthority } from '../src/hosted-source-authority';
import {
  importPlanningPut,
  planningImportPageSchema,
  type PlanningImportPage,
  type PlanningImportResult,
} from '../src/planning-import';
import { invariant } from '../src/errors';
import { report } from './errors';

const args = { projectId: v.id('hostedProjects'), operationId: v.string(), request: v.string() };
type ImportRecord = Parameters<typeof publicPlanVisible>[0]['item'] & {
  id: string;
  imported?: { key: string } | undefined;
};
async function caller(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, write = false) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to import this project’s backlog.');
  return {
    actor: user.subject,
    project: await (write
      ? activeOwnedProject(ctx, projectId, user.subject)
      : accessibleProject(ctx, projectId, user.subject)),
  };
}
async function inspect(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  page: PlanningImportPage,
) {
  const { actor, project } = await caller(ctx, projectId);
  const generation = await selectedGeneration(ctx, project);
  invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'The Work index is unavailable.');
  invariant(
    new Set(page.rows.map(row => row.key)).size === page.rows.length,
    'BAD_ARGUMENT',
    'Each import page must have unique source keys.',
  );
  const publicOnly =
    project.visibility === 'public' && project.owner !== actor && !(await projectRole(ctx, project, actor));
  const cache = new Map<string, Promise<ImportRecord | null>>();
  const stored = (id: string): Promise<ImportRecord | null> => {
    if (!cache.has(id)) cache.set(id, storeItem(ctx, projectId, id));
    return cache.get(id)!;
  };
  const rows: PlanningImportResult['rows'] = [];
  for (const row of page.rows) {
    const put = importPlanningPut(row, page.batchId);
    let current = publicOnly && project.planVisibility === 'members' ? null : await stored(put.itemId);
    if (current && publicOnly) {
      const initiative = current.initiativeId ? await stored(current.initiativeId) : null;
      const parent = current.parentId ? await stored(current.parentId) : null;
      const parentInitiative = parent?.initiativeId ? await stored(parent.initiativeId) : null;
      if (
        !publicPlanVisible({
          projectVisibility: 'public',
          ...(project.planVisibility ? { planVisibility: project.planVisibility } : {}),
          item: current,
          initiative,
          parent,
          parentInitiative,
        })
      )
        current = null;
    }
    const collision = current && current.imported?.key !== row.key;
    rows.push({
      key: row.key,
      id: put.itemId,
      title: row.title,
      kind: row.kind,
      status: row.status,
      source: row.source,
      createdAt: row.createdAt ?? null,
      closedAt: row.closedAt ?? null,
      originalHandle: row.originalHandle ?? null,
      action: !row.selected ? 'not-selected' : collision ? 'attention' : current ? 'skip' : 'create',
      ...(collision
        ? { reason: 'The derived id already belongs to another Item. Existing work is unchanged.' }
        : {}),
    });
  }
  return { rows, partition: recordPartition(generation) };
}
export const preview = query({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const page = planningImportPageSchema.parse(JSON.parse(input.request));
      const { rows } = await inspect(ctx, input.projectId, page);
      return canonicalPayload({
        batchId: page.batchId,
        page: page.page,
        created: [],
        skipped: [],
        rows: [...rows].sort((a, b) => Number(b.action === 'attention') - Number(a.action === 'attention')),
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** One atomic page, existing planning reducers and existing operation receipts; no per-row RPC or acceptance. */
export const apply = mutation({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor, project } = await caller(ctx, input.projectId, true);
      const page = planningImportPageSchema.parse(JSON.parse(input.request));
      const saved = await hostedOperationRow(ctx, input.projectId, actor, input.operationId);
      const prior = saved ? hostedOperationSchema.parse(JSON.parse(saved.value)) : null;
      const expected = prior?.expected ?? { authorityEpoch: sourceAuthority(project).epoch };
      const at = new Date().toISOString();
      const payload = { kind: 'planning-import-page', ...page };
      const request = {
        schema: 1,
        projectId: input.projectId,
        actor,
        operationId: input.operationId,
        expected,
        payloadHash: hostedPayloadHash(payload, expected),
      };
      invariant(
        prior?.terminal || process.env.FORGE_PLANNING_IMPORTS === '1',
        'HOSTED_ACTION_UNSUPPORTED',
        'Backlog imports are not enabled on this deployment yet.',
      );
      const { operation } = await beginHostedOperation(ctx, {
        projectId: input.projectId,
        actor,
        request,
        payload,
        firstAttempt: {
          projectId: input.projectId,
          operationId: input.operationId,
          id: input.operationId,
          parentAttemptId: null,
          at,
          expected,
          ids: {},
        },
      });
      if (operation.terminal) {
        invariant(
          operation.terminal.outcome.status === 'completed',
          'WORK_OPERATION_CHANGED',
          'Reconcile the original import result.',
        );
        return canonicalPayload(operation.terminal.outcome.result);
      }
      const { rows, partition } = await inspect(ctx, input.projectId, page);
      invariant(
        rows.every(row => row.action !== 'attention'),
        'WORK_OPERATION_CHANGED',
        'The import meets an existing Item with another source key. Review the original source rows.',
      );
      const result: PlanningImportResult = {
        batchId: page.batchId,
        page: page.page,
        created: [],
        skipped: [],
        rows,
      };
      for (let index = 0; index < page.rows.length; index++) {
        const row = rows[index]!;
        if (row.action === 'not-selected') continue;
        if (row.action === 'skip') {
          result.skipped.push(row.id);
          continue;
        }
        const command = importPlanningPut(page.rows[index]!, page.batchId);
        await executeCommand(
          ctx,
          {
            projectId: input.projectId,
            operationId: command.operationId,
            command: canonicalPayload(command),
          },
          actor,
          { planningImport: true },
        );
        result.created.push(row.id);
      }
      const first = result.created[0];
      if (first && project.autonomyPolicy?.rollUpPlanningStatus !== false)
        await ctx.scheduler.runAfter(0, rollupWake, {
          projectId: input.projectId,
          partition,
          cause: input.operationId,
          itemId: first,
          source: 'import',
        });
      await finishHostedOperation(ctx, {
        projectId: input.projectId,
        actor,
        operationId: input.operationId,
        receipt: { attemptId: operation.firstAttempt.id, at, outcome: { status: 'completed', result } },
      });
      return canonicalPayload(result);
    } catch (error) {
      return report(error);
    }
  },
});
