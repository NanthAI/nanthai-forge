// SPDX-License-Identifier: Apache-2.0
// One comment's purge (Item b6588425 line 2b): the operator's purge of a reported planning comment. It reuses the
// Item purge's redaction (convex/projectPlanningPurgeRedact.ts) on the stores that hold that one comment, in one
// mutation: a `purge-planning-comment` journal row listing the comment's row with the digest of its redacted facts
// (so every reader accepts the purged row by the one reader rule, convex/projectWorkPurgedRows.ts); the comment's
// journal row; its `events` and `planningComments` records (and payload chunks) on every record partition, and their
// store fingerprints; its work-store versions and head; and its discussion attachments. The Item and every other row
// stay as they are. A comment row never enters a journal segment (projectJournalSelect wordsRow, projectJournalWake
// wordsKinds), so nothing in R2 holds its words except its attachments, whose byte cleanup is scheduled.
// Cost: one comment, a few point reads per record partition (usually one or two), one journal append and at most a
// few dozen small writes; nothing runs while idle and there is no cron.
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { planningCommentCommandSchema, type PlanningCommentPurge } from '../src/work-planning-types';
import { purgedFactsDigest, redactPlanningWrite } from '../src/work-intent-types';
import { purgedIndexValue } from '../src/work-planning-purge';
import { executeCommand } from './projectWorkCommand';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { hostedRecordBody, recordHead } from './projectHostedRecords';
import { journalRow as storedRow } from '../src/work-store-records';
import { removeArtifact } from './artifactStorage';
import { projectPrefix } from './r2Operations';
import { baseRevision, DISPLAY_BLOCK, displaySnapshots } from './projectPlanningPurgeSelect';
import {
  dropFingerprint,
  fingerprint,
  indexRecord,
  journalRow,
  partitionsOf,
  storeRecord,
} from './projectPlanningPurgeRedact';

/** Versions one comment has in the work store (it is written once; a copy or migration may add one). */
const COMMENT_VERSION_LIMIT = 16;
/** Attachments one comment's discussion namespace holds, read in one transaction. */
const ATTACHMENT_LIMIT = 64;
/** Staged pages one failed index build may still keep (derived rows; its build cannot resume), deleted here. */
const STAGED_PAGE_LIMIT = 8;
/** The comment's copies one purge reads (journal row, version body, an events and a comments record per partition),
 * kept well under Convex's per-transaction read limit. */
const READ_BUDGET = 8 * 1024 * 1024;

type Input = { projectId: Id<'hostedProjects'>; itemId: string; commentId: string; operationId: string };

/** The comment's live journal row, in either journal table. */
async function commentRow(ctx: MutationCtx, projectId: Id<'hostedProjects'>, commentId: string) {
  return (
    (await ctx.db
      .query('projectWorkEvents')
      .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', commentId))
      .unique()) ??
    (await ctx.db
      .query('projectHostedRecordBodies')
      .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', commentId))
      .unique())
  );
}

/** The Item the comment is on, as its reader sees it: the work-store head in records mode, else the selected index. */
async function commentParent(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  input: Input,
  partition: Id<'projectWorkGenerations'>,
) {
  if (project.workStore === 'records')
    return (await recordHead(ctx, input.projectId, 'comment', input.commentId))?.parent;
  return (await record(ctx, partition, 'planningComments', input.commentId))?.parent;
}

/** Purge one planning comment. Returns 1 when this purge removed it (also on a retry with the same operationId), 0
 * when an earlier purge (its Item's, or another comment purge) already did. Refuses, with nothing written, a decision
 * comment (its words are also a line of the Item body, kept in every later version: purge the Item), a comment in the
 * base checkpoint or not in the live journal (a stored archive a rebuild reads again), a project with hosted display
 * snapshots, and a Work index being built (it may copy the words again). */
export async function purgeComment(ctx: MutationCtx, input: Input): Promise<0 | 1> {
  const project = await ctx.db.get(input.projectId);
  invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
  const generation = await selectedGeneration(ctx, project);
  invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
  const missing = 'No comment with that id on that Item.';
  invariant(
    (await commentParent(ctx, project, input, recordPartition(generation))) === input.itemId,
    'NOT_FOUND',
    missing,
  );
  const row = await commentRow(ctx, input.projectId, input.commentId);
  invariant(
    row && row.revision !== undefined && row.request !== undefined,
    'BAD_ARGUMENT',
    'This comment is not in the live Work journal: it is in the base checkpoint, whose stored archive a rebuild reads again, so a base-checkpoint scrub must come first. Nothing was purged.',
  );
  if (row.purged !== undefined && row.purged !== input.operationId) return 0;
  if (row.purged === input.operationId) {
    await redactComment(ctx, input);
    return 1;
  }
  invariant(
    !('journalSegment' in row && row.journalSegment) && row.command !== undefined,
    'BAD_ARGUMENT',
    'This comment’s Work row is in the journal archive; a comment purge cannot rewrite it. Purge its Item instead. Nothing was purged.',
  );
  const parsed = planningCommentCommandSchema.safeParse(JSON.parse(row.command));
  invariant(parsed.success && parsed.data.operationId === input.commentId, 'NOT_FOUND', missing);
  invariant(
    !parsed.data.decision,
    'BAD_ARGUMENT',
    'This is a decision comment: its words are also a line in the Item’s Decisions, kept in every later version of the Item. Purge the Item instead. Nothing was purged.',
  );
  invariant(
    row.revision > baseRevision(project, generation),
    'BAD_ARGUMENT',
    'This comment is in the base checkpoint: its words are in the stored archive, which a rebuild reads again, so a base-checkpoint scrub must come first. Nothing was purged.',
  );
  invariant(!(await displaySnapshots(ctx, input.projectId)), 'BAD_ARGUMENT', DISPLAY_BLOCK);
  const generations = await ctx.db
    .query('projectWorkGenerations')
    .withIndex('by_project_and_backup_and_revision_and_format', q => q.eq('projectId', input.projectId))
    .take(65);
  invariant(
    !generations.some(item => item.status === 'building'),
    'WORK_STALE',
    'A Work index build is running and may copy the comment again. Retry the purge after it finishes. Nothing was purged.',
  );
  const partitions = await partitionsOf(ctx, input.projectId);
  for (const partition of partitions)
    invariant(
      !(
        await ctx.db
          .query('projectWorkRecords')
          .withIndex('by_generation_and_collection_and_key', q =>
            q.eq('generationId', partition).eq('collection', 'planningComments').eq('key', input.commentId),
          )
          .take(1)
      ).length,
      'WORK_STALE',
      'A Work record-table migration still keeps an old copy of this comment. Retry the purge after its cleanup finishes. Nothing was purged.',
    );
  invariant(
    new TextEncoder().encode(row.command).length * (2 * partitions.length + 3) <= READ_BUDGET,
    'WORK_STALE',
    `This comment is too large to purge from ${partitions.length} Work index partitions in one step. Retire the old partitions, or purge its Item. Nothing was purged.`,
  );
  // A failed build's staged pages are serialized index batches that may hold the words; the build cannot resume.
  for (const failed of generations.filter(item => item.status === 'failed')) {
    const pages = (
      await ctx.db
        .query('projectReturnPages')
        .withIndex('by_partition_and_key_and_position', q => q.eq('partitionId', failed._id))
        .take(STAGED_PAGE_LIMIT + 64)
    ).filter(page => !page.key.startsWith('workRecordTables:'));
    invariant(
      pages.length <= STAGED_PAGE_LIMIT,
      'WORK_STALE',
      'A failed Work index build keeps more staged pages than one purge removes. Retire it, then retry. Nothing was purged.',
    );
    for (const page of pages) await ctx.db.delete(page._id);
  }
  const digest = purgedFactsDigest(redactPlanningWrite(parsed.data));
  const command: PlanningCommentPurge = {
    action: 'purge-planning-comment',
    operationId: input.operationId,
    itemId: input.itemId,
    commentId: input.commentId,
    rows: [[input.commentId, digest]],
  };
  await executeCommand(
    ctx,
    { projectId: input.projectId, operationId: input.operationId, command: JSON.stringify(command) },
    project.owner,
    { purge: true },
  );
  await redactComment(ctx, input, digest);
  // A Work load or export that started before this purge refuses to finish over it (convex/projectWorkLoad.ts).
  const current = (await ctx.db.get(input.projectId))!;
  await ctx.db.patch(input.projectId, {
    planningPurgeRevision: (current.planningPurgeRevision ?? 0) + 1,
  });
  return 1;
}

/** Every copy of the comment in its purged form. Each step is a fixed point, so a retry changes nothing. */
async function redactComment(ctx: MutationCtx, input: Input, digest?: string) {
  const { db } = ctx;
  const { projectId, commentId, operationId } = input;
  // A retry finds the row already purged (journalRow changes nothing then).
  if (digest !== undefined) await journalRow(ctx, db, projectId, commentId, digest, operationId);
  for (const partition of await partitionsOf(ctx, projectId)) {
    await indexRecord(ctx, db, partition, 'events', commentId, operationId, new Map());
    await indexRecord(ctx, db, partition, 'planningComments', commentId, operationId, new Map());
    await dropFingerprint(ctx, db, partition, fingerprint('planningComments'), commentId);
  }
  // A head stored before heads kept their value reads its version's body, which the purge empties: it gets the
  // tombstone inline instead, from that body, before the body goes.
  const head = await recordHead(ctx, projectId, 'comment', commentId);
  const headRecord = head && head.value === undefined ? await db.get(head.recordId) : null;
  const current =
    head?.value !== undefined
      ? JSON.parse(head.value)
      : headRecord && headRecord.purged === undefined
        ? storedRow(JSON.parse(await hostedRecordBody(ctx, headRecord)))
        : undefined;
  const versions = await db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
      q.eq('projectId', projectId).eq('kind', 'comment').eq('key', commentId),
    )
    .take(COMMENT_VERSION_LIMIT + 1);
  invariant(
    versions.length <= COMMENT_VERSION_LIMIT,
    'WORK_STALE',
    'This comment has more stored versions than one purge reads.',
  );
  for (const version of versions) await storeRecord(ctx, db, version, { operationId });
  if (head && current !== undefined) {
    const value = JSON.stringify(purgedIndexValue('planningComments', current, operationId));
    if (value !== head.value) await db.patch(head._id, { value });
  }
  const namespace = `${projectPrefix(projectId)}discussion/${input.itemId}/${commentId}`;
  const attachments = await db
    .query('artifactBlobs')
    .withIndex('by_namespace_and_digest', q => q.eq('namespace', namespace))
    .take(ATTACHMENT_LIMIT + 1);
  invariant(
    attachments.length <= ATTACHMENT_LIMIT,
    'WORK_STALE',
    'This comment has more attachments than one purge removes.',
  );
  for (const attachment of attachments) await removeArtifact(ctx, attachment);
}
