// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Bounded backlog audit window view (Item 1d51c91f): list Items closed, reopened or changed in a UTC
// window, per Initiative or project-wide, reusing projectHostedRecords' existing indexes (zero new indexes).
// A version's time is its record's _creationTime (as in initiativeCloseHistory). Classification reads
// record headers only; bodies are read for the Items on the returned page.
import { z } from 'zod';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { invariant } from '../src/errors';
import { diffPlanningVersion, parseAuditInstant } from '../src/planning-audit';
import { decisionsInWindow, type BodyDecision } from '../src/work-planning-put';
import { isShelved, type PlanningItem } from '../src/work-planning-types';
import { cursorJson } from './projectItemLandingHistory';
import { loadVersionSnapshot, writerIdentity, type ResolvedWriter } from './projectPlanningAudit';
import { planningHistoryBudget } from './projectPlanningHistory';

const WINDOW_CURSOR = 'forge-window-audit-v2:';
const RECENT_VERSIONS = 4096;
const WINDOW_SCAN_BYTES = 8 * 1024 * 1024;
const PAGE_BYTES = 2 * 1024 * 1024;
const PER_ITEM_LOOKUPS = 32;
const MAX_LIMIT = 100;
/** A version whose own time is this much older than its record was written later (an import). */
const RECORDED_LATER_MS = 60_000;
const recordedLater = (at: string | undefined, row: Row) => {
  const ms = at === undefined ? NaN : Date.parse(at);
  return Number.isFinite(ms) && ms < row._creationTime - RECORDED_LATER_MS;
};

const scanPos = z.object({ ts: z.number().min(0), skip: z.number().int().min(0).max(RECENT_VERSIONS) });
const windowCursorSchema = z
  .object({
    until: z.number().min(0),
    before: z.object({ ts: z.number().min(0), id: z.string() }).optional(),
    scanBefore: scanPos.optional(),
  })
  .strict();

type Row = Doc<'projectHostedRecords'>;
type Budget = ReturnType<typeof planningHistoryBudget>;
type WindowChangeFilter = 'all' | 'closed' | 'reopened' | 'changed';
type WindowEventTag = 'created' | 'closed' | 'reopened' | 'changed';

type WindowAuditItem = {
  itemId: string;
  kind: 'issue' | 'initiative';
  title: string;
  status: PlanningItem['status'];
  initiativeId: string | null;
  version: number;
  versionsInWindow: number;
  at: string;
  events: WindowEventTag[];
  closedAt: string | null;
  reopenedAt: string | null;
  reason?: string;
  summary: string;
  /** Set when the newest version was written to the store later than it happened (imported): the window
   * placed it by this time, and the Item's own timeline has the real dates. */
  recordedAt?: string;
  /** `## Decisions` lines dated inside the window (oldest first, newest 10 at most), read from the body already
   * loaded for this row; `decisionsOmitted` counts older ones. Absent when the Item recorded none. */
  decisions?: BodyDecision[];
  decisionsOmitted?: number;
} & ResolvedWriter;

/** One Item's in-window versions, classified from record headers. */
type Classified = {
  itemId: string;
  newest: Row;
  previous: Row | null;
  versions: number;
  tags: Set<WindowEventTag>;
  closed: Row | null;
  reopened: Row | null;
  unresolved: boolean;
};

function decodeWindowCursor(cursor: string | null | undefined) {
  if (!cursor) return null;
  const parsed = cursor.startsWith(WINDOW_CURSOR)
    ? windowCursorSchema.safeParse(cursorJson(cursor.slice(WINDOW_CURSOR.length)))
    : null;
  invariant(
    parsed?.success,
    'BAD_ARGUMENT',
    'cursor: expected the nextCursor returned by planning window history.',
  );
  return parsed.data;
}

const versionRow = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, key: string, version: number) =>
  ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
      q
        .eq('projectId', projectId)
        .eq('kind', 'issue')
        .eq('key', key)
        .eq('version', version)
        .eq('lifecyclePlanId', undefined),
    )
    .unique();

/** Classify one Item from its scanned rows (newest first). Returns 'listed' when a newer in-window version
 * was on an earlier scan page (that page lists the Item), or null when the budget ran out. */
async function classify(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  scope: { fromMs: number; untilMs: number; initiativeId?: string; olderPage: boolean },
  itemId: string,
  rows: Row[],
  charge: Budget,
): Promise<Classified | 'listed' | null> {
  const lookup = async (version: number) => {
    const row = await versionRow(ctx, project._id, itemId, version);
    if (row && !charge.record(row)) return undefined;
    return row;
  };
  const newestScanned = rows[0]!;
  if (scope.olderPage) {
    // A newer in-window version that matches the filter was listed on an earlier page. Walk every newer version, not
    // only the immediate one: an Item that moved out of the initiative and back has a non-matching successor.
    for (let version = newestScanned.version + 1, steps = 0; steps < PER_ITEM_LOOKUPS; version++, steps++) {
      const next = await lookup(version);
      if (next === undefined) return null;
      if (!next || next._creationTime > scope.untilMs) break;
      if (next.purged === undefined && (!scope.initiativeId || next.parent === scope.initiativeId))
        return 'listed';
    }
  }
  const scanned = new Map(rows.map(row => [row.version, row]));
  // In-window versions oldest last, then the version before the window (a gap is an exact point read).
  const inWindow: Row[] = [newestScanned];
  let previous: Row | null = null;
  let unresolved = false;
  let lookups = 0;
  for (let version = newestScanned.version - 1; version >= 1; version--) {
    let row: Row | null | undefined = scanned.get(version);
    if (!row) {
      if (lookups++ >= PER_ITEM_LOOKUPS) {
        unresolved = true;
        break;
      }
      row = await lookup(version);
      if (row === undefined) return null;
    }
    if (!row || row.purged !== undefined) {
      unresolved = true;
      break;
    }
    if (row._creationTime < scope.fromMs) {
      previous = row;
      break;
    }
    inWindow.push(row);
  }
  const tags = new Set<WindowEventTag>();
  let closed: Row | null = null;
  let reopened: Row | null = null;
  for (let i = inWindow.length - 1; i >= 0; i--) {
    const row = inWindow[i]!;
    const before = i + 1 < inWindow.length ? inWindow[i + 1]! : previous;
    if (row.version === 1) {
      tags.add('created');
      if (row.status === 'closed') closed = row;
      continue;
    }
    if (!before) {
      tags.add('changed');
      continue;
    }
    if (before.status === row.status || isShelved(row.status) || row.status === 'abandoned') {
      tags.add('changed');
    } else if (row.status === 'closed') {
      // A return to Closed from a shelf preserves the earlier close (same rule as initiativeCloseHistory).
      if (isShelved(before.status)) {
        if (charge.exhausted) return null;
        const was = (await loadVersionSnapshot(ctx, project._id, before, charge))?.item.was;
        if (was === undefined) unresolved = true;
        if (was === undefined || was === 'closed') tags.add('changed');
        else closed = row;
      } else closed = row;
    } else if (before.status === 'closed' || before.status === 'abandoned') reopened = row;
    else tags.add('changed');
  }
  if (closed) tags.add('closed');
  if (reopened) tags.add('reopened');
  return {
    itemId,
    newest: newestScanned,
    previous: inWindow[1] ?? previous,
    versions: inWindow.length,
    tags,
    closed,
    reopened,
    unresolved,
  };
}

/** The listed fields of one classified Item: at most four body reads (newest, its predecessor, the close and the
 * reopen). 'budget' stops the page here; 'missing' (an unreadable newest body) skips only this Item. */
async function describe(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  entry: Classified,
  charge: Budget,
  window: { fromMs: number; untilMs: number },
): Promise<WindowAuditItem | 'budget' | 'missing'> {
  const load = async (row: Row | null) =>
    row ? await loadVersionSnapshot(ctx, project._id, row, charge) : null;
  const latest = await load(entry.newest);
  if (!latest) return charge.exhausted ? 'budget' : 'missing';
  const optional = async (row: Row | null) => (row === entry.newest ? latest : await load(row));
  const before = await load(entry.previous);
  const closed = await optional(entry.closed);
  const reopened = await optional(entry.reopened);
  // An unreadable predecessor or close body degrades to "previous version unavailable"; only the budget stops.
  if (
    charge.exhausted &&
    ((entry.previous && !before) || (entry.closed && !closed) || (entry.reopened && !reopened))
  )
    return 'budget';
  const at = (row: Row | null, snap: typeof latest | null) =>
    row ? (snap?.item.at ?? new Date(row._creationTime).toISOString()) : null;
  const highlight = closed ?? reopened;
  const diff = diffPlanningVersion(before?.item ?? null, latest.item);
  const bodyChanged = latest.item.version === 1 || before?.item.body !== latest.item.body;
  const who = writerIdentity(
    latest.actor ?? (bodyChanged ? latest.item.author : undefined),
    latest.item.agent,
    latest.item.agentClient,
  );
  const reason = highlight?.item.reason ?? latest.item.reason;
  const said = decisionsInWindow(latest.item.body, window.fromMs, window.untilMs);
  return {
    itemId: latest.item.id,
    kind: latest.item.kind,
    title: latest.item.title,
    status: latest.item.status,
    initiativeId: latest.item.initiativeId ?? null,
    version: latest.item.version,
    versionsInWindow: entry.versions,
    at: latest.item.at,
    ...who,
    events: (['created', 'closed', 'reopened', 'changed'] as const).filter(tag => entry.tags.has(tag)),
    closedAt: at(entry.closed, closed),
    reopenedAt: at(entry.reopened, reopened),
    ...(reason ? { reason } : {}),
    ...(said.decisions.length
      ? { decisions: said.decisions, ...(said.omitted ? { decisionsOmitted: said.omitted } : {}) }
      : {}),
    summary: entry.versions > 1 ? `${diff.summary} (+${entry.versions - 1} earlier in window)` : diff.summary,
    ...(recordedLater(latest.item.at, entry.newest)
      ? { recordedAt: new Date(entry.newest._creationTime).toISOString() }
      : {}),
  };
}

export async function readBacklogWindowAudit(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  input: {
    initiativeId?: string;
    from: string;
    until?: string;
    change?: WindowChangeFilter;
    limit?: number;
    cursor?: string | null;
    now?: number;
    /** Scan page size; only fixtures lower it to cross scan pages with few versions. */
    scanRows?: number;
  },
) {
  const scanRows = Math.min(input.scanRows ?? RECENT_VERSIONS, RECENT_VERSIONS);
  const pageLimit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), MAX_LIMIT);
  const change: WindowChangeFilter = input.change ?? 'all';
  const cur = decodeWindowCursor(input.cursor);
  const fromMs = parseAuditInstant(input.from, false);
  invariant(Number.isFinite(fromMs), 'BAD_ARGUMENT', 'history.from: expected an ISO UTC date or datetime.');
  const now = input.now ?? Date.now();
  const askedUntil = input.until === undefined ? now : parseAuditInstant(input.until, true);
  invariant(Number.isFinite(askedUntil), 'BAD_ARGUMENT', 'history.to: expected an ISO UTC date or datetime.');
  // A fixed upper bound (never past now) keeps every page of one read on the same versions.
  const untilMs = cur?.until ?? Math.min(askedUntil, now);
  invariant(untilMs >= fromMs, 'BAD_ARGUMENT', 'history.to must be on or after history.from.');

  const result = (fields: {
    counts: Record<'total' | 'closed' | 'reopened' | 'created' | 'changed', number>;
    countsScope: 'window' | 'scan-page';
    items: WindowAuditItem[];
    coverage: 'complete' | 'partial' | 'unavailable';
    unresolved: number;
    recordsFrom: string | null;
    recordedLater: number;
    nextCursor: string | null;
  }) => ({
    window: { from: new Date(fromMs).toISOString(), until: new Date(untilMs).toISOString() },
    initiativeId: input.initiativeId ?? null,
    change,
    ...fields,
  });
  const cursorFor = (next: z.infer<typeof windowCursorSchema>) => WINDOW_CURSOR + JSON.stringify(next);

  const scanBudget = planningHistoryBudget(WINDOW_SCAN_BYTES);
  const charge = planningHistoryBudget(PAGE_BYTES);
  // Where this store's Item records begin (one indexed read, plus its body). When its first record was
  // imported from an earlier store, changes before that point are only on each Item's own timeline.
  let oldest: Row | null = null;
  for await (const row of ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind', q => q.eq('projectId', project._id).eq('kind', 'issue'))
    .order('asc')) {
    oldest = row;
    break;
  }
  const oldestItem =
    oldest && scanBudget.record(oldest)
      ? (await loadVersionSnapshot(ctx, project._id, oldest, charge))?.item
      : undefined;
  const recordsFrom = oldest && recordedLater(oldestItem?.at, oldest) ? oldest._creationTime : null;
  const purgedItems = new Set(
    project.itemPurges?.flatMap(({ itemId, commentId }) => (commentId ? [] : [itemId])),
  );
  const scanBefore = cur?.scanBefore;
  const upper = scanBefore?.ts ?? untilMs;
  const rows = input.initiativeId
    ? ctx.db
        .query('projectHostedRecords')
        .withIndex('by_project_and_kind_and_parent', q =>
          q
            .eq('projectId', project._id)
            .eq('kind', 'issue')
            .eq('parent', input.initiativeId!)
            .gte('_creationTime', fromMs)
            .lte('_creationTime', upper),
        )
        .order('desc')
    : ctx.db
        .query('projectHostedRecords')
        .withIndex('by_project_and_kind', q =>
          q
            .eq('projectId', project._id)
            .eq('kind', 'issue')
            .gte('_creationTime', fromMs)
            .lte('_creationTime', upper),
        )
        .order('desc');

  // Scan positions: `skip` counts the rows at `ts` that earlier pages consumed, so a page resumes exactly.
  const scanned: Row[] = [];
  let skipped = 0;
  let truncated = false;
  for await (const row of rows) {
    if (scanBefore && row._creationTime === scanBefore.ts && skipped < scanBefore.skip) {
      skipped++;
      continue;
    }
    if (scanned.length >= scanRows || !scanBudget.record(row)) {
      truncated = true;
      break;
    }
    scanned.push(row);
  }
  const positionAt = (index: number) => {
    const ts = scanned[index]!._creationTime;
    let skip = scanBefore?.ts === ts ? scanBefore.skip : 0;
    for (let i = 0; i < index; i++) if (scanned[i]!._creationTime === ts) skip++;
    return { ts, skip };
  };

  // Group by Item in newest-first order; remember where each Item's newest row sits in the scan.
  const grouped = new Map<string, { rows: Row[]; index: number }>();
  scanned.forEach((row, index) => {
    if (row.lifecyclePlanId !== undefined || row.purged !== undefined || purgedItems.has(row.key)) return;
    const group = grouped.get(row.key);
    if (group) group.rows.push(row);
    else grouped.set(row.key, { rows: [row], index });
  });

  const scope = { fromMs, untilMs, initiativeId: input.initiativeId, olderPage: Boolean(scanBefore) };
  const owned: Classified[] = [];
  let unresolved = 0;
  let stoppedAt: number | null = null;
  for (const [itemId, group] of grouped) {
    const entry = await classify(ctx, project, scope, itemId, group.rows, charge);
    if (entry === 'listed') continue;
    if (!entry) {
      // Out of budget: the next page starts at this Item, so nothing is dropped. A first Item that cannot
      // fit is counted and passed, so every page makes progress.
      if (owned.length) stoppedAt = group.index;
      else unresolved += grouped.size;
      break;
    }
    if (entry.unresolved) unresolved++;
    if (change === 'all' || entry.tags.has(change)) owned.push(entry);
  }

  owned.sort((a, b) =>
    a.newest._creationTime !== b.newest._creationTime
      ? b.newest._creationTime - a.newest._creationTime
      : a.itemId > b.itemId
        ? -1
        : 1,
  );
  const counts = {
    total: owned.length,
    closed: owned.filter(row => row.tags.has('closed')).length,
    reopened: owned.filter(row => row.tags.has('reopened')).length,
    created: owned.filter(row => row.tags.has('created')).length,
    changed: owned.filter(row => row.tags.has('changed')).length,
  };
  const before = cur?.before;
  const remaining = before
    ? owned.filter(
        row =>
          row.newest._creationTime < before.ts ||
          (row.newest._creationTime === before.ts && row.itemId < before.id),
      )
    : owned;
  const detail = planningHistoryBudget(PAGE_BYTES);
  const items: WindowAuditItem[] = [];
  let shown = 0;
  for (const entry of remaining.slice(0, pageLimit)) {
    const item = await describe(ctx, project, entry, detail, { fromMs, untilMs });
    if (item === 'budget') break;
    shown++;
    if (item === 'missing') unresolved++;
    else items.push(item);
  }
  // One Item too large for the page budget is counted and passed, so paging always moves on.
  if (!shown && remaining.length) {
    unresolved++;
    shown = 1;
  }

  let nextCursor: string | null = null;
  const last = shown ? remaining[shown - 1]! : null;
  if (last && shown < remaining.length)
    nextCursor = cursorFor({
      until: untilMs,
      before: { ts: last.newest._creationTime, id: last.itemId },
      ...(scanBefore ? { scanBefore } : {}),
    });
  else if (stoppedAt !== null) nextCursor = cursorFor({ until: untilMs, scanBefore: positionAt(stoppedAt) });
  else if (truncated && scanned.length) {
    const end = positionAt(scanned.length - 1);
    nextCursor = cursorFor({ until: untilMs, scanBefore: { ts: end.ts, skip: end.skip + 1 } });
  }
  const onePage = !scanBefore && !truncated && stoppedAt === null;
  const later = items.filter(item => item.recordedAt).length;
  const beforeRecords = recordsFrom !== null && fromMs < recordsFrom;
  return result({
    counts,
    countsScope: onePage ? 'window' : 'scan-page',
    items,
    coverage: onePage && !unresolved && !later && !beforeRecords ? 'complete' : 'partial',
    unresolved,
    recordsFrom: recordsFrom === null ? null : new Date(recordsFrom).toISOString(),
    recordedLater: later,
    nextCursor,
  });
}
