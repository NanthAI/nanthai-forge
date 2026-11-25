// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Convex half of a base-checkpoint scrub (Item b6588425 lines 2d, 2e; the action is
// convex/projectCommentPurgeBase.ts), for one purged comment (`commentId`) or a whole purged Item (no `commentId`):
// what the scrub replaces (`plan`), its publication (`publish`: the scrubbed root selected on the backup and every
// replaced object tombstoned in one transaction, so reads of them refuse PURGED from then on) and the end of its R2
// step (`done`). Each is a fixed point, so the action can run again after any failure.
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, internalQuery } from './server';
import { invariant } from '../src/errors';
import { backupRootPin } from '../src/work-backup-root';
import { decisionOperationId } from '../src/work-planning-put';
import { PURGE_ROW_LIMIT, planningCommentCommandSchema } from '../src/work-planning-types';
import { decisionLines } from '../src/work-planning-purge';
import { purgedDecisionRequest } from '../src/work-planning-state';
import { baseEvent, commentRow, purgedHere } from './projectCommentPurge';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { findObject, purgeTargetRow } from './projectObjectFind';
import { splitRecordTable } from './projectWorkRecordTables';
import { purgeRows } from './projectPlanningPurgeRedact';
import { itemIntentPage } from './projectItemIntentPages';

const intentPosition = v.union(
  v.literal('indexed'),
  v.object({ time: v.number(), id: v.string() }),
  v.null(),
);
const baseIntentPage = async (
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  after: 'indexed' | { time: number; id: string } | null,
) => {
  const page = await itemIntentPage(
    ctx,
    projectId,
    itemId,
    after && after !== 'indexed' ? [after.time, after.id] : after,
    64,
  );
  return {
    keys: page.heads.map(head => head.key),
    next: page.next && { time: page.next[0], id: page.next[1] },
  };
};
import { notBusy, tombstoneObject } from './projectSavePurgeStore';

const identity = {
  projectId: v.id('hostedProjects'),
  commentId: v.optional(v.string()),
  operationId: v.string(),
};
const pin = v.object({ sha256: v.string(), size: v.number() });
/** Backup rows the scrub checks (the base must be the only stored one: another would share its record objects); a
 * project with more is refused, never half checked. */
const BACKUP_LIMIT = 64;
type Identity = { projectId: Id<'hostedProjects'>; commentId?: string | undefined; operationId: string };

const entryOf = (project: Doc<'hostedProjects'>, input: Identity) =>
  project.itemPurges?.find(
    item => item.operationId === input.operationId && item.commentId === input.commentId,
  );

/** The project's stored backups other than its base: the scrub rewrites one base, and these could pin the same
 * record objects (a tombstone would break their reads) or hold the words themselves. */
async function assertOnlyBase(ctx: QueryCtx, project: Doc<'hostedProjects'>) {
  const rows = await ctx.db
    .query('projectBackups')
    .withIndex('by_project', q => q.eq('projectId', project._id))
    .take(BACKUP_LIMIT + 1);
  invariant(
    rows.length <= BACKUP_LIMIT &&
      !rows.some(row => row.status === 'stored' && row._id !== project.work?.backupId),
    'BAD_ARGUMENT',
    'This project keeps more than one stored base checkpoint (or too many backup rows to check); the scrub rewrites one. Nothing was purged.',
  );
}

/** What the scrub of this comment replaces in the base: the backup, its owner, and for a decision comment the
 * derived body version's catalog key with the lines and request its scrubbed form takes. Refuses (before anything is
 * written) a base the scrub cannot rewrite. */
export const plan = internalQuery({
  args: { ...identity, itemId: v.string() },
  returns: v.object({
    owner: v.string(),
    backupId: v.id('projectBackups'),
    state: v.union(v.literal('new'), v.literal('publish'), v.literal('delete'), v.literal('done')),
    decision: v.optional(
      v.object({ key: v.string(), marker: v.string(), redacted: v.string(), request: v.string() }),
    ),
  }),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(
      project && !project.removal && project.work,
      'PROJECT_UNAVAILABLE',
      'Select an existing Forge project.',
    );
    const entry = entryOf(project, input);
    const scrub = entry?.baseScrub;
    const state = !entry ? 'new' : !scrub || scrub.done ? 'done' : scrub.pending ? 'delete' : 'publish';
    const backup = await ctx.db.get(scrub?.backupId ?? project.work.backupId);
    invariant(backup, 'PROJECT_UNAVAILABLE', 'The project’s base checkpoint is gone.');
    // Checked before the purge's first step; publish checks again in its own transaction, and an R2 step already
    // recorded resumes whatever was stored since.
    if (state === 'new') {
      invariant(
        backup.status === 'stored' && backup.transport === 'objects',
        'BAD_ARGUMENT',
        'This project’s base checkpoint is a legacy archive, which the scrub cannot rewrite. Nothing was purged.',
      );
      await assertOnlyBase(ctx, project);
    }
    // A whole Item's targets come from the purge entry (itemTargets); only a comment has a decision to rewrite.
    if (input.commentId === undefined) return { owner: project.owner, backupId: backup._id, state } as const;
    const commentId = input.commentId;
    const generation = await selectedGeneration(ctx, project);
    invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
    const partition = recordPartition(generation);
    // The comment's facts: its Work row, else its event in the Work index (whole, or purged by this purge).
    const row = await commentRow(ctx, input.projectId, commentId);
    const event = await baseEvent(ctx, partition, commentId);
    const text = row?.command ?? (row && 'journalCommand' in row ? row.journalCommand : undefined);
    const facts = text
      ? JSON.parse(text)
      : event?.command
        ? JSON.parse(event.command)
        : purgedHere(event, input.operationId)
          ? event!.facts
          : undefined;
    const comment = planningCommentCommandSchema.safeParse(facts);
    const owner = { owner: project.owner, backupId: backup._id, state } as const;
    if (!comment.success || !comment.data.decision) return owner;
    const version = await record(ctx, partition, 'planningVersions', decisionOperationId(commentId));
    const number = version && Number((JSON.parse(version.value) as { version?: unknown }).version);
    if (!number || !Number.isInteger(number)) return owner;
    const lines = decisionLines(comment.data, row?.at ?? event?.at ?? '');
    return {
      ...owner,
      decision: {
        key: JSON.stringify([input.itemId, number]),
        ...lines,
        request: purgedDecisionRequest(row?.request ?? event?.request ?? ''),
      },
    };
  },
});

/** Publish the scrubbed root: refused unless the backup still reads the root the scrub was built from (`previous`;
 * another purge's scrub moved it otherwise, and the action builds again). Selects it on the backup, tombstones every
 * replaced object still stored (the old records and packs, and a cached whole Work of the old root), records their
 * R2 work on the purge entry, and moves the purge revision so a load or export that read the old base refuses to
 * finish. A retry after publication changes nothing. */
export const publish = internalMutation({
  args: {
    ...identity,
    previous: pin,
    root: pin,
    manifestDigest: v.string(),
    originalWork: v.string(),
    replaced: v.array(pin),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project && project.work, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
    const entry = entryOf(project, input);
    invariant(entry?.baseScrub, 'WORK_STALE', 'Run the comment’s purge first.');
    if (entry.baseScrub.pending || entry.baseScrub.done) return null;
    const backup = await ctx.db.get(entry.baseScrub.backupId);
    invariant(
      backup && backup._id === project.work.backupId && backup.status === 'stored',
      'WORK_STALE',
      'The project’s base checkpoint changed during the scrub. Run the purge again.',
    );
    const current = backupRootPin(backup);
    invariant(
      current.sha256 === input.previous.sha256 && current.size === input.previous.size,
      'WORK_STALE',
      'Another purge scrubbed the base meanwhile. Run the purge again to scrub the newer base.',
    );
    await assertOnlyBase(ctx, project);
    // One purge at a time zeroes an upload pack (convex/projectSavePurgeStore.ts).
    await notBusy(ctx, input.projectId, input.operationId);
    const purged = { at: Date.now(), operationId: input.operationId };
    const deletes = new Set<string>(),
      zero: { key: string; offset: number; size: number }[] = [];
    for (const replaced of input.replaced) {
      const row = await purgeTargetRow(ctx, input.projectId, replaced.sha256);
      // Not stored (a whole-Work cache that was never written): nothing holds these bytes. An object stored in chunks
      // (a seed's whole work.json) is a row with no bytes of its own; the action lists its recipe, pages and chunks.
      if (!row) continue;
      const work = await tombstoneObject(ctx, input.projectId, row, purged);
      if (work?.zero) zero.push(work.zero);
      if (work?.delete) deletes.add(work.delete);
    }
    await ctx.db.patch(backup._id, {
      scrubbed: {
        operationId: input.operationId,
        root: input.root,
        manifestDigest: input.manifestDigest,
        originalWork: input.originalWork,
        at: purged.at,
      },
    });
    await patchEntry(ctx, project, input, { ...entry.baseScrub, pending: { deletes: [...deletes], zero } });
    return null;
  },
});

/** The replaced objects that are stored in chunks (a seed's whole work.json): their recipe pins, which the action
 * walks so the recipe, its pages and its chunks are tombstoned with them. */
export const recipes = internalQuery({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()) },
  returns: v.array(v.object({ digest: v.string(), size: v.number(), recipe: pin })),
  handler: async (ctx, input) => {
    const found = [];
    for (const digest of input.digests) {
      // An object another purge already tombstoned refuses PURGED here: nothing is left to list.
      const row = await findObject(ctx, input.projectId, digest).catch((error: { code?: string }) => {
        if (error.code === 'PURGED') return null;
        throw error;
      });
      if (row?.recipe)
        found.push({ digest, size: row.size, recipe: { sha256: row.recipe.digest, size: row.recipe.size } });
    }
    return found;
  },
});

/** A whole Item's scrub targets (line 2e), from its purge entry: the Item's ids, Intent and successor Intents, the
 * Deleted version, every row the purge lists, its comments in the selected Work index (an imported comment has no
 * row) and the decision requests the redaction gives derived versions. Read before the purge finishes. */
export const itemTargets = internalQuery({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.object({
    historyId: v.string(),
    ids: v.array(v.string()),
    intentKeys: v.array(v.string()),
    intentsAfter: intentPosition,
    version: v.number(),
    rows: v.array(v.string()),
    comments: v.array(v.string()),
    decisions: v.array(v.array(v.string())),
  }),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
    const entry = entryOf(project, input);
    invariant(entry?.baseScrub, 'WORK_STALE', 'Run the Item’s purge first.');
    const comments = await itemComments(ctx, project, entry.itemId);
    const membership = entry.intentKeys
      ? { keys: entry.intentKeys, next: null }
      : await baseIntentPage(ctx, input.projectId, entry.itemId, null);
    return {
      historyId: entry.itemId,
      ids: entry.ids,
      intentKeys: [...new Set([...(entry.intentId ? [entry.intentId] : []), ...membership.keys])],
      intentsAfter: membership.next,
      version: entry.version,
      rows: (await purgeRows(ctx, input.projectId, input.operationId)).map(([row]) => row),
      comments: comments.map(row => row.key),
      decisions: entry.decisions,
    };
  },
});
export const itemIntentTargets = internalQuery({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), after: intentPosition },
  returns: v.object({ keys: v.array(v.string()), next: intentPosition }),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    const entry = project && entryOf(project, input);
    invariant(entry?.baseScrub && entry.purgedAt === undefined, 'WORK_STALE', 'Run the Item’s purge first.');
    return baseIntentPage(ctx, input.projectId, entry.itemId, input.after);
  },
});

/** Comments one Item purge scrubs from the base (its rows are capped at PURGE_ROW_LIMIT; imported comments add). */
const COMMENT_LIMIT = 2 * PURGE_ROW_LIMIT;
/** The Item's comments in the selected Work index (an imported comment has no row), refused above COMMENT_LIMIT. */
async function itemComments(ctx: QueryCtx, project: Doc<'hostedProjects'>, itemId: string) {
  const generation = await selectedGeneration(ctx, project);
  invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
  const partition = recordPartition(generation);
  const comments = await ctx.db
    .query(splitRecordTable('planningComments'))
    .withIndex('by_generation_and_collection_and_parent_and_position', q =>
      q.eq('generationId', partition).eq('collection', 'planningComments').eq('parent', itemId),
    )
    .take(COMMENT_LIMIT + 1);
  invariant(
    comments.length <= COMMENT_LIMIT,
    'BAD_ARGUMENT',
    `This Item has more than ${COMMENT_LIMIT} comments; a purge removes at most that many. Nothing was purged.`,
  );
  return comments;
}
/** The comment limit, checked before a whole Item purge's first step writes anything (checkItem). */
export const checkComments = internalQuery({
  args: { projectId: v.id('hostedProjects'), itemId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
    await itemComments(ctx, project, input.itemId);
    return null;
  },
});

/** The exchange roots of the project's other backups (any status): the scrub keeps every recipe part their whole
 * Work still names (convex/projectCommentPurgeBase.ts recipeParts). Bounded like assertOnlyBase. */
export const otherRoots = internalQuery({
  args: { projectId: v.id('hostedProjects'), backupId: v.id('projectBackups') },
  returns: v.array(pin),
  handler: async (ctx, input) => {
    const rows = await ctx.db
      .query('projectBackups')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .take(BACKUP_LIMIT + 1);
    invariant(
      rows.length <= BACKUP_LIMIT,
      'BAD_ARGUMENT',
      'This project keeps too many backup rows to check; the scrub rewrites one base. Nothing was purged.',
    );
    return rows
      .filter(row => row._id !== input.backupId && row.transport === 'objects')
      .map(row => backupRootPin(row));
  },
});

/** The R2 work the publication recorded: whole objects to delete and upload-pack members to zero. */
export const pending = internalQuery({
  args: identity,
  returns: v.object({
    deletes: v.array(v.string()),
    zero: v.array(v.object({ key: v.string(), offset: v.number(), size: v.number() })),
  }),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    const scrub = project && entryOf(project, input)?.baseScrub;
    return scrub?.pending ?? { deletes: [], zero: [] };
  },
});

/** The R2 step is over (or there was nothing to replace): the scrub is done. */
export const done = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
    const entry = entryOf(project, input);
    invariant(entry?.baseScrub, 'WORK_STALE', 'Run the comment’s purge first.');
    if (entry.baseScrub.done) return null;
    await patchEntry(ctx, project, input, { backupId: entry.baseScrub.backupId, done: true });
    return null;
  },
});

async function patchEntry(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  input: Identity,
  baseScrub: NonNullable<NonNullable<Doc<'hostedProjects'>['itemPurges']>[number]['baseScrub']>,
) {
  await ctx.db.patch(project._id, {
    planningPurgeRevision: (project.planningPurgeRevision ?? 0) + 1,
    itemPurges: (project.itemPurges ?? []).map(item =>
      item.operationId === input.operationId && item.commentId === input.commentId
        ? { ...item, baseScrub }
        : item,
    ),
  });
}
