// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Pure: also runs in the Convex non-Node runtime. No I/O.
// Diffs and summaries for Item audit trails (Item 1d51c91f).
import { AGENT_CLIENT } from './agent-slug.js';
import { doneWhenCounts, itemStatus, itemStatusLabel, type StoredStatus } from './planning-model.js';
import { isShelved, type PlanningItem } from './work-planning-types.js';

const MAX_TEXT = 200;
const MAX_LINE = 120;
const MAX_TASK_TEXT = 140;
const MAX_TASKS_PER_GROUP = 20;
const MAX_EXCERPT_LINES = 6;
const MAX_DIFF_LINES = 400;
const TASK_LINE = /^([ \t>]*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?:\s+(.*))?$/;

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

const cleanLine = (line: string) => line.replace(/\s+/g, ' ').trim();

/** Parse an ISO UTC date (`YYYY-MM-DD`) or ISO datetime with offset/Z into epoch ms. Rejects invalid calendar dates. */
export function parseAuditInstant(value: string, endOfDay = false): number {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const iso = `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
    const time = Date.parse(iso);
    return Number.isFinite(time) && new Date(time).toISOString() === iso ? time : NaN;
  }
  const isoDateTime =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!isoDateTime) return NaN;
  const [, y, mo, d, h, mi, s] = isoDateTime;
  const check = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const checkDate = new Date(check);
  if (
    checkDate.getUTCFullYear() !== Number(y) ||
    checkDate.getUTCMonth() + 1 !== Number(mo) ||
    checkDate.getUTCDate() !== Number(d) ||
    checkDate.getUTCHours() !== Number(h) ||
    checkDate.getUTCMinutes() !== Number(mi) ||
    checkDate.getUTCSeconds() !== Number(s)
  )
    return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : NaN;
}

/** Extract declared model from `tool:model` (matching Item work and discussion displays). */
export const modelFromAgentClient = (client: unknown): string | null =>
  typeof client === 'string' && AGENT_CLIENT.test(client) ? (client.split(':')[1] ?? null) : null;

type DoneWhenDiff = {
  ticked?: string[];
  unticked?: string[];
  added?: { checked: boolean; text: string }[];
  removed?: { checked: boolean; text: string }[];
  truncated?: true;
};

type TaskEntry = { checked: boolean; text: string };

function taskLines(body: string): TaskEntry[] {
  const out: TaskEntry[] = [];
  for (const line of body.split('\n')) {
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    const text = cleanLine(match[3] ?? '');
    if (!text) continue;
    out.push({ checked: match[2] !== ' ', text });
  }
  return out;
}

/** Compare Done-when task lines between two Item bodies: ticks, unticks, additions and removals. */
export function diffDoneWhen(before: string, after: string): DoneWhenDiff | null {
  const prev = taskLines(before);
  const next = taskLines(after);
  if (!prev.length && !next.length) return null;
  const countMap = (entries: TaskEntry[]) => {
    const map = new Map<string, { open: number; done: number }>();
    for (const entry of entries) {
      const bucket = map.get(entry.text) ?? { open: 0, done: 0 };
      if (entry.checked) bucket.done++;
      else bucket.open++;
      map.set(entry.text, bucket);
    }
    return map;
  };
  const a = countMap(prev);
  const b = countMap(next);
  const ticked: string[] = [];
  const unticked: string[] = [];
  const added: TaskEntry[] = [];
  const removed: TaskEntry[] = [];
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const text of keys) {
    const oldCounts = a.get(text) ?? { open: 0, done: 0 };
    const newCounts = b.get(text) ?? { open: 0, done: 0 };
    // Match unchanged occurrences first.
    const sameOpen = Math.min(oldCounts.open, newCounts.open);
    const sameDone = Math.min(oldCounts.done, newCounts.done);
    let oldOpen = oldCounts.open - sameOpen;
    let oldDone = oldCounts.done - sameDone;
    let newOpen = newCounts.open - sameOpen;
    let newDone = newCounts.done - sameDone;
    const flippedDone = Math.min(oldOpen, newDone);
    for (let i = 0; i < flippedDone; i++) ticked.push(clip(text, MAX_TASK_TEXT));
    oldOpen -= flippedDone;
    newDone -= flippedDone;
    const flippedOpen = Math.min(oldDone, newOpen);
    for (let i = 0; i < flippedOpen; i++) unticked.push(clip(text, MAX_TASK_TEXT));
    oldDone -= flippedOpen;
    newOpen -= flippedOpen;
    for (let i = 0; i < newDone; i++) added.push({ checked: true, text: clip(text, MAX_TASK_TEXT) });
    for (let i = 0; i < newOpen; i++) added.push({ checked: false, text: clip(text, MAX_TASK_TEXT) });
    for (let i = 0; i < oldDone; i++) removed.push({ checked: true, text: clip(text, MAX_TASK_TEXT) });
    for (let i = 0; i < oldOpen; i++) removed.push({ checked: false, text: clip(text, MAX_TASK_TEXT) });
  }
  if (!ticked.length && !unticked.length && !added.length && !removed.length) return null;
  let truncated = false;
  const bound = <T>(list: T[]) => {
    if (list.length <= MAX_TASKS_PER_GROUP) return list;
    truncated = true;
    return list.slice(0, MAX_TASKS_PER_GROUP);
  };
  return {
    ...(ticked.length ? { ticked: bound(ticked) } : {}),
    ...(unticked.length ? { unticked: bound(unticked) } : {}),
    ...(added.length ? { added: bound(added) } : {}),
    ...(removed.length ? { removed: bound(removed) } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

type BodyDiffSummary = {
  addedLines: number;
  removedLines: number;
  charsBefore: number;
  charsAfter: number;
  excerpt: string[];
  truncated?: true;
};

/** Bounded line diff summary for body edits: counts and up to 6 changed excerpt lines. */
export function bodyDiffSummary(before: string, after: string): BodyDiffSummary | null {
  if (before === after) return null;
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const removed: string[] = [];
  const added: string[] = [];
  if (midA.length <= MAX_DIFF_LINES && midB.length <= MAX_DIFF_LINES) {
    const cols = midB.length + 1;
    const table = new Uint16Array((midA.length + 1) * cols);
    for (let i = midA.length - 1; i >= 0; i--)
      for (let j = midB.length - 1; j >= 0; j--)
        table[i * cols + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * cols + j + 1]! + 1
            : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        i++;
        j++;
      } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) removed.push(midA[i++]!);
      else added.push(midB[j++]!);
    }
    while (i < midA.length) removed.push(midA[i++]!);
    while (j < midB.length) added.push(midB[j++]!);
  } else {
    removed.push(...midA);
    added.push(...midB);
  }
  const excerpt: string[] = [];
  let shown = 0;
  const totalNonEmpty = removed.filter(line => line.trim()).length + added.filter(line => line.trim()).length;
  const pushLines = (prefix: '-' | '+', lines: string[], budget: number) => {
    for (const line of lines) {
      if (shown >= budget) break;
      const text = cleanLine(line);
      if (!text) continue;
      excerpt.push(`${prefix} ${clip(text, MAX_LINE)}`);
      shown++;
    }
  };
  const addedFirst = Math.min(added.filter(line => line.trim()).length, Math.ceil(MAX_EXCERPT_LINES / 2));
  const removedBudget = MAX_EXCERPT_LINES - addedFirst;
  pushLines('-', removed, removedBudget);
  pushLines('+', added, MAX_EXCERPT_LINES);
  return {
    addedLines: added.length,
    removedLines: removed.length,
    charsBefore: before.length,
    charsAfter: after.length,
    excerpt,
    ...(totalNonEmpty > excerpt.length ? { truncated: true as const } : {}),
  };
}

/** True when two bodies differ solely in ticking/unticking `[ ]` <-> `[x]` on existing task lines. */
function onlyCheckboxFlips(before: string, after: string): boolean {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length !== b.length) return false;
  let flipped = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const left = TASK_LINE.exec(a[i]!);
    const right = TASK_LINE.exec(b[i]!);
    if (!left || !right || left[1] !== right[1] || left[3] !== right[3]) return false;
    flipped = true;
  }
  return flipped;
}

type StatusTransitionKind =
  | 'created'
  | 'closed'
  | 'reopened'
  | 'archived'
  | 'deleted'
  | 'restored'
  | 'abandoned'
  | 'status';

export type AuditChange =
  | { kind: 'purged'; deletedAt: string; by?: string }
  | {
      kind: 'created';
      itemKind: 'issue' | 'initiative';
      status: string;
      title: string;
      initiativeId?: string;
      parentId?: string;
      owner?: string;
      waitingOn?: PlanningItem['waitingOn'];
      type?: string;
      hidden?: true;
      reason?: string;
      bodyChars?: number;
      doneWhen?: [number, number] | null;
    }
  | {
      kind: 'status';
      transition: Exclude<StatusTransitionKind, 'created'>;
      before: string;
      after: string;
      reason?: string;
      was?: string;
    }
  | { kind: 'reason'; reason: string }
  | { kind: 'title'; before: string; after: string }
  | ({ kind: 'done-when' } & DoneWhenDiff)
  | ({ kind: 'body' } & BodyDiffSummary)
  | {
      kind: 'waiting-on';
      action: 'set' | 'changed' | 'cleared';
      before: PlanningItem['waitingOn'] | null;
      after: PlanningItem['waitingOn'] | null;
    }
  | {
      kind: 'move';
      field: 'initiativeId' | 'parentId' | 'order';
      before: string | null;
      after: string | null;
    }
  | { kind: 'owner'; before: { owner: string } | null; after: { owner: string } | null }
  | { kind: 'type'; before: string | null; after: string | null }
  | { kind: 'visibility'; before: boolean; after: boolean }
  | { kind: 'relations'; added: { kind: string; id: string }[]; removed: { kind: string; id: string }[] }
  | { kind: 'intents'; added: string[]; removed: string[] }
  | { kind: 'imported'; before: string | null; after: string | null }
  | { kind: 'version-snapshot'; status: string; title: string; previousMissing: true; reason?: string };

function classifyStatusTransition(before: string, after: string): Exclude<StatusTransitionKind, 'created'> {
  if (isShelved(after)) return after === 'archived' ? 'archived' : 'deleted';
  if (isShelved(before)) return 'restored';
  if (after === 'closed') return 'closed';
  if (after === 'abandoned') return 'abandoned';
  if (before === 'closed' || before === 'abandoned') return 'reopened';
  return 'status';
}

const stripAt = (value: string) => value.replace(/^@/, '');
const auditKindLabel = (kind: PlanningItem['kind']) => (kind === 'initiative' ? 'Initiative' : 'Item');
const auditStatusLabel = (status: string) =>
  Object.hasOwn(itemStatus, status) ? itemStatusLabel[itemStatus[status as StoredStatus]] : status;

/** Translate stored Item/status words in cached legacy audit summaries into the visible planning vocabulary. */
export function visibleAuditSummary(summary: string): string {
  const created = /^created (issue|initiative) \(([^)]+)\)(.*)$/.exec(summary);
  if (created)
    return `created ${auditKindLabel(created[1] as PlanningItem['kind'])} (${auditStatusLabel(created[2]!)})${created[3]!}`;
  const snapshot = /^version (\d+) \(([^;]+); previous version unavailable\)$/.exec(summary);
  if (snapshot)
    return `version ${snapshot[1]} (${auditStatusLabel(snapshot[2]!)}; previous version unavailable)`;
  return summary
    .split('; ')
    .map(part => {
      const bare = /^status ([a-z-]+) -> ([a-z-]+)(.*)$/.exec(part);
      if (bare) return `status ${auditStatusLabel(bare[1]!)} -> ${auditStatusLabel(bare[2]!)}${bare[3]!}`;
      const named = /^([a-z]+) \(([a-z-]+) -> ([a-z-]+)\)(.*)$/.exec(part);
      if (named)
        return `${named[1]} (${auditStatusLabel(named[2]!)} -> ${auditStatusLabel(named[3]!)})${named[4]!}`;
      return part.replace(/^(cleared|set|changed) waitingOn\b/, '$1 waiting on');
    })
    .join('; ');
}

/** Compute structured audit changes and a concise human summary between adjacent PlanningItem versions. */
export function diffPlanningVersion(
  prev: PlanningItem | null,
  next: PlanningItem,
): { changes: AuditChange[]; summary: string; transition?: StatusTransitionKind } {
  if (next.purged)
    return {
      changes: [
        {
          kind: 'purged',
          deletedAt: next.purged.deletedAt,
          ...(next.purged.by ? { by: next.purged.by } : {}),
        },
      ],
      summary: 'permanently deleted (purged)',
    };
  if (next.version === 1) {
    const doneWhen = next.body ? doneWhenCounts(next.body) : null;
    const change: AuditChange = {
      kind: 'created',
      itemKind: next.kind,
      status: next.status,
      title: clip(next.title, MAX_TEXT),
      ...(next.initiativeId ? { initiativeId: next.initiativeId } : {}),
      ...(next.parentId ? { parentId: next.parentId } : {}),
      ...(next.owner ? { owner: stripAt(next.owner) } : {}),
      ...(next.waitingOn ? { waitingOn: next.waitingOn } : {}),
      ...(next.type ? { type: next.type } : {}),
      ...(next.hidden ? { hidden: true as const } : {}),
      ...(next.reason ? { reason: clip(next.reason, MAX_TEXT) } : {}),
      ...(next.body ? { bodyChars: next.body.length, ...(doneWhen ? { doneWhen } : {}) } : {}),
    };
    return {
      changes: [change],
      transition: 'created',
      summary: `created ${auditKindLabel(next.kind)} (${auditStatusLabel(next.status)})${next.title ? `: ${clip(next.title, 80)}` : ''}`,
    };
  }
  if (!prev || prev.version !== next.version - 1) {
    return {
      changes: [
        {
          kind: 'version-snapshot',
          status: next.status,
          title: clip(next.title, MAX_TEXT),
          previousMissing: true,
          ...(next.reason ? { reason: clip(next.reason, MAX_TEXT) } : {}),
        },
      ],
      summary: `version ${next.version} (${auditStatusLabel(next.status)}; previous version unavailable)`,
    };
  }
  const changes: AuditChange[] = [];
  const parts: string[] = [];
  let transition: StatusTransitionKind | undefined;
  if (prev.status !== next.status) {
    transition = classifyStatusTransition(prev.status, next.status);
    changes.push({
      kind: 'status',
      transition,
      before: prev.status,
      after: next.status,
      ...(next.reason ? { reason: clip(next.reason, MAX_TEXT) } : {}),
      ...(next.was ? { was: next.was } : {}),
    });
    const beforeLabel = auditStatusLabel(prev.status);
    const afterLabel = auditStatusLabel(next.status);
    const label =
      transition === 'status'
        ? `status ${beforeLabel} -> ${afterLabel}`
        : `${transition} (${beforeLabel} -> ${afterLabel})`;
    parts.push(next.reason ? `${label}: ${clip(next.reason, 80)}` : label);
  } else if (next.reason && next.reason !== prev.reason) {
    changes.push({ kind: 'reason', reason: clip(next.reason, MAX_TEXT) });
    parts.push(`note: ${clip(next.reason, 80)}`);
  }
  if (prev.title !== next.title) {
    changes.push({ kind: 'title', before: clip(prev.title, MAX_TEXT), after: clip(next.title, MAX_TEXT) });
    parts.push('edited title');
  }
  if (prev.body !== next.body) {
    const doneWhen = diffDoneWhen(prev.body, next.body);
    if (doneWhen) {
      changes.push({ kind: 'done-when', ...doneWhen });
      const dw: string[] = [];
      if (doneWhen.ticked?.length) dw.push(`${doneWhen.ticked.length} ticked`);
      if (doneWhen.unticked?.length) dw.push(`${doneWhen.unticked.length} unticked`);
      if (doneWhen.added?.length) dw.push(`${doneWhen.added.length} added`);
      if (doneWhen.removed?.length) dw.push(`${doneWhen.removed.length} removed`);
      parts.push(`Done-when (${dw.join(', ')})`);
    }
    if (!onlyCheckboxFlips(prev.body, next.body)) {
      const diff = bodyDiffSummary(prev.body, next.body);
      if (diff) {
        changes.push({ kind: 'body', ...diff });
        parts.push(`edited body (+${diff.addedLines}/-${diff.removedLines} lines)`);
      }
    }
  }
  const waitBefore = prev.waitingOn ?? null;
  const waitAfter = next.waitingOn ?? null;
  if (waitBefore?.kind !== waitAfter?.kind || waitBefore?.reason !== waitAfter?.reason) {
    const action = !waitAfter ? 'cleared' : !waitBefore ? 'set' : 'changed';
    changes.push({ kind: 'waiting-on', action, before: waitBefore, after: waitAfter });
    parts.push(
      action === 'cleared'
        ? 'cleared waiting on'
        : `${action} waiting on (${waitAfter!.kind}: ${clip(waitAfter!.reason, 60)})`,
    );
  }
  if ((prev.initiativeId ?? null) !== (next.initiativeId ?? null)) {
    changes.push({
      kind: 'move',
      field: 'initiativeId',
      before: prev.initiativeId ?? null,
      after: next.initiativeId ?? null,
    });
    parts.push(next.initiativeId ? 'moved Initiative' : 'removed from Initiative');
  }
  if ((prev.parentId ?? null) !== (next.parentId ?? null)) {
    changes.push({
      kind: 'move',
      field: 'parentId',
      before: prev.parentId ?? null,
      after: next.parentId ?? null,
    });
    parts.push(next.parentId ? 'changed parent' : 'detached parent');
  }
  if ((prev.order ?? null) !== (next.order ?? null)) {
    changes.push({ kind: 'move', field: 'order', before: prev.order ?? null, after: next.order ?? null });
    parts.push('reordered');
  }
  if ((prev.owner ?? null) !== (next.owner ?? null)) {
    changes.push({
      kind: 'owner',
      before: prev.owner ? { owner: stripAt(prev.owner) } : null,
      after: next.owner ? { owner: stripAt(next.owner) } : null,
    });
    parts.push(next.owner ? 'changed owner' : 'cleared owner');
  }
  if ((prev.type ?? null) !== (next.type ?? null)) {
    changes.push({ kind: 'type', before: prev.type ?? null, after: next.type ?? null });
    parts.push(next.type ? `type ${next.type}` : 'cleared type');
  }
  if (Boolean(prev.hidden) !== Boolean(next.hidden)) {
    changes.push({ kind: 'visibility', before: Boolean(prev.hidden), after: Boolean(next.hidden) });
    parts.push(next.hidden ? 'hidden from public plan' : 'shown on public plan');
  }
  const relKey = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;
  const prevRels = new Map((prev.relations ?? []).map(r => [relKey(r), r]));
  const nextRels = new Map((next.relations ?? []).map(r => [relKey(r), r]));
  const addedRels = [...nextRels.entries()].filter(([k]) => !prevRels.has(k)).map(([, v]) => v);
  const removedRels = [...prevRels.entries()].filter(([k]) => !nextRels.has(k)).map(([, v]) => v);
  if (addedRels.length || removedRels.length) {
    changes.push({ kind: 'relations', added: addedRels, removed: removedRels });
    parts.push('updated relations');
  }
  const prevIntents = new Set(prev.intentIds);
  const nextIntents = new Set(next.intentIds);
  const addedIntents = [...nextIntents].filter(id => !prevIntents.has(id)).sort();
  const removedIntents = [...prevIntents].filter(id => !nextIntents.has(id)).sort();
  if (addedIntents.length || removedIntents.length) {
    changes.push({ kind: 'intents', added: addedIntents, removed: removedIntents });
    parts.push('updated linked Intents');
  }
  const impBefore = prev.imported ? `${prev.imported.source}:${prev.imported.key}` : null;
  const impAfter = next.imported ? `${next.imported.source}:${next.imported.key}` : null;
  if (impBefore !== impAfter) {
    changes.push({ kind: 'imported', before: impBefore, after: impAfter });
    parts.push('updated import attribution');
  }
  return {
    changes,
    ...(transition ? { transition } : {}),
    summary: parts.length ? parts.join('; ') : `version ${next.version} (no field change)`,
  };
}
