// SPDX-License-Identifier: Apache-2.0
// Purge executor, redaction half (Item 4c9e961e, purge Lane 2). Paged and idempotent: each step rewrites one bounded
// page of one store into its purged form, and the same code with `apply` false is the completeness check (it counts
// what a step would still change). Stores, in order (the Item purge inventory, `planningPurgeStores`):
// journal rows, the Work index (events, versions, comments, notes, lifecycle, Intent, search root), the work store
// (issue, comment, lifecycle and Intent versions, their bodies and heads), the store fingerprints and discussion artifacts.
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { invariant } from '../src/errors';
import {
  purgeableCommandSchema,
  purgedFactsDigest,
  purgedFactsText,
  redactPlanningWrite,
} from '../src/work-intent-types';
import { purgedIndexValue, purgedIntentKeys, purgedIntentRecord } from '../src/work-planning-purge';
import { hostedRecordIndex, hostedRecordValue } from '../src/hosted-records';
import { PURGED_ITEM_TITLE } from '../src/work-planning-types';
import { indexedRecord } from '../src/work-hosted-index';
import { splitRecordTable } from './projectWorkRecordTables';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { hostedRecordBody, recordHead, recordVersion } from './projectHostedRecords';
import { fingerprintHostedIntent } from './projectWorkStoreFingerprintWrites';
import { purgeLifecyclePlans } from './projectPlanningPurgeLifecycle';
import { purgeIntentChain } from './projectPlanningPurgeSelect';
import { removeArtifact } from './artifactStorage';
import { projectPrefix } from './r2Operations';

/** Every store an Item purge redacts, and how. The end-to-end test (tests/planning-purge-executor.test.mjs) searches
 * every table for the purged words, so a new store that keeps them fails the build. */
export const planningPurgeStores = {
  projectWorkEvents: 'journal row: redacted facts in `command`, `purged` marker',
  projectJournalSegments:
    'replace the verified object for each affected segment and delete the original and its fragments',
  projectHostedRecordBodies:
    'journal row: facts in `journalCommand`, no `command`, `purged`; record body emptied',
  projectHostedRecords:
    "issue, comment and lifecycle versions: `purged` marker, no `inline`; the Item's Intent and its successors: a new 'Deleted Item' version (head), every older version purged",
  projectHostedRecordHeads:
    "comment, note and lifecycle heads: inline value in its purged form; Intent heads: the 'Deleted Item' version",
  projectPlanningRecords:
    'versions, comments, Item root and search row on every record partition: purged form (the selected root is the tombstone)',
  projectWorkRecords:
    'events, notes, lifecycle, Intent, Initiative root: purged form; store fingerprints of the Item deleted',
  projectWorkDataRecords: 'payload chunks of the above: rewritten from the purged value, stale ones deleted',
  projectHostedLifecyclePlans:
    'redacted reason in the canonical lifecycle request; original operation hash retained',
  projectHostedLifecycleEvents: 'redacted reason in the plan event and its cascaded child events',
  projectHostedOverlapLanes:
    "overlap rows of the Lanes on the Item's Intents: the outcome copy reads 'Deleted Item'",
  artifactBlobs: 'tombstone discussion bindings under the Item namespace and schedule artifact byte cleanup',
} as const;

export type ItemPurge = NonNullable<Doc<'hostedProjects'>['itemPurges']>[number];
type Ctx = QueryCtx | MutationCtx;
export const PURGE_PAGE = 32;
/** Index collections keyed by parent: [collection, which id is the parent]. */
const parentSteps = [
  ['planningVersions', 'history'],
  ['planningComments', 'history'],
  ['notes', 'intent'],
  ['lifecycle', 'intent'],
] as const;
export const purgeSteps = [
  'journal',
  'events',
  ...parentSteps.map(([collection]) => collection),
  'intents',
  'roots',
  'payloads',
  'storeIssues',
  'storeComments',
  'storeNotes',
  'storeLifecycle',
  'storeIntents',
  'lifecyclePlans',
  'overlapLanes',
  'storeHeads',
] as const;
export type PurgeStep = (typeof purgeSteps)[number];
export const fingerprint = (collection: string) => `_workStoreDigests:${collection}`;

/** The purge's command: its row list in journal order. */
export async function purgeRows(ctx: Ctx, projectId: Id<'hostedProjects'>, operationId: string) {
  const row =
    (await byOperation(ctx, 'projectWorkEvents', projectId, operationId)) ??
    (await byOperation(ctx, 'projectHostedRecordBodies', projectId, operationId));
  invariant(row?.command, 'NOT_FOUND', 'The purge has not been recorded yet.');
  return (JSON.parse(row.command) as { rows: [string, string][] }).rows;
}
/** The journal revision of the purge's own row: rows of the Item after it were written after the first step. */
export async function purgeRevision(ctx: Ctx, projectId: Id<'hostedProjects'>, operationId: string) {
  const row =
    (await byOperation(ctx, 'projectWorkEvents', projectId, operationId)) ??
    (await byOperation(ctx, 'projectHostedRecordBodies', projectId, operationId));
  invariant(row?.revision !== undefined, 'NOT_FOUND', 'The purge has not been recorded yet.');
  return row.revision;
}
async function byOperation(
  ctx: Ctx,
  table: 'projectWorkEvents' | 'projectHostedRecordBodies',
  projectId: Id<'hostedProjects'>,
  operationId: string,
): Promise<Doc<'projectWorkEvents'> | Doc<'projectHostedRecordBodies'> | null> {
  return table === 'projectWorkEvents'
    ? ctx.db
        .query('projectWorkEvents')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', projectId).eq('operationId', operationId),
        )
        .unique()
    : ctx.db
        .query('projectHostedRecordBodies')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', projectId).eq('operationId', operationId),
        )
        .unique();
}

/** One page of one step. Returns the changes made (or, with `apply` false, still needed) and the next cursor
 * (null when the step is done). */
export async function purgeStep(
  ctx: Ctx,
  input: { projectId: Id<'hostedProjects'>; purge: ItemPurge; step: PurgeStep; after: string | null },
  apply: boolean,
) {
  if (!indexSteps.has(input.step)) return pageOf(ctx, input, apply, undefined);
  // Index steps run on every record partition the project still has: the selected one, any a rebuild retired but has
  // not swept yet, one kept for Intent migration and an unfinished build. Cursor: "<partition id>/<step cursor>", so
  // a partition created or retired between pages shifts nothing: a vanished partition's rows are gone, and the walk
  // goes on with the next id.
  const partitions = await partitionsOf(ctx, input.projectId);
  const id = input.after === null ? '' : input.after.slice(0, input.after.indexOf('/'));
  const inner = input.after === null ? null : input.after.slice(input.after.indexOf('/') + 1) || null;
  const at = partitions.findIndex(partition => (inner === null ? partition > id : partition >= id));
  const partition = partitions[at];
  if (partition === undefined) return { changes: 0, after: null };
  const page = await pageOf(ctx, { ...input, after: partition === id ? inner : null }, apply, partition);
  return {
    changes: page.changes,
    after:
      page.after !== null
        ? `${partition}/${page.after}`
        : at + 1 < partitions.length
          ? `${partition}/`
          : null,
  };
}
const indexSteps = new Set<PurgeStep>([
  'events',
  'planningVersions',
  'planningComments',
  'notes',
  'lifecycle',
  'intents',
  'roots',
  'payloads',
]);

async function pageOf(
  ctx: Ctx,
  input: { projectId: Id<'hostedProjects'>; purge: ItemPurge; step: PurgeStep; after: string | null },
  apply: boolean,
  partition: Id<'projectWorkGenerations'> | undefined,
): Promise<{ changes: number; after: string | null }> {
  const write = apply ? (ctx as MutationCtx).db : undefined;
  const { purge } = input;
  const decisions = new Map(purge.decisions as [string, string][]);
  let changes = 0;
  if (input.step === 'journal' || input.step === 'events') {
    const rows = await purgeRows(ctx, input.projectId, purge.operationId);
    const start = Number(input.after ?? 0),
      page = rows.slice(start, start + PURGE_PAGE);
    for (const [operationId, expected] of page)
      changes +=
        input.step === 'events' && partition
          ? await indexRecord(ctx, write, partition, 'events', operationId, purge.operationId, decisions)
          : await journalRow(ctx, write, input.projectId, operationId, expected, purge.operationId, {
              base: !!purge.baseScrub,
            });
    return { changes, after: start + PURGE_PAGE < rows.length ? String(start + PURGE_PAGE) : null };
  }
  if (input.step === 'intents') {
    if (purge.intentId && partition) {
      changes += await indexRecord(
        ctx,
        write,
        partition,
        'intents',
        purge.intentId,
        purge.operationId,
        decisions,
      );
      changes += await dropFingerprint(ctx, write, partition, fingerprint('intents'), purge.intentId);
    }
    return { changes, after: null };
  }
  if (input.step === 'roots') {
    // The Item's latest version, Initiative record and search row: on the selected partition the tombstone already
    // replaced them (unchanged here); a retired or kept partition still holds the Deleted version's words.
    if (partition) {
      for (const collection of ['planningItems', 'initiatives'])
        changes += await indexRecord(
          ctx,
          write,
          partition,
          collection,
          purge.itemId,
          purge.operationId,
          decisions,
        );
      changes += await searchRow(ctx, write, partition, purge.itemId);
    }
    return { changes, after: null };
  }
  if (input.step === 'payloads') return stalePayloads(ctx, write, partition!, purge, input.after);
  if (input.step === 'storeHeads') {
    const { projectId, after } = input;
    if (after?.startsWith(discussionCursor))
      return discussionArtifacts(ctx, apply, projectId, purge.itemId, after.slice(discussionCursor.length));
    const heads = await storeHeads(ctx, write, projectId, purge, after);
    if (heads.after !== null) return heads;
    // Share the last heads transaction with the first artifact page, including the common empty range.
    const artifacts = await discussionArtifacts(ctx, apply, projectId, purge.itemId, null);
    return { changes: heads.changes + artifacts.changes, after: artifacts.after };
  }
  if (input.step === 'lifecyclePlans') {
    const project = await ctx.db.get(input.projectId);
    const generation = project && (await selectedGeneration(ctx, project));
    invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
    const keys =
      purge.intentKeys ??
      (await purgeIntentChain(ctx, input.projectId, purge.itemId, recordPartition(generation)));
    return purgeLifecyclePlans(ctx, write, input.projectId, keys, input.after);
  }
  if (input.step === 'storeIntents') return storeIntents(ctx, write, input.projectId, purge, input.after);
  if (input.step === 'overlapLanes') return overlapLanes(ctx, write, input.projectId, purge, input.after);
  const parentStep = parentSteps.find(([collection]) => collection === input.step);
  if (parentStep) {
    const [collection, which] = parentStep;
    const parent = which === 'history' ? purge.itemId : purge.intentId;
    if (!parent || !partition) return { changes, after: null };
    const page = await ctx.db
      .query(splitRecordTable(collection))
      .withIndex('by_generation_and_collection_and_parent_and_position', q => {
        const scoped = q.eq('generationId', partition).eq('collection', collection).eq('parent', parent);
        return input.after === null ? scoped : scoped.gt('position', Number(input.after));
      })
      .take(PURGE_PAGE);
    for (const row of page) {
      changes += await indexRecord(
        ctx,
        write,
        partition,
        collection,
        row.key,
        purge.operationId,
        decisions,
        row,
      );
      changes += await dropFingerprint(ctx, write, partition, fingerprint(collection), row.key);
    }
    return { changes, after: page.length === PURGE_PAGE ? String(page.at(-1)!.position) : null };
  }
  // The work store: issue versions by key, comment, note and lifecycle versions by parent.
  const [kind, field, key] =
    input.step === 'storeIssues'
      ? (['issue', 'key', purge.itemId] as const)
      : input.step === 'storeComments'
        ? (['comment', 'parent', purge.itemId] as const)
        : input.step === 'storeLifecycle'
          ? (['lifecycle', 'parent', purge.intentId] as const)
          : (['comment', 'parent', purge.intentId] as const);
  if (!key || (input.step === 'storeNotes' && key === purge.itemId)) return { changes, after: null };
  // Paged with the index's own cursor: several versions can share a key's version (one per lifecycle plan) or a
  // creation time, so a value cursor could skip rows at a page boundary.
  const records = ctx.db.query('projectHostedRecords');
  const page = await (
    field === 'key'
      ? records.withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
          q.eq('projectId', input.projectId).eq('kind', kind).eq('key', key),
        )
      : records.withIndex('by_project_and_kind_and_parent', q =>
          q.eq('projectId', input.projectId).eq('kind', kind).eq('parent', key),
        )
  ).paginate({ cursor: input.after, numItems: PURGE_PAGE });
  for (const row of page.page) changes += await storeRecord(ctx, write, row, purge);
  return { changes, after: page.isDone ? null : page.continueCursor };
}

/** The project's record partitions, by id. A project keeps a few generations (a rebuild retires the old one until its
 * sweep; one may be kept for Intent migration), so this is one small bounded read. */
export async function partitionsOf(ctx: Ctx, projectId: Id<'hostedProjects'>) {
  const project = await ctx.db.get(projectId);
  const generation = project && (await selectedGeneration(ctx, project));
  invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
  const all = await ctx.db
    .query('projectWorkGenerations')
    .withIndex('by_project_and_backup_and_revision_and_format', q => q.eq('projectId', projectId))
    .take(65);
  invariant(
    all.length <= 64,
    'WORK_STALE',
    'This project keeps more than 64 Work index generations; sweep them first.',
  );
  return [...new Set([recordPartition(generation), ...all.map(recordPartition)])].sort();
}

/** A journal row in its purged form. The facts written must hash to the digest the purge listed. */
export async function journalRow(
  ctx: Ctx,
  write: MutationCtx['db'] | undefined,
  projectId: Id<'hostedProjects'>,
  operationId: string,
  expected: string,
  purgeOperationId: string,
  /** A base Item's purge also lists rows only the stored base holds (no Work row); the base scrub replaces those. */
  options: { base?: boolean } = {},
) {
  const event = await byOperation(ctx, 'projectWorkEvents', projectId, operationId);
  const body = event ? null : await byOperation(ctx, 'projectHostedRecordBodies', projectId, operationId);
  const row = event ?? body;
  if (!row && options.base) return 0;
  invariant(row, 'INVALID_WORK_JOURNAL', 'A row the purge lists is missing from the Work journal.');
  if (row.purged !== undefined) return 0;
  // The segment action publishes the redacted event and the live retry envelope together.
  if ('journalSegment' in row && row.journalSegment) return 1;
  invariant(row.command !== undefined, 'INVALID_WORK_JOURNAL', 'A listed Work row has no command.');
  const facts = redactPlanningWrite(purgeableCommandSchema.parse(JSON.parse(row.command)));
  invariant(
    purgedFactsDigest(facts) === expected,
    'INVALID_WORK_JOURNAL',
    'A listed row changed after the purge.',
  );
  if (!write) return 1;
  if (event) await write.patch(event._id, { command: purgedFactsText(facts), purged: purgeOperationId });
  else
    await write.patch(body!._id, {
      command: undefined,
      journalCommand: purgedFactsText(facts),
      purged: purgeOperationId,
      // An Intent row's body can hold its Intent record version: the storeIntents step purges that version.
      value: '',
    });
  return 1;
}

/** One index record's header, its payload chunks and the whole value they encode. */
export async function indexValue(
  ctx: Ctx,
  partition: Id<'projectWorkGenerations'>,
  collection: string,
  root: { value: string },
) {
  const header = JSON.parse(root.value) as Record<string, unknown>;
  const chunks = header.payloadKey
    ? await ctx.db
        .query(splitRecordTable(`${collection}:payload`))
        .withIndex('by_generation_and_collection_and_parent_and_position', q =>
          q
            .eq('generationId', partition)
            .eq('collection', `${collection}:payload`)
            .eq('parent', String(header.payloadKey)),
        )
        .take(Number(header.payloadParts ?? 0) + 1)
    : [];
  const full = (chunks.length ? JSON.parse(chunks.map(chunk => chunk.value).join('')) : header) as Record<
    string,
    unknown
  >;
  return { header, chunks, full };
}

/** One index record (and its payload chunks) in its purged form. */
export async function indexRecord(
  ctx: Ctx,
  write: MutationCtx['db'] | undefined,
  partition: Id<'projectWorkGenerations'>,
  collection: string,
  key: string,
  purgeOperationId: string,
  decisions: ReadonlyMap<string, string>,
  known?: Doc<'projectWorkRecords'> | Doc<'projectPlanningRecords'> | Doc<'projectWorkDataRecords'>,
  /** Another fixed-point rewrite in place of the purged form (a decision comment's derived body version). */
  transform: (value: unknown) => unknown = value =>
    purgedIndexValue(collection, value, purgeOperationId, decisions),
) {
  const root = known ?? (await record(ctx, partition, collection, key));
  if (!root) return 0;
  const { header, chunks, full } = await indexValue(ctx, partition, collection, root);
  const purgedFull = transform(full);
  const purgedHeader = transform(header);
  if (
    JSON.stringify(purgedFull) === JSON.stringify(full) &&
    JSON.stringify(purgedHeader) === JSON.stringify(header)
  )
    return 0;
  if (!write) return 1;
  for (const chunk of chunks) await write.delete(chunk._id);
  if (!chunks.length) {
    await write.patch(root._id, { value: JSON.stringify(purgedHeader) });
    return 1;
  }
  // Re-encode: the purged value is smaller, usually small enough to need no payload at all.
  const summary = { ...(purgedHeader as Record<string, unknown>) };
  delete summary.payloadKey;
  delete summary.payloadParts;
  const [entry, ...parts] = indexedRecord(collection, key, root.parent, root.position, purgedFull, summary);
  await write.patch(root._id, { value: entry!.value });
  // indexedRecord also returns a planning root's search entries; the search row has its own step.
  for (const part of parts.filter(part => part.collection === `${collection}:payload`))
    await write.insert(splitRecordTable(part.collection), {
      ...part,
      projectId: root.projectId,
      generationId: partition,
    });
  return 1;
}

/** Payload chunks an earlier value of the Item's root, search row or Intent left behind (a rewrite writes new chunks
 * under a new content key): every chunk keyed by the Item's id that its current root does not name goes. */
async function stalePayloads(
  ctx: Ctx,
  write: MutationCtx['db'] | undefined,
  partition: Id<'projectWorkGenerations'>,
  purge: ItemPurge,
  after: string | null,
) {
  const targets = [
    ['planningItems', purge.itemId],
    ['planningSearch', purge.itemId],
    ['initiatives', purge.itemId],
    ...(purge.intentId ? [['intents', purge.intentId]] : []),
  ] as const;
  // Cursor: "<target index>|<last key>".
  const at = after === null ? 0 : Number(after.split('|')[0]),
    last = after === null ? '' : after.slice(after.indexOf('|') + 1);
  const [collection, id] = targets[at]!;
  const root = await record(ctx, partition, collection, id);
  const current = root ? (JSON.parse(root.value) as { payloadKey?: string }).payloadKey : undefined;
  const payload = `${collection}:payload`;
  const page = await ctx.db
    .query(splitRecordTable(payload))
    .withIndex('by_generation_and_collection_and_key', q =>
      q
        .eq('generationId', partition)
        .eq('collection', payload)
        .gt('key', last || `${id}:`)
        .lt('key', `${id};`),
    )
    .take(PURGE_PAGE);
  let changes = 0;
  for (const chunk of page)
    if (chunk.parent !== current) {
      changes++;
      if (write) await write.delete(chunk._id);
    }
  const next =
    page.length === PURGE_PAGE ? `${at}|${page.at(-1)!.key}` : at + 1 < targets.length ? `${at + 1}|` : null;
  return { changes, after: next };
}

export async function dropFingerprint(
  ctx: Ctx,
  write: MutationCtx['db'] | undefined,
  partition: Id<'projectWorkGenerations'>,
  collection: string,
  key: string,
) {
  const row = await record(ctx, partition, collection, key);
  if (!row) return 0;
  if (write) await write.delete(row._id);
  return 1;
}

/** A work-store version of the Item: marked purged (header and digest stay), its body emptied. The tombstone
 * version and the Item's other kinds are left alone. A comment's purge passes no version. */
export async function storeRecord(
  ctx: Ctx,
  write: MutationCtx['db'] | undefined,
  row: Doc<'projectHostedRecords'>,
  purge: Pick<ItemPurge, 'operationId'> & { version?: number },
) {
  if (row.kind === 'issue' && purge.version !== undefined && row.version === purge.version + 1) return 0;
  // A journal row's body is redacted by the journal step (it keeps its envelope); a plain body is emptied here, once
  // every version that shares it is purged (the last one empties it, and the check finds one left non-empty).
  const body = await ctx.db.get(row.bodyId);
  const plain = body && body.operationId === undefined && body.value !== '' ? body : null;
  if (row.purged !== undefined && !plain) return 0;
  let emptied = false;
  if (plain) {
    const owners = await ctx.db
      .query('projectHostedRecords')
      .withIndex('by_project_and_body', q => q.eq('projectId', row.projectId).eq('bodyId', row.bodyId))
      .take(BODY_OWNER_LIMIT + 1);
    invariant(
      owners.length <= BODY_OWNER_LIMIT,
      'WORK_STALE',
      'A version of this Item shares its body with too many records to check.',
    );
    emptied = owners.every(owner => owner._id === row._id || owner.purged !== undefined);
  }
  if (row.purged !== undefined && !emptied) return 0;
  if (!write) return 1;
  if (row.purged === undefined)
    await write.patch(row._id, {
      purged: purge.operationId,
      inline: undefined,
      journalReady: undefined,
      journalReadyAt: undefined,
    });
  if (emptied) await write.patch(plain!._id, { value: '' });
  return 1;
}
const BODY_OWNER_LIMIT = 16;

/** The work store's versions of the Item's Intent and of each successor Intent a later start continued it on (they
 * copy its outcome): the head becomes a new 'Deleted Item' version (purgedIntentRecord) and every older version is
 * purged (marker, no inline, body emptied), journal copies and Lane-pinned versions alike. One page of one Intent;
 * the chain ends at the first id with no record. Cursor: "<chain index>|<index cursor>". */
async function storeIntents(
  ctx: Ctx,
  write: MutationCtx['db'] | undefined,
  projectId: Id<'hostedProjects'>,
  purge: ItemPurge,
  after: string | null,
) {
  const at = after === null ? 0 : Number(after.split('|')[0]),
    cursor = after === null ? null : after.slice(after.indexOf('|') + 1) || null;
  const { key, keys } = await chainKey(ctx, projectId, purge, at);
  let head = key === null ? null : await recordHead(ctx, projectId, 'intent', key);
  if (!head || key === null) return { changes: 0, after: null };
  let changes = 0;
  if (cursor === null) {
    const deleted = await deletedIntentVersion(ctx, write, projectId, purge, head);
    changes += deleted;
    if (deleted && write) head = (await recordHead(ctx, projectId, 'intent', key))!;
  }
  const page = await ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
      q.eq('projectId', projectId).eq('kind', 'intent').eq('key', key),
    )
    .paginate({ cursor, numItems: PURGE_PAGE });
  for (const row of page.page)
    if (row._id !== head.recordId) changes += await storeRecord(ctx, write, row, purge);
  return {
    changes,
    after: !page.isDone ? `${at}|${page.continueCursor}` : at + 1 < keys.length ? `${at + 1}|` : null,
  };
}

/** The chain's Intent id at `at`, or null where the chain ends: a successor id that names a planning Item of its own
 * (an Issue someone created under that id) is that Issue's, never this one's. One indexed read per successor. */
async function chainKey(ctx: Ctx, projectId: Id<'hostedProjects'>, purge: ItemPurge, at: number) {
  const keys = purgedIntentKeys(purge.itemId),
    key = keys[at]!;
  if (at === 0) return { key, keys };
  const project = await ctx.db.get(projectId);
  const generation = project && (await selectedGeneration(ctx, project));
  invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
  const own = await record(ctx, recordPartition(generation), 'planningItems', key);
  return { key: own ? null : key, keys };
}

/** Each Lane on the Item's Intents keeps the Intent's outcome (cut to 160 characters) on its overlap row, for overlap
 * and presence notices (convex/projectHostedOverlapStore.ts): it takes the 'Deleted Item' form. One page of Lane
 * heads of one chain Intent. Cursor: "<chain index>|<index cursor>". */
async function overlapLanes(
  ctx: Ctx,
  write: MutationCtx['db'] | undefined,
  projectId: Id<'hostedProjects'>,
  purge: ItemPurge,
  after: string | null,
) {
  const at = after === null ? 0 : Number(after.split('|')[0]),
    cursor = after === null ? null : after.slice(after.indexOf('|') + 1) || null;
  const { key, keys } = await chainKey(ctx, projectId, purge, at);
  if (key === null || !(await recordHead(ctx, projectId, 'intent', key))) return { changes: 0, after: null };
  const page = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_parent', q =>
      q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', key),
    )
    .paginate({ cursor, numItems: PURGE_PAGE });
  let changes = 0;
  for (const lane of page.page) {
    const row = await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.key))
      .unique();
    if (!row || row.intent === PURGED_ITEM_TITLE) continue;
    changes++;
    if (write) await write.patch(row._id, { intent: PURGED_ITEM_TITLE });
  }
  return {
    changes,
    after: !page.isDone ? `${at}|${page.continueCursor}` : at + 1 < keys.length ? `${at + 1}|` : null,
  };
}

/** Write the head's 'Deleted Item' version unless the head already is one (1 when it was, or would be, written). */
async function deletedIntentVersion(
  ctx: Ctx,
  write: MutationCtx['db'] | undefined,
  projectId: Id<'hostedProjects'>,
  purge: ItemPurge,
  head: Doc<'projectHostedRecordHeads'>,
) {
  const row = await ctx.db.get(head.recordId);
  invariant(row && row.purged === undefined, 'SOURCE_UNAVAILABLE', 'The Intent head version is unavailable.');
  const stored = JSON.parse(await hostedRecordBody(ctx, row)) as Record<string, unknown>;
  const decisions = new Map(purge.decisions as [string, string][]);
  const purged = purgedIntentRecord(stored, purge.operationId, decisions);
  if (JSON.stringify(purged) === JSON.stringify(stored)) return 0;
  if (!write) return 1;
  const { record, ref, value } = hostedRecordValue({ ...purged, version: head.version + 1 });
  invariant(
    !(await recordVersion(ctx, projectId, 'intent', record.id, record.version)),
    'WORK_STALE',
    'The Intent changed during the purge. Run the purge again to resume.',
  );
  invariant(record.kind === 'intent', 'SOURCE_UNAVAILABLE', 'The Intent head version is unavailable.');
  const identity = { projectId, kind: 'intent' as const, key: record.id },
    indexed = { ...hostedRecordIndex(record), version: record.version };
  const bodyId = await write.insert('projectHostedRecordBodies', { projectId, value });
  const recordId = await write.insert('projectHostedRecords', {
    ...identity,
    ...indexed,
    bodyId,
    digest: ref.digest,
    bytes: ref.bytes,
  });
  await write.replace(head._id, { ...identity, ...indexed, recordId });
  // The same store fingerprint a hosted Intent write keeps (convex/projectHostedRecords.ts writeHostedRecord).
  const project = await ctx.db.get(projectId);
  if (project)
    await fingerprintHostedIntent(ctx as MutationCtx, project, ref, head._creationTime, indexed.status);
  return 1;
}

/** Comment, note and lifecycle heads keep their current version inline; that copy takes the purged form too. One
 * page of one target: [kind, parent] for the Item and its Intent. Cursor: "<target index>|<last creation time>". */
async function storeHeads(
  ctx: Ctx,
  write: MutationCtx['db'] | undefined,
  projectId: Id<'hostedProjects'>,
  purge: ItemPurge,
  after: string | null,
) {
  const parents = [...new Set([purge.itemId, ...(purge.intentId ? [purge.intentId] : [])])];
  const targets = parents.flatMap(parent =>
    (['comment', 'lifecycle'] as const).map(kind => [kind, parent] as const),
  );
  const at = after === null ? 0 : Number(after.split('|')[0]),
    since = after === null ? '' : after.slice(after.indexOf('|') + 1);
  const [kind, parent] = targets[at]!;
  const heads = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_parent', q => {
      const scoped = q.eq('projectId', projectId).eq('kind', kind).eq('parent', parent);
      return since ? scoped.gt('_creationTime', Number(since)) : scoped;
    })
    .take(PURGE_PAGE);
  let changes = 0;
  for (const head of heads) {
    if (head.value === undefined) continue;
    const value = JSON.parse(head.value) as Record<string, unknown>;
    const collection = kind === 'lifecycle' ? 'lifecycle' : 'itemId' in value ? 'planningComments' : 'notes';
    const purged = JSON.stringify(purgedIndexValue(collection, value, purge.operationId));
    if (purged === head.value) continue;
    changes++;
    if (write) await write.patch(head._id, { value: purged });
  }
  const next =
    heads.length === PURGE_PAGE
      ? `${at}|${heads.at(-1)!._creationTime}`
      : at + 1 < targets.length
        ? `${at + 1}|`
        : null;
  return { changes, after: next };
}

const discussionCursor = 'discussion:';

async function discussionArtifacts(
  ctx: Ctx,
  apply: boolean,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  cursor: string | null,
) {
  const prefix = `${projectPrefix(projectId)}discussion/${itemId}/`;
  const page = await ctx.db
    .query('artifactBlobs')
    .withIndex('by_namespace_and_digest', q =>
      q.gte('namespace', prefix).lt('namespace', prefix.slice(0, -1) + '0'),
    )
    .paginate({ cursor, numItems: 8 });
  let changes = 0;
  for (const row of page.page) {
    if (row.removed) continue;
    changes++;
    if (apply) await removeArtifact(ctx as MutationCtx, row);
  }
  return { changes, after: page.isDone ? null : discussionCursor + page.continueCursor };
}

/** The Item's search row in its purged form: preview and searchable text carry no words, and a payload (its chunks
 * hold the text) is dropped, so the stale-payload step deletes the chunks. A fixed point on the tombstone's row. */
async function searchRow(
  ctx: Ctx,
  write: MutationCtx['db'] | undefined,
  partition: Id<'projectWorkGenerations'>,
  itemId: string,
) {
  const row = (await record(
    ctx,
    partition,
    'planningSearch',
    itemId,
  )) as Doc<'projectPlanningRecords'> | null;
  if (!row) return 0;
  const value = JSON.stringify(purgedIndexValue('planningSearch', JSON.parse(row.value), ''));
  const planning = row.planning && { ...row.planning, text: `${PURGED_ITEM_TITLE}\n` };
  if (row.parent === '' && value === row.value && JSON.stringify(planning) === JSON.stringify(row.planning))
    return 0;
  if (write) await write.patch(row._id, { value, parent: '', ...(planning ? { planning } : {}) });
  return 1;
}
