// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One comment's purge (Item b6588425 lines 2b, 2c, 2d): the operator's purge of a reported planning comment. It reuses the
// Item purge's redaction (convex/projectPlanningPurgeRedact.ts) on the stores that hold that one comment, in one
// mutation: a `purge-planning-comment` journal row listing the comment's row with the digest of its redacted facts
// (so every reader accepts the purged row by the one reader rule, convex/projectWorkPurgedRows.ts); the comment's
// journal row; its `events` and `planningComments` records (and payload chunks) on every record partition, and their
// store fingerprints; its work-store versions and head; its rows in hosted display snapshots; and its discussion
// attachments. A decision comment also gets an audited put that replaces its line in the Item body, and its derived
// body version takes the form a rebuild gives it. The Item and every other row stay as they are. A comment row no
// longer enters a journal segment (projectJournalSelect wordsRow, projectJournalWake wordsKinds); one archived before
// that is read by convex/projectCommentPurgeArchive.ts, which passes its command here and rewrites its segment after.
// A comment in the stored base checkpoint runs here with `base` from the same action, which then scrubs the base
// (convex/projectCommentPurgeBase.ts).
// Cost: one comment, a few point reads per record partition (usually one or two) and per display snapshot, one
// journal append (two for a decision) and at most a few dozen small writes; nothing runs while idle and there is no
// cron.
import { v } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import {
  planningCommentCommandSchema,
  planningCommentSchema,
  type PlanningCommentPurge,
} from '../src/work-planning-types';
import { purgedFactsDigest, redactPlanningWrite } from '../src/work-intent-types';
import { decisionOperationId } from '../src/work-planning-put';
import { purgedDecisionRequest } from '../src/work-planning-state';
import { metadataRequest } from '../src/work-metadata';
import { digest } from '../src/state/hash';
import {
  decisionLines,
  decisionVersionValue,
  purgedIndexValue,
  scrubDecision,
  type DecisionLines as Lines,
} from '../src/work-planning-purge';
import { executeCommand } from './projectWorkCommand';
import { clearAuditVersions } from './projectPlanningAuditWindow';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { hostedRecordBody, recordHead } from './projectHostedRecords';
import { journalRow as storedRow } from '../src/work-store-records';
import { removeArtifact } from './artifactStorage';
import { projectPrefix } from './r2Operations';
import { baseRevision } from './projectPlanningPurgeSelect';
import { readArchiveCoverage } from './projectPlanningArchiveCoverage';
import { noStagedMigration } from './projectWorkDetailMigration';
import { indexRecord, indexValue, journalRow, partitionsOf, storeRecord } from './projectPlanningPurgeRedact';

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
  /** The base route (convex/projectCommentPurgeArchive.ts): the comment is in the base checkpoint, which the route
   * scrubs after this step (convex/projectCommentPurgeBase.ts). */
  base?: boolean;
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
    base: v.optional(v.boolean()),
  },
  returns: v.number(),
  handler: (ctx, input) => purgeComment(ctx, input),
});

/** How the comment's purge runs: `live` in one mutation (purgeComment), `archived` (its row's command is in the
 * journal archive) or `base` (its words are in the stored base checkpoint) through
 * convex/projectCommentPurgeArchive.ts. */
export async function commentRoute(
  ctx: MutationCtx | QueryCtx,
  projectId: Id<'hostedProjects'>,
  commentId: string,
) {
  const project = await ctx.db.get(projectId);
  const generation = project && (await selectedGeneration(ctx, project));
  const row = await commentRow(ctx, projectId, commentId);
  if (project && generation && inBase(project, generation, row) && row?.purged === undefined)
    return 'base' as const;
  return row && 'journalSegment' in row && row.journalSegment && row.purged === undefined
    ? ('archived' as const)
    : ('live' as const);
}

/** Whether the comment's words are in the stored base: no Work row of its own, or one at or before the base. */
export function inBase(
  project: Doc<'hostedProjects'>,
  generation: { initialRevision: number },
  row: Awaited<ReturnType<typeof commentRow>>,
) {
  return (
    !row ||
    row.revision === undefined ||
    row.request === undefined ||
    row.revision <= baseRevision(project, generation)
  );
}

/** A base comment's event as the selected Work index holds it (the base has no Work row for it): its command, or the
 * purge that already replaced it. A comment written before hosted Work (imported with the base) has no event: its
 * command is the one its comment record replays from, and its purged form says an earlier purge removed it. */
export async function baseEvent(
  ctx: QueryCtx | MutationCtx,
  partition: Id<'projectWorkGenerations'>,
  commentId: string,
) {
  const root = await record(ctx, partition, 'events', commentId);
  if (!root) return importedComment(ctx, partition, commentId);
  const { full } = await indexValue(ctx, partition, 'events', root);
  const command = full.command as
    | { action?: string; purgeOperationId?: string; command?: unknown }
    | undefined;
  const purged = command?.action === 'purged-planning-row';
  return {
    command: purged ? undefined : JSON.stringify(command),
    purgedBy: purged ? command!.purgeOperationId : undefined,
    /** The purged form's facts (the comment's redacted command). */
    facts: purged ? command!.command : undefined,
    at: typeof full.at === 'string' ? full.at : '',
    request: typeof full.request === 'string' ? full.request : '',
  };
}

async function importedComment(
  ctx: QueryCtx | MutationCtx,
  partition: Id<'projectWorkGenerations'>,
  commentId: string,
) {
  const root = await record(ctx, partition, 'planningComments', commentId);
  if (!root) return undefined;
  const { full } = await indexValue(ctx, partition, 'planningComments', root);
  const comment = planningCommentSchema.safeParse(full);
  if (!comment.success) return undefined;
  const at = comment.data.at,
    request = comment.data.request;
  const command = {
    action: 'comment-planning-item' as const,
    operationId: comment.data.id,
    itemId: comment.data.itemId,
    authorLabel: comment.data.authorLabel,
    text: comment.data.text,
    ...(comment.data.replyTo ? { replyTo: comment.data.replyTo } : {}),
    ...(comment.data.decision ? { decision: true } : {}),
  };
  // The purged form (src/work-planning-purge.ts purgedIndexValue): its words are already gone, by a purge the record
  // does not name (IMPORTED_PURGE).
  if (comment.data.text === 'Deleted comment' && comment.data.authorLabel === '')
    return { command: undefined, purgedBy: IMPORTED_PURGE, facts: redactPlanningWrite(command), at, request };
  return { command: JSON.stringify(command), purgedBy: undefined, facts: undefined, at, request };
}
/** baseEvent's `purgedBy` for a purged comment that has no event: its record does not name the purge. */
export const IMPORTED_PURGE = '';
/** The base comment's event was purged by this purge (or, with no event, by one the record cannot name). */
export const purgedHere = (event: { purgedBy?: string | undefined } | undefined, operationId: string) =>
  event?.purgedBy === operationId || event?.purgedBy === IMPORTED_PURGE;

/** The comment's live journal row. */
export async function commentRow(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  commentId: string,
) {
  return await ctx.db
    .query('projectHostedRecordBodies')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', commentId))
    .unique();
}

/** Purge one planning comment. Returns 1 when this purge removed it (also on a retry with the same operationId), 0
 * when an earlier purge (its Item's, or another comment purge) already did. A decision comment's line in the Item
 * body is replaced by an audited put, and its derived body version takes the form a rebuild gives it. A row in the
 * journal archive needs its command from the segment (`archived`); the purge then registers the segment rewrite.
 * A comment in the base checkpoint runs only with `base` (its words are in the stored base, which the action scrubs
 * next: line 2d), one base scrub per project at a time. Refuses, with nothing written, a Work index being built (it
 * may copy the words again). */
export async function purgeComment(ctx: MutationCtx, input: Input): Promise<0 | 1> {
  const project = await ctx.db.get(input.projectId);
  invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
  const generation = await selectedGeneration(ctx, project);
  invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
  const missing = 'No comment with that id on that Item.';
  invariant(
    (await recordHead(ctx, input.projectId, 'comment', input.commentId))?.parent === input.itemId,
    'NOT_FOUND',
    missing,
  );
  const row = await commentRow(ctx, input.projectId, input.commentId);
  const base = inBase(project, generation, row);
  invariant(
    !base || input.base,
    'BAD_ARGUMENT',
    'This comment is in the base checkpoint: its purge also scrubs the stored base (projectCommentPurgeArchive:run, which an abuse review starts). Nothing was purged.',
  );
  if (row?.purged !== undefined && row.purged !== input.operationId) return 0;
  const archived = !!(row && 'journalSegment' in row && row.journalSegment);
  // An archived row is purged in its segment later; its live steps all ran in the first call.
  const begun = project.itemPurges?.some(
    purge => purge.operationId === input.operationId && purge.commentId === input.commentId,
  );
  if (row?.purged === input.operationId || begun) {
    await redactComment(ctx, input);
    return 1;
  }
  const event = base ? await baseEvent(ctx, recordPartition(generation), input.commentId) : undefined;
  // An earlier purge (its Item's, or another of this comment) already replaced the base comment's event.
  if (event?.purgedBy !== undefined) return 0;
  if (base) {
    invariant(project.work, 'PROJECT_WORK_MISSING', 'Start hosted Work from a stored source backup.');
    // One base scrub at a time: a scrub built over a base another one is replacing would keep that one's words.
    invariant(
      !project.itemPurges?.some(
        purge => purge.baseScrub && !purge.baseScrub.done && purge.operationId !== input.operationId,
      ),
      'WORK_STALE',
      'Another purge is scrubbing the base checkpoint; this one runs after it. Nothing was purged.',
    );
    invariant(
      project.work.recordDetails?.backupId !== project.work.backupId,
      'BAD_ARGUMENT',
      'This project reads its base through a migrated record-detail catalog, which the base scrub does not rewrite yet. Nothing was purged.',
    );
  }
  const text = archived ? input.archived : (row?.command ?? event?.command);
  invariant(
    text !== undefined,
    'BAD_ARGUMENT',
    'This comment’s Work row is in the journal archive; its purge reads it there first (projectCommentPurgeArchive:run). Nothing was purged.',
  );
  const parsed = planningCommentCommandSchema.safeParse(JSON.parse(text));
  invariant(parsed.success && parsed.data.operationId === input.commentId, 'NOT_FOUND', missing);
  invariant(
    !archived || metadataRequest(parsed.data) === row!.request,
    'INVALID_WORK_JOURNAL',
    'The archived comment differs from its Work row. Nothing was purged.',
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
  // A detail migration writing a new base copies the comment whole (convex/projectWorkDetailMigration.ts).
  await noStagedMigration(ctx, input.projectId);
  const partitions = await partitionsOf(ctx, input.projectId);
  // The earlier planning split may have left a copy of the comment in the core table.
  for (const partition of partitions) {
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
      'An old copy of this comment is still in the core Work table. Retire it, then retry the purge. Nothing was purged.',
    );
  }
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
  const decision = parsed.data.decision ? decisionLines(parsed.data, row?.at ?? event?.at ?? '') : undefined;
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
  // A base comment with no Work row of its own has no journal row to redact.
  await redactComment(ctx, input, row && (row.command !== undefined || archived) ? facts : undefined);
  const request = row?.request ?? event?.request ?? '';
  if (decision) await decisionVersion(ctx, input, decision, purgedDecisionRequest(request));
  // A Work load or export that started before this purge refuses to finish over it (convex/projectWorkLoad.ts).
  const current = (await ctx.db.get(input.projectId))!;
  await ctx.db.patch(input.projectId, {
    planningPurgeRevision: (current.planningPurgeRevision ?? 0) + 1,
    // The archived row's segment rewrite runs as this purge's segment sweep (convex/projectCommentPurgeArchive.ts).
    ...(archived || base
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
              ...(archived
                ? {
                    segmentSweep: {
                      after: null,
                      done: false,
                      ...((await readArchiveCoverage(ctx, current)).state.ready
                        ? { indexed: true as const }
                        : {}),
                    },
                  }
                : {}),
              // The stored base is scrubbed next (convex/projectCommentPurgeBase.ts); the purge is open until then.
              ...(base ? { baseScrub: { backupId: project.work!.backupId, done: false } } : {}),
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
  const project = (await ctx.db.get(input.projectId))!;
  let facts: Comment, at: string, request: string;
  if (row?.purged === input.operationId && row.request) {
    facts = JSON.parse(('journalCommand' in row && row.journalCommand) || row.command || '{}') as Comment;
    at = row.at ?? '';
    request = row.request;
  } else {
    // A base comment with no Work row of its own: its event in the Work index, which the first step purged.
    const generation = await selectedGeneration(ctx, project);
    invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
    const event = await baseEvent(ctx, recordPartition(generation), input.commentId);
    invariant(
      purgedHere(event, input.operationId) && event?.facts,
      'WORK_STALE',
      'The comment’s row is not purged yet.',
    );
    facts = event!.facts as Comment;
    at = event!.at;
    request = event!.request;
  }
  if (facts.decision)
    await decisionVersion(ctx, input, decisionLines(facts, at), purgedDecisionRequest(request));
  await ctx.db.patch(input.projectId, { planningPurgeRevision: (project.planningPurgeRevision ?? 0) + 1 });
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
  await clearAuditVersions(ctx, input.projectId, input.itemId);
  const key = decisionOperationId(input.commentId);
  const rewrite = (value: unknown) => decisionVersionValue(value, lines, request);
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
