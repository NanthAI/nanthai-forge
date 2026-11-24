// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Purge executor, read-only half (Item 4c9e961e, purge Lane 2): the preflight and the first-step selection. Both
// read; neither writes. Selection pages the project's Work journal in revision order and keeps only the rows that
// write to the Item (any of its ids), with the digest of the facts each will hold once purged.
import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { purgedFactsDigest, redactPlanningWrite } from '../src/work-intent-types';
import { purgeableRowTarget, purgedIntentKeys } from '../src/work-planning-purge';
import { recordHead } from './projectHostedRecords';
import { verifiedItemMembership } from './projectItemMembershipVersion';
import { decisionOperationId } from '../src/work-planning-put';
import { purgedDecisionRequest } from '../src/work-planning-state';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { settledRecordTable, splitRecordTable } from './projectWorkRecordTables';
import { metadataRequest } from '../src/work-metadata';
import { pendingIntentArchives } from './projectJournalArchivePlan';
import { indexValue } from './projectPlanningPurgeRedact';

/** Journal rows per selection page: a planning row is at most ~110 KB, so a page stays far under the read limit. */
export const PURGE_SELECT_PAGE = 64;
export const purgeJournalTables = ['projectWorkEvents', 'projectHostedRecordBodies'] as const;
type JournalTable = (typeof purgeJournalTables)[number];

/** The text a journal row's command is in: whole, purged (facts) or archived (facts, segment elsewhere). */
export function journalText(row: { command?: string; journalCommand?: string }) {
  return row.command ?? row.journalCommand;
}

/** Aliases a purge reads in one transaction. The alias collection has no index by Intent, so a purge scans it all
 * and refuses a project with more (nothing written) rather than miss a row written through an unread alias. */
export const PURGE_ALIAS_LIMIT = 8000;

/** The Item's ids in the selected index: the id the caller named, its history id (the tombstone's or the Deleted
 * root's), its Intent id and every alias that resolves to that Intent (all of the project's aliases are read). */
export async function purgeTarget(ctx: QueryCtx, projectId: Id<'hostedProjects'>, itemId: string) {
  const project = await ctx.db.get(projectId);
  invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
  const generation = await selectedGeneration(ctx, project);
  invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
  const partition = recordPartition(generation);
  const alias = await record(ctx, partition, 'intentAliases', itemId);
  const intentId = alias ? (JSON.parse(alias.value) as { intentId: string }).intentId : itemId;
  const intent = await record(ctx, partition, 'intents', intentId);
  const root =
    (await record(ctx, partition, 'planningItems', itemId)) ??
    (intentId === itemId ? null : await record(ctx, partition, 'planningItems', intentId));
  invariant(root, 'NOT_FOUND', 'Select an existing Item.');
  const item = JSON.parse(root.value) as {
    id: string;
    version: number;
    kind: 'issue' | 'initiative';
    status: string;
    at: string;
    purged?: { operationId: string };
  };
  const ids = new Set([itemId, item.id, ...(intent ? [intentId] : [])]);
  const aliases = await ctx.db
    .query(splitRecordTable('intentAliases'))
    .withIndex('by_generation_and_collection_and_position', q =>
      q.eq('generationId', partition).eq('collection', 'intentAliases'),
    )
    .take(PURGE_ALIAS_LIMIT + 1);
  invariant(
    aliases.length <= PURGE_ALIAS_LIMIT,
    'BAD_ARGUMENT',
    `This project has more than ${PURGE_ALIAS_LIMIT} Intent aliases; a purge cannot list them all yet. Nothing was purged.`,
  );
  for (const row of aliases)
    if ((JSON.parse(row.value) as { intentId: string }).intentId === intentId) ids.add(row.key);
  return {
    project,
    generation,
    partition,
    item,
    historyId: item.id,
    intentId: intent ? intentId : undefined,
    ids: [...ids].sort(),
  };
}

/** Take the old bounded chain snapshot only while the newer writers' coverage is unverified. */
export async function legacyPurgeIntentKeys(ctx: QueryCtx, target: Awaited<ReturnType<typeof purgeTarget>>) {
  if (target.project.itemLaneMembership === verifiedItemMembership) return undefined;
  const keys: string[] = [];
  for (const key of purgedIntentKeys(target.historyId)) {
    if (key !== target.historyId && (await record(ctx, target.partition, 'planningItems', key))) break;
    const head = await recordHead(ctx, target.project._id, 'intent', key);
    if (!head || (head.planningItemId && head.planningItemId !== target.historyId)) break;
    keys.push(key);
  }
  return keys;
}

/** The revision the stored base reaches: the generation's backup, or the record-detail catalog a migration saved for
 * that backup (src/hosted-work-client.ts migrate-record-details), which a full load or rebuild starts from. Rows at
 * or before it are in a stored archive the purge cannot rewrite. */
export function baseRevision(project: Doc<'hostedProjects'>, generation: { initialRevision: number }) {
  const details = project.work?.recordDetails;
  return details && details.backupId === project.work?.backupId
    ? Math.max(details.revision, generation.initialRevision)
    : generation.initialRevision;
}
/** A purge of an Item created after the base that a new stored base (a record-detail catalog) reached since. */
export const BASE_CUT =
  'A stored base checkpoint cut during this purge holds the Item’s words again; run the purge after its base scrub. The purge stays open.';
/** Hosted display snapshots (projectHostedProjection) copy record bodies, the Item's included, under no index the
 * purge can page by Item. One indexed read; dogfood keeps none. */
export const DISPLAY_BLOCK =
  'This project keeps hosted display snapshots, which copy record bodies the purge cannot reach. Nothing was purged.';
export async function displaySnapshots(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  return (
    (
      await ctx.db
        .query('projectHostedDisplayRecords')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .take(1)
    ).length > 0
  );
}

/** Read-only preflight the lead runs before a purge: what will be selected and whether anything blocks it. Blocks:
 * the Item is not Deleted (and not already this purge's tombstone), its Intent id is not its own (the store's Intent
 * chain and the readers' check start from the Item id), or the project keeps display snapshots. Reports the index
 * generation and the work-store mode. */
export const preflight = internalQuery({
  args: { projectId: v.id('hostedProjects'), itemId: v.string() },
  returns: v.any(),
  handler: async (ctx, { projectId, itemId }) => {
    const target = await purgeTarget(ctx, projectId, itemId);
    const counts = JSON.parse(target.generation.metadata).counts ?? {};
    return {
      historyId: target.historyId,
      intentId: target.intentId ?? null,
      ids: target.ids,
      status: target.item.status,
      version: target.item.version,
      purged: target.item.purged?.operationId ?? null,
      generationId: target.generation._id,
      // Rows at or before this revision are in the base checkpoint (the stored archive the index is built from).
      initialRevision: baseRevision(target.project, target.generation),
      workStore: target.project.workStore ?? 'journal',
      journalRevision: target.project.journalRevision ?? 0,
      pendingArchives: await pendingIntentArchives(
        ctx,
        projectId,
        target.historyId,
        target.project.itemPurges?.find(
          purge => purge.itemId === target.historyId && !purge.commentId && purge.purgedAt === undefined,
        )?.intentKeys ?? (await legacyPurgeIntentKeys(ctx, target)),
      ),

      // Base-checkpoint planning versions: the executor redacts their index copies; the R2 archive stays.
      baseItems: counts.planningItems ?? null,
      blocked:
        target.item.status !== 'deleted'
          ? 'Only a Deleted Item can be deleted permanently.'
          : target.intentId && target.intentId !== target.historyId
            ? 'This Item’s Intent has an id of its own; a purge cannot follow it yet. Nothing was purged.'
            : (await displaySnapshots(ctx, projectId))
              ? DISPLAY_BLOCK
              : null,
    };
  },
});

/** The index collections a base Item's rows are found by (line 2e), with the parent they page by: its versions and
 * comments by the Item, its notes by its Intent; then the Intent's own row. */
const baseSources = [
  ['planningVersions', 'history'],
  ['planningComments', 'history'],
  ['notes', 'intent'],
] as const;

/** One page of a base Item's rows (line 2e): the rows of the Item that exist only in the stored base (no Work row of
 * their own), found through the selected Work index (each version, comment and note names its event; the Intent row
 * is the Intent's id), with the digest of their redacted facts, for the purge command (planning-purge-v2). A row the
 * journal holds is selected from the journal instead; an event already purged (an earlier comment purge) is skipped.
 * Cursor: source index and index position. At most PURGE_SELECT_PAGE index records and their events per page. */
export const basePage = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    ids: v.array(v.string()),
    historyId: v.string(),
    intentId: v.union(v.string(), v.null()),
    source: v.number(),
    after: v.union(v.number(), v.null()),
  },
  returns: v.object({
    rows: v.array(
      v.object({ operationId: v.string(), revision: v.number(), digest: v.string(), request: v.string() }),
    ),
    source: v.number(),
    after: v.union(v.number(), v.null()),
    done: v.boolean(),
  }),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an existing Forge project.');
    const generation = await selectedGeneration(ctx, project);
    invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before purging.');
    const partition = recordPartition(generation);
    const candidates: string[] = [];
    let { source, after } = input;
    const current = baseSources[source];
    if (current) {
      const [collection, which] = current;
      const parent = which === 'history' ? input.historyId : input.intentId;
      const page = parent
        ? await ctx.db
            .query(await settledRecordTable(ctx, partition, collection))
            .withIndex('by_generation_and_collection_and_parent_and_position', q => {
              const scoped = q
                .eq('generationId', partition)
                .eq('collection', collection)
                .eq('parent', parent);
              return after === null ? scoped : scoped.gt('position', after);
            })
            .take(PURGE_SELECT_PAGE)
        : [];
      for (const row of page) {
        if (collection === 'planningComments' || collection === 'planningVersions') candidates.push(row.key);
        else {
          const { full } = await indexValue(ctx, partition, collection, row);
          const id = full.operationId ?? full.id;
          if (typeof id === 'string') candidates.push(id);
        }
      }
      if (page.length === PURGE_SELECT_PAGE) after = page.at(-1)!.position;
      else {
        source++;
        after = null;
      }
    } else if (input.intentId) {
      candidates.push(input.intentId);
      source++;
    } else source++;
    const named = new Set(input.ids);
    const rows = [];
    for (const operationId of candidates) {
      if (await journalHolds(ctx, input.projectId, operationId)) continue;
      const root = await record(ctx, partition, 'events', operationId);
      if (!root) continue;
      const { full } = await indexValue(ctx, partition, 'events', root);
      const target = purgeableRowTarget(operationId, full.command);
      if (!target || !named.has(target.id)) continue;
      rows.push({
        operationId,
        revision: 0,
        digest: purgedFactsDigest(redactPlanningWrite(target.command)),
        request: typeof full.request === 'string' ? full.request : '',
      });
    }
    return { rows, source, after, done: source > baseSources.length };
  },
});

/** Whether the Work journal (either table) holds a row with this operation id. */
async function journalHolds(ctx: QueryCtx, projectId: Id<'hostedProjects'>, operationId: string) {
  for (const table of purgeJournalTables)
    if (
      (
        await ctx.db
          .query(table)
          .withIndex('by_project_and_operation', q =>
            q.eq('projectId', projectId).eq('operationId', operationId),
          )
          .take(1)
      ).length
    )
      return true;
  return false;
}

/** One selection page of one journal table: the Item's rows after `after` (revision), with their purged digests,
 * plus any decision comment (its derived version's purged request). Archived rows are selected by the Node reader. */
export const selectPage = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    table: v.union(v.literal('projectWorkEvents'), v.literal('projectHostedRecordBodies')),
    ids: v.array(v.string()),
    after: v.number(),
  },
  returns: v.object({
    rows: v.array(
      v.object({ operationId: v.string(), revision: v.number(), digest: v.string(), request: v.string() }),
    ),
    decisions: v.array(v.array(v.string())),
    created: v.union(v.number(), v.null()),
    creates: v.boolean(),
    after: v.number(),
    done: v.boolean(),
  }),
  handler: async (ctx, input) => selectRows(ctx, input),
});

export async function selectRows(
  ctx: QueryCtx,
  input: { projectId: Id<'hostedProjects'>; table: JournalTable; ids: string[]; after: number },
) {
  const page = await ctx.db
    .query(input.table)
    .withIndex('by_project_and_revision', q => q.eq('projectId', input.projectId).gt('revision', input.after))
    .take(PURGE_SELECT_PAGE);
  return {
    ...selectEventRows(
      page.filter(row => !('journalSegment' in row && row.journalSegment)),
      input.ids,
    ),
    after: page.at(-1)?.revision ?? input.after,
    done: page.length < PURGE_SELECT_PAGE,
  };
}

export function selectEventRows(
  page: readonly {
    operationId?: string;
    revision?: number;
    request?: string;
    command?: string;
    journalCommand?: string;
    purged?: string;
  }[],
  ids: readonly string[],
) {
  const named = new Set(ids);
  const rows: { operationId: string; revision: number; digest: string; request: string }[] = [];
  const decisions: string[][] = [];
  // The lowest revision of any of the Item's rows on this page (an Intent row, note or comment can predate the put),
  // and whether the page holds the creating put: with no creating put the Item came from a stored base.
  let created: number | null = null,
    creates = false;
  for (const row of page) {
    const text = journalText(row);
    if (
      text === undefined ||
      row.operationId === undefined ||
      row.request === undefined ||
      row.purged !== undefined
    )
      continue;
    let command;
    try {
      command = JSON.parse(text);
    } catch {
      continue;
    }
    const target = purgeableRowTarget(row.operationId, command);
    if (!target || !named.has(target.id)) continue;
    invariant(
      metadataRequest(target.command) === row.request,
      'INVALID_WORK_JOURNAL',
      'A Work row does not match its original request.',
    );
    rows.push({
      operationId: row.operationId,
      revision: row.revision!,
      digest: purgedFactsDigest(redactPlanningWrite(target.command)),
      request: row.request,
    });
    created = Math.min(created ?? row.revision!, row.revision!);
    if (target.command.action === 'put-planning-item' && target.command.expectedVersion === 0) creates = true;
    if (target.command.action === 'comment-planning-item' && target.command.decision)
      decisions.push([decisionOperationId(row.operationId), purgedDecisionRequest(row.request)]);
  }
  return { rows, decisions, created, creates };
}
