// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation } from './server';
import { invariant } from '../src/errors';
import { pinnedPlanningTimes } from './projectPlanningTimes';

const pageBytes = 256 * 1024;
const reserveBytes = pageBytes + 1024 * 1024;
const readCap = 64 * 1024 * 1024;
const family = v.union(
  v.literal('projects'),
  v.literal('issuePins'),
  v.literal('comparison'),
  v.literal('recordDigests'),
);
const selection = {
  family,
  projectId: v.optional(v.id('hostedProjects')),
  cursor: v.union(v.string(), v.null()),
};
const args = {
  ...selection,
  deployment: v.string(),
  apply: v.boolean(),
};

function requireDeployment(name: string) {
  invariant(
    /^[a-z0-9-]+$/.test(name) && process.env.CONVEX_CLOUD_URL === `https://${name}.convex.cloud`,
    'BAD_ARGUMENT',
    'Name the exact deployment before inspecting or clearing legacy Work-store rows.',
  );
}

function comparisonCollection(collection: string) {
  return (
    collection === '_workStoreDigestCoverage' ||
    collection.startsWith('_workStoreDigests:') ||
    collection.startsWith('_workStoreHeads:')
  );
}

/** A page performs one bounded index read, followed by zero or more writes in the same transaction. */
export const page = internalMutation({
  args,
  returns: v.object({
    nextCursor: selection.cursor,
    scanned: v.number(),
    found: v.number(),
    changed: v.number(),
    readBytes: v.number(),
    writeBytes: v.number(),
    blocked: v.number(),
    active: v.array(v.id('hostedProjects')),
  }),
  handler: async (ctx, input) => {
    requireDeployment(input.deployment);
    invariant(
      (input.family === 'issuePins') === (input.projectId !== undefined) &&
        (input.family !== 'issuePins' || !input.apply),
      'BAD_ARGUMENT',
      'Issue pin proof reads one active project. Other cleanup families scan their complete index.',
    );
    const bounds = {
      cursor: input.cursor,
      numItems: 100,
      maximumRowsRead: 100,
      maximumBytesRead: pageBytes,
    };
    let readBytes = 0,
      writeBytes = 0,
      found = 0,
      changed = 0,
      blocked = 0;
    const active: NonNullable<typeof input.projectId>[] = [];
    const finish = async (result: {
      page: unknown[];
      isDone: boolean;
      continueCursor: string;
      pageStatus?: 'SplitRecommended' | 'SplitRequired' | null;
    }) => {
      // The processed page prefix is complete through continueCursor even when Convex
      // recommends splitting the remainder. A nonmoving cursor must never report success.
      const done = result.isDone && result.pageStatus !== 'SplitRequired';
      invariant(
        done || result.continueCursor !== input.cursor,
        'WORK_STALE',
        'Cleanup page did not advance its index cursor.',
      );
      const meter = await ctx.meta?.getTransactionMetrics?.();
      return {
        nextCursor: done ? null : result.continueCursor,
        scanned: result.page.length,
        found,
        changed,
        blocked,
        active,
        readBytes: Math.max(readBytes, meter?.bytesRead.used ?? 0),
        writeBytes: Math.max(writeBytes, meter?.bytesWritten.used ?? 0),
      };
    };
    if (input.family === 'projects') {
      const result = await ctx.db.query('hostedProjects').paginate(bounds);
      const retired = [];
      for (const project of result.page) {
        readBytes += getDocumentSize(project);
        const hasMode = project.workStore !== undefined || project.workStoreWriters !== undefined;
        const ready =
          project.workStoreCutoverRevision !== undefined &&
          project.workStoreEventWindows?.at(-1)?.storeFirst === true &&
          (!hasMode ||
            (project.workStore === 'records' &&
              ['note', 'intent', 'intent-status', 'planning'].every(writer =>
                project.workStoreWriters?.some(value => value === writer),
              )));
        if (!project.removal && project.work) {
          active.push(project._id);
          if (!ready) blocked++;
        }
        if (!hasMode) continue;
        found++;
        retired.push(project);
      }
      if (input.apply && !blocked)
        for (const project of retired) {
          await ctx.db.patch(project._id, { workStore: undefined, workStoreWriters: undefined });
          changed++;
          writeBytes += getDocumentSize(project);
        }
      return finish(result);
    }
    if (input.family === 'issuePins') {
      const result = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind', q => q.eq('projectId', input.projectId!).eq('kind', 'issue'))
        .paginate(bounds);
      for (const head of result.page) {
        readBytes += getDocumentSize(head);
        if (!pinnedPlanningTimes(head)) blocked++;
      }
      return finish(result);
    }
    if (input.family === 'comparison') {
      // Include every project in the index, even a row whose generation or project has since gone away.
      const result = await ctx.db.query('projectWorkDataRecords').withIndex('by_project').paginate(bounds);
      for (const row of result.page) {
        readBytes += getDocumentSize(row);
        if (!comparisonCollection(row.collection)) continue;
        found++;
        if (!input.apply) continue;
        await ctx.db.delete(row._id);
        changed++;
      }
      return finish(result);
    }
    const result = await ctx.db.query('projectHostedRecords').withIndex('by_project').paginate(bounds);
    for (const row of result.page) {
      readBytes += getDocumentSize(row);
      if (row.workReadDigest === undefined) continue;
      found++;
      if (!input.apply) continue;
      await ctx.db.patch(row._id, { workReadDigest: undefined });
      changed++;
      writeBytes += getDocumentSize(row);
    }
    return finish(result);
  },
});

/** The operator passes the remaining cumulative budget, including proof and previous invocations. */
export const run = internalAction({
  args: { ...args, budgetBytes: v.number(), pages: v.number() },
  returns: v.object({
    nextCursor: selection.cursor,
    scanned: v.number(),
    found: v.number(),
    changed: v.number(),
    readBytes: v.number(),
    writeBytes: v.number(),
    blocked: v.number(),
    active: v.array(v.id('hostedProjects')),
    pages: v.number(),
    stopped: v.union(v.null(), v.literal('budget'), v.literal('pages'), v.literal('blocked')),
  }),
  handler: async (ctx, { budgetBytes, pages, ...input }) => {
    requireDeployment(input.deployment);
    invariant(
      Number.isSafeInteger(budgetBytes) &&
        budgetBytes >= 0 &&
        budgetBytes <= readCap &&
        Number.isSafeInteger(pages) &&
        pages > 0 &&
        pages <= 100,
      'BAD_ARGUMENT',
      'Pass the remaining budget (up to 64 MiB) and 1 to 100 pages.',
    );
    const total: {
      nextCursor: typeof input.cursor;
      scanned: number;
      found: number;
      changed: number;
      readBytes: number;
      writeBytes: number;
      blocked: number;
      active: NonNullable<typeof input.projectId>[];
      pages: number;
      stopped: 'budget' | 'pages' | 'blocked' | null;
    } = {
      nextCursor: input.cursor,
      scanned: 0,
      found: 0,
      changed: 0,
      readBytes: 0,
      writeBytes: 0,
      blocked: 0,
      active: [],
      pages: 0,
      stopped: null,
    };
    while (total.pages < pages && total.readBytes + reserveBytes <= budgetBytes) {
      const result = await ctx.runMutation(internal.legacyWorkStoreMode.page, {
        ...input,
        cursor: total.nextCursor,
      });
      total.pages++;
      total.nextCursor = result.nextCursor;
      for (const key of ['scanned', 'found', 'changed', 'readBytes', 'writeBytes', 'blocked'] as const)
        total[key] += result[key];
      total.active.push(...result.active);
      if (result.blocked) {
        total.stopped = 'blocked';
        return total;
      }
      if (result.nextCursor === null) return total;
    }
    total.stopped = total.readBytes + reserveBytes > budgetBytes ? 'budget' : 'pages';
    return total;
  },
});
