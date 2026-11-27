// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize, v } from 'convex/values';
import { internalMutation } from './server';
import type { Doc } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { eventBody, eventDocument, type StoredWorkEvent } from './projectWorkEventStore';
import { verifyPurgedEvents } from './projectWorkPurgedRows';

const pageRows = 64;
const pageBytes = 256 * 1024;

/** Event ids and creation times describe storage. Journal consumers key on the operation. */
function logicalDigest({ _id, _creationTime, ...event }: StoredWorkEvent) {
  void _id;
  void _creationTime;
  return digest(canonicalPayload(event));
}

/** One independently retryable project/revision page. Once verified, a row changes table in this mutation,
 * so no purge or reader ever sees two copies. The operator reconciles provider billing between calls.
 * @remove-after 2026-12-31
 */
export const page = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    after: v.number(),
    through: v.number(),
    apply: v.optional(v.object({ operationId: v.string(), expectedDigest: v.string() })),
  },
  returns: v.object({
    after: v.number(),
    done: v.boolean(),
    scanned: v.number(),
    moved: v.number(),
    digest: v.string(),
    operationKeys: v.array(v.string()),
    readBytes: v.number(),
    writtenBytes: v.number(),
  }),
  handler: async (ctx, { projectId, after, through, apply }) => {
    invariant(
      Number.isSafeInteger(after) && Number.isSafeInteger(through) && after >= 0 && through >= after,
      'BAD_ARGUMENT',
      'Select a finite Work revision window.',
    );
    const project = await ctx.db.get(projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
    invariant(
      !project.itemPurges?.some(purge => purge.purgedAt === undefined),
      'WORK_STALE',
      'Finish the active purge before relocating its Work journal.',
    );
    const source = ctx.db
      .query('projectWorkEvents')
      .withIndex('by_project_and_revision', q =>
        q.eq('projectId', projectId).gt('revision', after).lte('revision', through),
      );
    const rows: Doc<'projectWorkEvents'>[] = [];
    const purges = new Set<string>();
    let readBytes = getDocumentSize(project);
    let done = true;
    let last = after;
    for await (const row of source) {
      invariant(
        row.revision > last && row.previousRevision === row.revision - 1,
        'INVALID_WORK_JOURNAL',
        'The original Work event revision differs from its operation.',
      );
      if (rows.length === pageRows || (rows.length > 0 && readBytes >= pageBytes)) {
        readBytes += getDocumentSize(row);
        done = false;
        break;
      }
      readBytes += getDocumentSize(row);
      if (row.purged !== undefined) {
        if (!purges.has(row.purged) && purges.size === 4) {
          done = false;
          break;
        }
        purges.add(row.purged);
      }
      rows.push(row);
      last = row.revision;
    }
    await verifyPurgedEvents(ctx, projectId, rows);
    const hashes: string[] = [];
    const operationKeys = new Set<string>();
    const moves: {
      id: Doc<'projectWorkEvents'>['_id'];
      body: ReturnType<typeof eventBody>;
      bytes: number;
      hash: string;
    }[] = [];
    for (const row of rows) {
      const operationKey = digest(canonicalPayload({ projectId, operationId: row.operationId }));
      invariant(
        !operationKeys.has(operationKey),
        'INVALID_WORK_JOURNAL',
        'The original Work journal repeats an operation.',
      );
      operationKeys.add(operationKey);
      const { _id, _creationTime, previousRevision: _previousRevision, ...event } = row;
      void _creationTime;
      void _previousRevision;
      const body = eventBody(event);
      const [operation, revision] = await Promise.all([
        ctx.db
          .query('projectHostedRecordBodies')
          .withIndex('by_project_and_operation', q =>
            q.eq('projectId', projectId).eq('operationId', row.operationId),
          )
          .unique(),
        ctx.db
          .query('projectHostedRecordBodies')
          .withIndex('by_project_and_revision', q =>
            q.eq('projectId', projectId).eq('revision', row.revision),
          )
          .unique(),
      ]);
      invariant(!operation && !revision, 'INVALID_WORK_JOURNAL', 'A Work event already exists.');
      const hash = logicalDigest(row);
      hashes.push(hash);
      moves.push({ id: _id, body, hash, bytes: getDocumentSize(body) + getDocumentSize(row) });
    }
    const pageDigest = digest(hashes.join('\n'));
    if (apply)
      invariant(
        apply.operationId ===
          digest(canonicalPayload({ projectId, after, through, expectedDigest: apply.expectedDigest })) &&
          (!moves.length || (last === through && pageDigest === apply.expectedDigest)),
        'WORK_STALE',
        'Reconcile the exact dry-run Work event page before relocating it.',
      );
    let writtenBytes = 0;
    if (apply)
      for (const move of moves) {
        const insertedId = await ctx.db.insert('projectHostedRecordBodies', move.body);
        const inserted = await ctx.db.get(insertedId);
        invariant(
          inserted && logicalDigest(eventDocument(inserted)) === move.hash,
          'INVALID_WORK_JOURNAL',
          'A relocated Work event differs from its original operation.',
        );
        readBytes += getDocumentSize(inserted);
        await ctx.db.delete(move.id);
        writtenBytes += move.bytes;
      }
    if (apply && rows.length)
      await ctx.db.patch(projectId, {
        journalEventRewriteRevision: (project.journalEventRewriteRevision ?? 0) + 1,
      });
    const meter = await ctx.meta?.getTransactionMetrics?.();
    return {
      after: last,
      done,
      scanned: rows.length,
      moved: apply ? rows.length : 0,
      digest: pageDigest,
      operationKeys: [...operationKeys],
      readBytes: Math.max(readBytes, meter?.bytesRead.used ?? 0),
      writtenBytes: Math.max(writtenBytes, meter?.bytesWritten.used ?? 0),
    };
  },
});

/** Clear the obsolete window markers after the entire legacy event table is empty.
 * The page is idempotent, performs no history work and publishes no source selection.
 * @remove-after 2026-12-31
 */
export const retireWindows = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    apply: v.boolean(),
  },
  returns: v.object({
    cursor: v.union(v.string(), v.null()),
    scanned: v.number(),
    found: v.number(),
    changed: v.number(),
    readBytes: v.number(),
    writtenBytes: v.number(),
  }),
  handler: async (ctx, { cursor, apply }) => {
    invariant(
      (await ctx.db.query('projectWorkEvents').take(1)).length === 0,
      'WORK_STALE',
      'Relocate and verify the original Work events before retiring their windows.',
    );
    const batch = await ctx.db.query('hostedProjects').paginate({
      cursor,
      numItems: 32,
      maximumRowsRead: 32,
      maximumBytesRead: pageBytes,
    });
    const marked = batch.page.filter(
      project =>
        project.workStoreCutoverRevision !== undefined || project.workStoreEventWindows !== undefined,
    );
    if (apply)
      for (const project of marked)
        await ctx.db.patch(project._id, {
          workStoreCutoverRevision: undefined,
          workStoreEventWindows: undefined,
        });
    const meter = await ctx.meta?.getTransactionMetrics?.();
    return {
      cursor: batch.isDone ? null : batch.continueCursor,
      scanned: batch.page.length,
      found: marked.length,
      changed: apply ? marked.length : 0,
      readBytes: Math.max(
        batch.page.reduce((sum, project) => sum + getDocumentSize(project), 0),
        meter?.bytesRead.used ?? 0,
      ),
      writtenBytes: meter?.bytesWritten.used ?? 0,
    };
  },
});
