// SPDX-License-Identifier: Apache-2.0
// One comment's purge (Item b6588425 lines 2b, 2c): the operator's purge of a reported planning comment. It reuses the
// Item purge's redaction (convex/projectPlanningPurgeRedact.ts) on the stores that hold that one comment, in one
// mutation: a `purge-planning-comment` journal row listing the comment's row with the digest of its redacted facts
// (so every reader accepts the purged row by the one reader rule, convex/projectWorkPurgedRows.ts); the comment's
// journal row; its `events` and `planningComments` records (and payload chunks) on every record partition, and their
// store fingerprints; its work-store versions and head; its rows in hosted display snapshots; and its discussion
// attachments. A decision comment also gets an audited put that replaces its line in the Item body, and its derived
// body version takes the form a rebuild gives it. The Item and every other row stay as they are. A comment row no
// longer enters a journal segment (projectJournalSelect wordsRow, projectJournalWake wordsKinds); one archived before
// that is read by convex/projectCommentPurgeArchive.ts, which passes its command here and rewrites its segment after.
// Cost: one comment, a few point reads per record partition (usually one or two) and per display snapshot, one
// journal append (two for a decision) and at most a few dozen small writes; nothing runs while idle and there is no
// cron.
import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { planningCommentCommandSchema, type PlanningCommentPurge } from '../src/work-planning-types';
import { purgedFactsDigest, redactPlanningWrite } from '../src/work-intent-types';
import { decisionLine, decisionOperationId } from '../src/work-planning-put';
import { purgedDecisionRequest } from '../src/work-planning-state';
import { metadataRequest } from '../src/work-metadata';
import { digest } from '../src/state/hash';
import { workReadDigest } from './projectWorkStoreDigests';
import { purgedIndexValue } from '../src/work-planning-purge';
import { executeCommand } from './projectWorkCommand';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { hostedRecordBody, recordHead } from './projectHostedRecords';
import { journalRow as storedRow } from '../src/work-store-records';
import { removeArtifact } from './artifactStorage';
import { projectPrefix } from './r2Operations';
import { baseRevision } from './projectPlanningPurgeSelect';
import { readArchiveCoverage } from './projectPlanningArchiveCoverage';
import {
  dropFingerprint,
  fingerprint,
  indexRecord,
  indexValue,
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
/** Hosted display snapshots one purge visits (one indexed read each); dogfood keeps none. */
const SNAPSHOT_LIMIT = 64;
/** Finished purge entries a project keeps (as convex/projectPlanningPurge.ts keeps them). */
const KEPT_FINISHED_PURGES = 20;
/** The reason the audited body edit of a purged decision comment carries in Versions. */
export const DECISION_EDIT_REASON = 'Removed the words of a purged decision comment';

type Input = {
  projectId: Id<'hostedProjects'>;
  itemId: string;
  commentId: string;
  operationId: string;
  /** The comment's command as its journal segment holds it (convex/projectCommentPurgeArchive.ts), for a row whose
   * command is in the journal archive; checked against the live row's request hash. */
  archived?: string;
};
type Comment = ReturnType<typeof planningCommentCommandSchema.parse>;

/** A stable Work operation id derived from the purge's (the decision's body edit), never shared with another. */
const derivedOperation = (kind: string, operationId: string) => {
  const hex = digest(JSON.stringify([kind, operationId]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Purge one comment (purgeComment) as its own transaction: the archived path's first step, and the operator's
 * direct route outside an abuse review. */
export const purge = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    itemId: v.string(),
    commentId: v.string(),
    operationId: v.string(),
    archived: v.optional(v.string()),
  },
  returns: v.number(),
  handler: (ctx, input) => purgeComment(ctx, input),
});

/** Whether the comment's live journal row keeps its command in the journal archive (an R2 segment), so its purge
 * must read the command there first (convex/projectCommentPurgeArchive.ts). */
export async function archivedComment(ctx: MutationCtx, projectId: Id<'hostedProjects'>, commentId: string) {
  const row = await commentRow(ctx, projectId, commentId);
  return !!(row && 'journalSegment' in row && row.journalSegment && row.purged === undefined);
}

/** The comment's live journal row, in either journal table. */
export async function commentRow(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  commentId: string,
) {
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
 * when an earlier purge (its Item's, or another comment purge) already did. A decision comment's line in the Item
 * body is replaced by an audited put, and its derived body version takes the form a rebuild gives it. A row in the
 * journal archive needs its command from the segment (`archived`); the purge then registers the segment rewrite.
 * Refuses, with nothing written, a comment in the base checkpoint (its words are in the stored archive, which a
 * rebuild reads again: line 2d), and a Work index being built (it may copy the words again). */
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
  const archived = !!('journalSegment' in row && row.journalSegment);
  // An archived row is purged in its segment later; its live steps all ran in the first call.
  const begun = project.itemPurges?.some(
    purge => purge.operationId === input.operationId && purge.commentId === input.commentId,
  );
  if (row.purged === input.operationId || begun) {
    await redactComment(ctx, input);
    return 1;
  }
  const text = archived ? input.archived : row.command;
  invariant(
    text !== undefined,
    'BAD_ARGUMENT',
    'This comment’s Work row is in the journal archive; its purge reads it there first (projectCommentPurgeArchive:run). Nothing was purged.',
  );
  const parsed = planningCommentCommandSchema.safeParse(JSON.parse(text));
  invariant(parsed.success && parsed.data.operationId === input.commentId, 'NOT_FOUND', missing);
  invariant(
    !archived || metadataRequest(parsed.data) === row.request,
    'INVALID_WORK_JOURNAL',
    'The archived comment differs from its Work row. Nothing was purged.',
  );
  invariant(
    row.revision > baseRevision(project, generation),
    'BAD_ARGUMENT',
    'This comment is in the base checkpoint: its words are in the stored archive, which a rebuild reads again, so a base-checkpoint scrub must come first. Nothing was purged.',
  );
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
    new TextEncoder().encode(text).length * (2 * partitions.length + 3) <= READ_BUDGET,
    'WORK_STALE',
    `This comment is too large to purge from ${partitions.length} Work index partitions in one step. Retire the old partitions, or purge its Item. Nothing was purged.`,
  );
  if (parsed.data.decision) await derivedVersionStored(ctx, input, recordPartition(generation));
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
  // A decision's line goes from the current body first, by an audited put, so the purge is the Item's last row.
  const decision = parsed.data.decision ? decisionLines(parsed.data, row.at ?? '') : undefined;
  if (decision) await decisionBodyEdit(ctx, project, input, recordPartition(generation), decision);
  const facts = purgedFactsDigest(redactPlanningWrite(parsed.data));
  const command: PlanningCommentPurge = {
    action: 'purge-planning-comment',
    operationId: input.operationId,
    itemId: input.itemId,
    commentId: input.commentId,
    rows: [[input.commentId, facts]],
  };
  await executeCommand(
    ctx,
    { projectId: input.projectId, operationId: input.operationId, command: JSON.stringify(command) },
    project.owner,
    { purge: true },
  );
  await redactComment(ctx, input, facts);
  if (decision) await decisionVersion(ctx, input, decision, purgedDecisionRequest(row.request));
  // A Work load or export that started before this purge refuses to finish over it (convex/projectWorkLoad.ts).
  const current = (await ctx.db.get(input.projectId))!;
  await ctx.db.patch(input.projectId, {
    planningPurgeRevision: (current.planningPurgeRevision ?? 0) + 1,
    // The archived row's segment rewrite runs as this purge's segment sweep (convex/projectCommentPurgeArchive.ts).
    ...(archived
      ? {
          itemPurges: [
            {
              operationId: input.operationId,
              itemId: input.itemId,
              commentId: input.commentId,
              ids: [input.itemId],
              intentKeys: [],
              version: 0,
              decisions: [],
              rows: 1,
              startedAt: Date.now(),
              // The sweep pages the Item's archived segments by the archive index when its coverage is complete.
              segmentSweep: {
                after: null,
                done: false,
                ...((await readArchiveCoverage(ctx, current)).state.ready ? { indexed: true as const } : {}),
              },
            },
            // Finished entries are kept as the Item purge keeps them (the last few), so the project stays small.
            ...(current.itemPurges ?? []).filter(item => item.purgedAt === undefined),
            ...(current.itemPurges ?? [])
              .filter(item => item.purgedAt !== undefined)
              .slice(0, KEPT_FINISHED_PURGES - 1),
          ],
        }
      : {}),
  });
  return 1;
}

/** The archived path's last step, after the segment rewrite published the purged row: the comment's live copies again
 * (a fixed point), for an index build that read the whole archived row while the rewrite ran, and a new purge
 * revision, so a load or export that read it refuses to finish. Refused while a build runs (it may still copy it). */
export async function settleComment(ctx: MutationCtx, input: Input) {
  const generations = await ctx.db
    .query('projectWorkGenerations')
    .withIndex('by_project_and_backup_and_revision_and_format', q => q.eq('projectId', input.projectId))
    .take(65);
  invariant(
    !generations.some(item => item.status === 'building'),
    'WORK_STALE',
    'A Work index build is running and may copy the comment again. The purge finishes after it.',
  );
  await redactComment(ctx, input);
  const row = await commentRow(ctx, input.projectId, input.commentId);
  invariant(
    row?.purged === input.operationId && row.request,
    'WORK_STALE',
    'The comment’s row is not purged yet.',
  );
  const facts = JSON.parse(('journalCommand' in row && row.journalCommand) || row.command || '{}') as Comment;
  if (facts.decision)
    await decisionVersion(ctx, input, decisionLines(facts, row.at ?? ''), purgedDecisionRequest(row.request));
  const project = (await ctx.db.get(input.projectId))!;
  await ctx.db.patch(input.projectId, { planningPurgeRevision: (project.planningPurgeRevision ?? 0) + 1 });
}

/** The decision's line in a body is found by its comment marker (the line's text may have been edited since), and
 * becomes the line a replay of the purged row writes. `comment` is the command, or the purged row's facts. */
function decisionLines(comment: Comment, at: string) {
  // Redaction is a fixed point, so the purged row's facts give the same line as the whole command.
  const redacted = redactPlanningWrite(comment);
  return {
    marker: `(comment ${comment.operationId.slice(0, 8)})`,
    redacted: decisionLine({
      at,
      label: redacted.decidedBy ?? redacted.authorLabel ?? '',
      text: redacted.text,
      commentId: comment.operationId,
    }),
  };
}
type Lines = ReturnType<typeof decisionLines>;

/** The body with the decision's lines replaced (`last`: only the last, the derived version's own appended line), and
 * how many lines carried the marker. */
function scrubDecision(body: string, lines: Lines, which: 'all' | 'last') {
  const rows = body.split('\n');
  const at = rows.flatMap((row, index) =>
    row.startsWith('- ') && row.trimEnd().endsWith(lines.marker) ? [index] : [],
  );
  for (const index of which === 'last' ? at.slice(-1) : at) rows[index] = lines.redacted;
  return { body: rows.join('\n'), count: at.length };
}

/** The audited edit: a put, as the owner, that replaces the decision's line in the Item's current body (its reason
 * says why in Versions). Nothing when the body no longer has the line. Two lines with this comment's marker (another
 * comment sharing its short id) are refused: the purge cannot tell which is this one. */
async function decisionBodyEdit(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  input: Input,
  partition: Id<'projectWorkGenerations'>,
  lines: Lines,
) {
  const root = await record(ctx, partition, 'planningItems', input.itemId);
  if (!root) return;
  const { full } = await indexValue(ctx, partition, 'planningItems', root);
  if (typeof full.body !== 'string') return;
  const scrubbed = scrubDecision(full.body, lines, 'all');
  invariant(
    scrubbed.count <= 1,
    'BAD_ARGUMENT',
    'The Item body has two decision lines with this comment’s short id. Edit the body by hand, then purge. Nothing was purged.',
  );
  if (scrubbed.body === full.body) return;
  const operationId = derivedOperation('comment-purge-decision-edit', input.operationId);
  const put = {
    action: 'put-planning-item',
    operationId,
    itemId: input.itemId,
    expectedVersion: Number(full.version),
    body: scrubbed.body,
    reason: DECISION_EDIT_REASON,
  };
  await executeCommand(
    ctx,
    { projectId: input.projectId, operationId, command: JSON.stringify(put) },
    project.owner,
    {
      server: true,
    },
  );
}

/** The decision's derived body version (written with the comment, src/work-planning-state.ts) in the form a replay of
 * the purged comment gives it: the line replaced and the request derived from the comment's. Every record partition's
 * version record and the work-store version body. A fixed point. */
async function decisionVersion(ctx: MutationCtx, input: Input, lines: Lines, request: string) {
  const key = decisionOperationId(input.commentId);
  const rewrite = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const row = { ...(value as Record<string, unknown>) };
    if (typeof row.body === 'string') {
      const body = scrubDecision(row.body, lines, 'last').body;
      row.body = body;
      if (typeof row.bodyLength === 'number' && !row.bodyTruncated) row.bodyLength = body.length;
    }
    if ('request' in row) row.request = request;
    return row;
  };
  let version: number | undefined;
  for (const partition of await partitionsOf(ctx, input.projectId)) {
    const root = await record(ctx, partition, 'planningVersions', key);
    if (!root) continue;
    version ??= Number((JSON.parse(root.value) as { version?: unknown }).version);
    await indexRecord(
      ctx,
      ctx.db,
      partition,
      'planningVersions',
      key,
      input.operationId,
      new Map(),
      root,
      rewrite,
    );
  }
  if (version === undefined || !Number.isInteger(version)) return;
  await dropDisplayRows(ctx, input.projectId, 'issue', input.itemId, version);
  const stored = await ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
      q.eq('projectId', input.projectId).eq('kind', 'issue').eq('key', input.itemId).eq('version', version),
    )
    .take(2);
  for (const row of stored) {
    if (row.purged !== undefined) continue;
    const body = row.inline === undefined ? await ctx.db.get(row.bodyId) : null;
    // A body moved to the journal archive after the purge's first step was rewritten by that step.
    const text = row.inline ?? body?.value;
    // Only the derived version's own body (no journal row of its own): a put's version is its row's to keep.
    if (text === undefined || body?.operationId !== undefined) continue;
    const parsed = JSON.parse(text) as Record<string, unknown> & { kind: string; item?: unknown };
    if ((parsed.item as { operationId?: string } | undefined)?.operationId !== key) continue;
    const value = JSON.stringify({ ...parsed, item: rewrite(parsed.item) });
    if (value === text) continue;
    if (body) await ctx.db.patch(body._id, { value });
    // An Item version (selected by kind above), never a Candidate head: the publication guard reads `kind`.
    await ctx.db.patch(row._id, {
      kind: 'issue' as const,
      ...(row.inline === undefined ? {} : { inline: value }),
      digest: digest(value),
      bytes: new TextEncoder().encode(value).length,
      ...(row.workReadDigest === undefined
        ? {}
        : { workReadDigest: workReadDigest(storedRow(JSON.parse(value))) }),
    });
  }
}

/** Refuses (before anything is written) a decision whose derived Item version keeps its body only in the journal
 * archive: the comment's segment sweep does not rewrite Item versions. */
async function derivedVersionStored(ctx: MutationCtx, input: Input, partition: Id<'projectWorkGenerations'>) {
  const root = await record(ctx, partition, 'planningVersions', decisionOperationId(input.commentId));
  const version = root && Number((JSON.parse(root.value) as { version?: unknown }).version);
  if (!version || !Number.isInteger(version)) return;
  const stored = await ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
      q.eq('projectId', input.projectId).eq('kind', 'issue').eq('key', input.itemId).eq('version', version),
    )
    .take(2);
  for (const row of stored)
    invariant(
      row.purged !== undefined || row.inline !== undefined || (await ctx.db.get(row.bodyId)),
      'BAD_ARGUMENT',
      'The Item version this decision wrote is in the journal archive; purge the Item instead. Nothing was purged.',
    );
}

/** Every copy of the comment in its purged form. Each step is a fixed point, so a retry changes nothing. */
async function redactComment(ctx: MutationCtx, input: Input, facts?: string) {
  const { db } = ctx;
  const { projectId, commentId, operationId } = input;
  // A retry finds the row already purged (journalRow changes nothing then).
  if (facts !== undefined) await journalRow(ctx, db, projectId, commentId, facts, operationId);
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
  await dropDisplayRows(ctx, projectId, 'comment', commentId);
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

/** Hosted display snapshots (convex/projectHostedProjection.ts) copy record bodies as disposable display rows, read
 * only by recovery export: the comment's (or the derived version's) rows go from every snapshot of the project, one
 * indexed read per snapshot. A fixed point. */
async function dropDisplayRows(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  kind: 'comment' | 'issue',
  key: string,
  version?: number,
) {
  const snapshots = await ctx.db
    .query('projectHostedSnapshots')
    .withIndex('by_project_and_snapshot', q => q.eq('projectId', projectId))
    .take(SNAPSHOT_LIMIT + 1);
  invariant(
    snapshots.length <= SNAPSHOT_LIMIT,
    'WORK_STALE',
    `This project keeps more than ${SNAPSHOT_LIMIT} hosted display snapshots; one purge reaches at most that many.`,
  );
  for (const snapshot of snapshots) {
    const rows = await ctx.db
      .query('projectHostedDisplayRecords')
      .withIndex('by_snapshot_and_kind_and_key_and_version', q => {
        const keyed = q.eq('snapshotId', snapshot._id).eq('kind', kind).eq('key', key);
        return version === undefined ? keyed : keyed.eq('version', version);
      })
      .take(COMMENT_VERSION_LIMIT + 1);
    invariant(
      rows.length <= COMMENT_VERSION_LIMIT,
      'WORK_STALE',
      'A display snapshot keeps more versions of this record than one purge reads.',
    );
    for (const row of rows) await ctx.db.delete(row._id);
  }
}
