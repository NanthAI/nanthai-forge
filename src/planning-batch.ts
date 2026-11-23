// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { isLive, type PlanRow } from './planning-model.js';
import type { PlanningItem } from './work-planning-types.js';
// Pure: also runs in the Convex non-Node runtime and in the web app. No I/O.
//
// Backlog batches (Item 65b0e706, docs/planning.md "Batches"): one person or agent action that changes many Items
// at once (move, re-parent, assign, change status or type, close many, split, merge) is one list of planning writes
// applied by one retry-safe call (convex/projectPlanningBatch.ts apply). Each write stays an ordinary
// put-planning-item or comment-planning-item in the Work journal, so every reader and replay is unchanged. This file
// builds those lists and their one Undo; it never decides access or versions, which the server checks per Item.

/** Writes in one batch: a page of selected rows, or one split or merge with its carried comments. */
export const planningBatchLimit = 100;

export type BatchStatus =
  | 'proposed'
  | 'open'
  | 'in-progress'
  | 'closed'
  | 'abandoned'
  | 'archived'
  | 'deleted';
export type BatchRelation = { kind: 'depends-on' | 'duplicate-of' | 'related'; id: string };
/** The fields a batch put may name; omitted keeps, null clears (docs/planning.md "Fields"). */
export type BatchFields = {
  kind?: 'issue' | 'initiative';
  title?: string;
  body?: string;
  status?: BatchStatus;
  reason?: string;
  intentIds?: string[];
  initiativeId?: string | null;
  order?: string | null;
  type?: string | null;
  parentId?: string | null;
  owner?: string | null;
  waitingOn?: PlanningItem['waitingOn'] | null;
  relations?: BatchRelation[];
  hidden?: boolean;
};
export type BatchPut = { action: 'put-planning-item'; itemId: string; expectedVersion: number } & BatchFields;
export type BatchComment = {
  action: 'comment-planning-item';
  itemId: string;
  text: string;
  authorLabel?: string;
};
export type BatchWrite = BatchPut | BatchComment;

/** The stored fields Undo puts back; the server reads them from the Item in the same transaction. */
export const undoableFields = [
  'title',
  'body',
  'status',
  'intentIds',
  'initiativeId',
  'order',
  'type',
  'parentId',
  'owner',
  'waitingOn',
  'relations',
  'hidden',
] as const;
type Undoable = (typeof undoableFields)[number];
export type BatchBefore = Partial<Record<Undoable, unknown>> & { kind?: string };

/** One write's outcome. `before` holds the touched fields as they were (absent on a replayed write, which was
 * applied by the original call). A refused write names why; nothing else in the batch is affected by it. */
export type BatchResult = {
  index: number;
  itemId: string;
  action: BatchWrite['action'];
  outcome: 'applied' | 'replayed' | 'refused';
  version?: number;
  code?: string;
  message?: string;
  currentVersion?: number;
  before?: BatchBefore;
};

const cleared = (field: Undoable): unknown =>
  field === 'relations' || field === 'intentIds'
    ? []
    : field === 'hidden'
      ? false
      : field === 'body'
        ? ''
        : null;

/**
 * The one Undo of a batch: for every put that was applied, a put at its new version that writes back each field the
 * batch named. Creations (version 1) are abandoned with the reason "Undone", since an Item is never removed by Undo;
 * comments stay (a comment is never deleted) and are counted in `kept`.
 */
export function batchUndo(writes: readonly BatchWrite[], results: readonly BatchResult[]) {
  const undo: BatchPut[] = [];
  let kept = 0;
  let unknown = 0;
  for (const result of results) {
    const write = writes[result.index];
    if (!write || result.outcome === 'refused') continue;
    if (write.action === 'comment-planning-item') {
      kept++;
      continue;
    }
    if (result.outcome === 'replayed' || !result.before || result.version === undefined) {
      unknown++;
      continue;
    }
    if (write.expectedVersion === 0) {
      undo.push({
        action: 'put-planning-item',
        itemId: write.itemId,
        expectedVersion: result.version,
        status: 'abandoned',
        reason: 'Undone',
      });
      continue;
    }
    const back: BatchFields = {};
    for (const field of undoableFields)
      if (field in write && (write as Record<string, unknown>)[field] !== undefined)
        (back as Record<string, unknown>)[field] = result.before[field] ?? cleared(field);
    undo.push({
      action: 'put-planning-item',
      itemId: write.itemId,
      expectedVersion: result.version,
      ...back,
    });
  }
  return { undo, kept, unknown };
}

/** The same change to every selected Item, each at the version the caller read. */
export function changeEach(
  rows: readonly { id: string; version?: number }[],
  fields: BatchFields,
): BatchPut[] {
  return rows.map(row => ({
    action: 'put-planning-item',
    itemId: row.id,
    expectedVersion: row.version ?? 0,
    ...fields,
  }));
}

// ---- Close many --------------------------------------------------------------------------------------------------
/** Close each selected Item with one note. An Item whose Done-when lines are not all ticked closes only with a
 * reason (owner decision 1.4): the note is that reason, or the one-press close-anyway reason. The reply names the
 * open lines each one left, so a follow-up can be offered and never forced. */
export const closeAnywayReason = 'Closed by hand with Done-when lines open';
export function closeMany(
  rows: readonly { id: string; version?: number; doneWhen?: readonly [number, number] | null }[],
  note: string,
) {
  const reason = note.trim();
  const writes = rows.map<BatchPut>(row => {
    const open = row.doneWhen ? row.doneWhen[1] - row.doneWhen[0] : 0;
    return {
      action: 'put-planning-item',
      itemId: row.id,
      expectedVersion: row.version ?? 0,
      status: 'closed',
      reason: reason || (open ? closeAnywayReason : 'Closed'),
    };
  });
  const openLines = rows
    .map(row => ({ id: row.id, open: row.doneWhen ? row.doneWhen[1] - row.doneWhen[0] : 0 }))
    .filter(entry => entry.open > 0);
  return { writes, openLines };
}

/** Use stored direct links. Clearing only parentId leaves the child's stored Initiative intact. */
export function detachAfterClose(closedIds: ReadonlySet<string>, liveRows: readonly PlanRow[]): BatchPut[] {
  return changeEach(
    liveRows.filter(
      row =>
        row.kind === 'issue' &&
        isLive(row) &&
        row.parentId &&
        closedIds.has(row.parentId) &&
        !closedIds.has(row.id),
    ),
    { parentId: null },
  );
}

// ---- Split -------------------------------------------------------------------------------------------------------
const taskLine = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
/** The body's Done-when lines in order (the task lines doneWhenCounts counts), with their text and tick. */
export function doneWhenLines(body: string) {
  return body
    .split('\n')
    .map((text, line) => ({ line, match: taskLine.exec(text) }))
    .filter(entry => entry.match)
    .map(entry => ({ line: entry.line, ticked: entry.match![1] !== ' ', text: entry.match![2]!.trim() }));
}

export type SplitItem = {
  id: string;
  version: number;
  title: string;
  body: string;
  initiativeId?: string | null;
  parentId?: string | null;
  type?: string | null;
  relations?: readonly BatchRelation[];
};
/**
 * Split one Item: `assign[k]` is the part (0 = the Item itself, 1.. = new parts) that takes Done-when line k. The
 * Item keeps its prose and its own lines; each new part is a Planned Item in the same Initiative and parent with its
 * lines, related both ways to the Item. `ids` are the new parts' ids, made by the caller so a retry reuses them.
 */
export function splitItem(
  item: SplitItem,
  parts: readonly { title: string }[],
  assign: readonly number[],
  ids: readonly string[],
): BatchWrite[] {
  const lines = doneWhenLines(item.body);
  if (assign.length !== lines.length)
    throw new RangeError('splitItem: assign one part to every Done-when line.');
  if (!parts.length || parts.length !== ids.length)
    throw new RangeError('splitItem: give each new part an id.');
  if (assign.some(part => !Number.isInteger(part) || part < 0 || part > parts.length))
    throw new RangeError('splitItem: a line names a part that does not exist.');
  const moved = new Set(lines.filter((_, index) => assign[index]! > 0).map(entry => entry.line));
  const kept = item.body
    .split('\n')
    .filter((_, line) => !moved.has(line))
    .join('\n');
  const related = [...(item.relations ?? [])];
  const writes: BatchWrite[] = parts.map((part, index) => {
    const own = lines.filter((_, line) => assign[line] === index + 1);
    related.push({ kind: 'related', id: ids[index]! });
    return {
      action: 'put-planning-item',
      itemId: ids[index]!,
      expectedVersion: 0,
      kind: 'issue',
      title: part.title.trim(),
      body: own.length
        ? `Split from ${item.id.slice(0, 8)}.\n\nDone when:\n${own.map(entry => `- [${entry.ticked ? 'x' : ' '}] ${entry.text}`).join('\n')}\n`
        : `Split from ${item.id.slice(0, 8)}.\n`,
      status: 'open',
      initiativeId: item.initiativeId ?? null,
      ...(item.parentId ? { parentId: item.parentId } : {}),
      ...(item.type ? { type: item.type } : {}),
      relations: [{ kind: 'related', id: item.id }],
    };
  });
  writes.unshift({
    action: 'put-planning-item',
    itemId: item.id,
    expectedVersion: item.version,
    body: kept,
    relations: related.slice(-20),
    reason: `Split into ${parts.length + 1} parts`,
  });
  return writes;
}

// ---- Merge -------------------------------------------------------------------------------------------------------
export type MergeItem = {
  id: string;
  version: number;
  title: string;
  intentIds?: readonly string[];
  relations?: readonly BatchRelation[];
  kind?: string;
};
export type MergeComment = {
  itemId: string;
  text: string;
  at: string;
  authorLabel?: string;
  author?: string;
  system?: boolean;
};
/**
 * Merge duplicates into the surviving Item: the survivor takes their Lane links (each duplicate's planned Intent and
 * its linked Intents, so Lanes and their evidence stay reachable from it) and a copy of each comment, naming where it
 * came from; each duplicate is abandoned as a duplicate with a `duplicate-of` link to the survivor.
 */
export function mergeItems(
  survivor: MergeItem,
  duplicates: readonly MergeItem[],
  comments: readonly MergeComment[],
): BatchWrite[] {
  if (duplicates.some(duplicate => duplicate.id === survivor.id))
    throw new RangeError('mergeItems: an Item cannot merge into itself.');
  const links = new Set(survivor.intentIds ?? []);
  for (const duplicate of duplicates) {
    if ((duplicate.kind ?? 'issue') === 'issue') links.add(duplicate.id);
    for (const id of duplicate.intentIds ?? []) links.add(id);
  }
  const merged = new Set(duplicates.map(duplicate => duplicate.id));
  const writes: BatchWrite[] = [
    {
      action: 'put-planning-item',
      itemId: survivor.id,
      expectedVersion: survivor.version,
      intentIds: [...links].sort(),
      reason: `Merged ${duplicates.map(duplicate => duplicate.id.slice(0, 8)).join(', ')}`,
    },
  ];
  for (const comment of comments.filter(entry => merged.has(entry.itemId) && !entry.system))
    writes.push({
      action: 'comment-planning-item',
      itemId: survivor.id,
      text: `From ${comment.itemId.slice(0, 8)}, ${comment.at.slice(0, 10)}${comment.author || comment.authorLabel ? ` (${comment.author || comment.authorLabel})` : ''}:\n\n${comment.text}`,
      ...(comment.authorLabel ? { authorLabel: comment.authorLabel } : {}),
    });
  for (const duplicate of duplicates)
    writes.push({
      action: 'put-planning-item',
      itemId: duplicate.id,
      expectedVersion: duplicate.version,
      status: 'abandoned',
      reason: `Duplicate of ${survivor.id.slice(0, 8)}`,
      relations: [
        ...(duplicate.relations ?? []).filter(
          relation => !(relation.kind === 'duplicate-of' && relation.id === survivor.id),
        ),
        { kind: 'duplicate-of' as const, id: survivor.id },
      ].slice(-20),
    });
  return writes;
}

/** One line for a batch reply or toast: how many changed, which were refused and why, what Undo leaves. */
export function batchSentence(results: readonly BatchResult[]) {
  const changed = results.filter(result => result.outcome !== 'refused').length;
  const refused = results.filter(result => result.outcome === 'refused');
  const moved = refused.filter(result => result.code === 'ITEM_CHANGED').length;
  return [
    `${changed.toLocaleString()} of ${results.length.toLocaleString()} changed.`,
    moved ? `${moved.toLocaleString()} changed meanwhile and kept the other change.` : '',
    refused.length - moved ? `${(refused.length - moved).toLocaleString()} refused.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
