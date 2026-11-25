// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize } from 'convex/values';
import { digest } from './state/hash.js';
import type { IndexEntry } from './work-hosted-index.js';
import type { PlanningItem } from './work-planning-types.js';

/** Done-when lines are the body's Markdown task lines ("- [ ]", "- [x]"): [ticked, total], or null when none. */
export const planningTaskLine = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX~])(\][ \t]+)(.*?)(\r?)$/;

/** Browser and CLI address the same rows, including moved rows, excluding Markdown fences. */
function* unfencedLines(rows: readonly string[]) {
  let fence: string | undefined;
  for (const [row, raw] of rows.entries()) {
    if (fence) {
      const end = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/.exec(raw)?.[1];
      if (end?.startsWith(fence)) fence = undefined;
      continue;
    }
    const start = /^[ \t]*(`{3,})[^`\r]*\r?$|^[ \t]*(~{3,})[^\r]*\r?$/.exec(raw);
    const marker = start?.[1] ?? start?.[2];
    if (marker) {
      fence = marker;
      continue;
    }
    yield { row, raw };
  }
}

export function* planningTaskLines(rows: readonly string[]) {
  let position = 0;
  for (const { row, raw } of unfencedLines(rows)) {
    const match = planningTaskLine.exec(raw);
    if (match) yield { row, raw, position: ++position, match };
  }
}

/** Closure also honors bare and quoted legacy checkboxes, which cannot be ticked by position. */
export function closingChecklist(body: string) {
  const lines = [...unfencedLines(body.split('\n'))].map(line => line.raw);
  let structured = false;
  let checked = 0;
  const open: string[] = [];
  for (const raw of lines) {
    const match = /^[ \t>]*(?:(?:[-*+]|\d+[.)])[ \t]+)?\[([ xX~])\](.*)$/.exec(raw);
    if (!match) continue;
    structured = true;
    if (match[1] === ' ') open.push(match[2]!.replace(/\s+/g, ' ').trim());
    else if (match[1] !== '~') checked++;
  }
  // Plain bullets under the Done-when heading beside checkboxes are criteria too (item 3e5a4e18): they cannot be
  // ticked, so a person closes the Item.
  return {
    checked,
    open: structured
      ? [...open, ...proseDoneWhenLines(lines.join('\n'), true)]
      : proseDoneWhenLines(lines.join('\n')),
  };
}

export function doneWhenCounts(body: string): [number, number] | null {
  let ticked = 0,
    total = 0;
  for (const { match } of planningTaskLines(body.split('\n'))) {
    if (match[2] === '~') continue;
    total++;
    if (match[2] !== ' ') ticked++;
  }
  return total ? [ticked, total] : null;
}

/** The legacy prose gate: use only when there is no structured checklist. Prose needs a manual decision. */
export function proseDoneWhenLines(body: string, plainBulletsOnly = false): string[] {
  const heading = /^[ \t>#*_]*done[- ]when\b/im.exec(body);
  if (!heading) return [];
  const sectionLevel = /#+/.exec(heading[0])?.[0].length ?? 0;
  const lines = body
    .slice(heading.index + heading[0].length)
    .split('\n')
    .map(line => line.trim());
  const bullets: string[] = [];
  let first = lines[0]?.replace(/^[:*_\s]+/, '') ?? '';
  let text = /\w/.test(first);
  for (const line of lines.slice(1)) {
    // A deeper heading (### under ## Done-when) is still part of the section; only the same or a higher level ends it.
    const level = /^(#{1,6})\s/.exec(line)?.[1]!.length;
    if ((level !== undefined && level <= (sectionLevel || 6)) || /^\*\*[^*]+\*\*:?$/.test(line)) break;
    if (plainBulletsOnly && /^(?:[-*+]|\d+[.)])\s+\[[ xX~]\]/.test(line)) continue;
    if (/^(?:[-*+]|\d+[.)])\s+\S/.test(line))
      bullets.push(
        line
          .replace(/^[ \t>]*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s*)?/, '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    else if (/\w/.test(line)) {
      text = true;
      if (!/\w/.test(first)) first = line;
    }
  }
  if (plainBulletsOnly) return bullets;
  return bullets.length ? bullets : text ? [first || 'Done-when text'] : [];
}

/** The planning model fields a row carries when set (src/planning-model.ts); absent keys keep older rows' bytes. */
export const planningModelRow = (item: Partial<PlanningItem>) => ({
  ...(item.order ? { order: item.order } : {}),
  ...(item.type ? { type: item.type } : {}),
  ...(item.parentId && item.kind === 'issue' ? { parentId: item.parentId } : {}),
  ...(item.owner ? { owner: item.owner } : {}),
  ...(item.waitingOn ? { waitingOn: item.waitingOn } : {}),
  ...(item.relations?.length ? { relations: item.relations } : {}),
  ...(item.hidden ? { hidden: true as const } : {}),
  ...(item.imported ? { imported: item.imported } : {}),
  ...(item.was ? { was: item.was } : {}),
});

export const planningSummary = (
  item: PlanningItem & {
    bodyLength?: number;
    hasDoneWhen?: boolean;
    payloadKey?: string;
    doneWhen?: [number, number];
  },
) => {
  const bodyKnown = item.bodyLength !== undefined || !item.payloadKey || item.body.length > 0;
  const length = bodyKnown ? (item.bodyLength ?? item.body.length) : null;
  // A search row carries the full body's count; a whole item is counted here.
  const doneWhen =
    item.doneWhen ??
    (item.kind === 'issue' && length === item.body.length ? doneWhenCounts(item.body) : null);
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    status: item.status,
    version: item.version,
    intentIds: item.intentIds,
    initiativeId: item.initiativeId ?? null,
    ...planningModelRow(item),
    at: item.at,
    ...(item.author ? { author: item.author } : {}),
    body: item.body.slice(0, 400),
    bodyLength: length,
    hasDoneWhen: bodyKnown ? (item.hasDoneWhen ?? /done\s+when\s*:/i.test(item.body)) : null,
    ...(length === null || length > 400 ? { bodyTruncated: true } : {}),
    ...(doneWhen ? { doneWhen } : {}),
  };
};

/** Provider accepts 16 terms. Report the actual terms; never silently claim whole-query coverage. */
export function planningSearchTerms(text: string) {
  const all = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const terms = all.filter(term => [...term].length <= 32).slice(0, 16);
  return { text: terms.join(' '), omittedTerms: all.length - terms.length };
}
/**
 * A query that is one 8-character id prefix or a full UUID (as `planningSearchTerms` tokenised it)
 * names an item: the key prefix to look up directly, so the item comes before text mentions.
 */
export function planningIdPrefix(text: string): string | undefined {
  const terms = text.split(' ');
  if (terms.length === 1 && /^[0-9a-f]{8}$/.test(terms[0]!)) return terms[0];
  if (terms.length === 5 && /^[0-9a-f]{8} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{12}$/.test(text))
    return terms.join('-');
  return undefined;
}
const doneWhenField = (item: PlanningItem) => {
  const doneWhen = item.kind === 'issue' ? doneWhenCounts(item.body) : null;
  return doneWhen ? { doneWhen } : {};
};
/** Put `@due YYYY-MM-DD` at the start of a Markdown Done-when line. Keep the earliest open date in the
 * compact Issue row; the body retains all dates and the exact text. */
function dueCheck(item: PlanningItem) {
  if (
    item.kind !== 'issue' ||
    !['proposed', 'open', 'in-progress'].includes(item.status) ||
    !item.body.includes('@due ')
  )
    return null;
  let first: { date: string; line: number; text: string } | null = null;
  for (const [line, text] of item.body.split('\n').entries()) {
    const match = /^\s*[-*]\s+\[ \]\s+@due (\d{4}-\d{2}-\d{2}) (.+)$/.exec(text.trimEnd());
    if (!match) continue;
    const date = match[1]!;
    if (first && date >= first.date) continue;
    const time = Date.parse(date);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) continue;
    first = { date, line: line + 1, text: match[2]!.slice(0, 160) };
  }
  return first;
}

/** Search previews are bounded independently of the full, unchanged planning record. */
export function planningSearchEntry(item: PlanningItem, position: number): IndexEntry {
  const due = dueCheck(item);
  return {
    collection: 'planningSearch',
    key: item.id,
    // The root's existing parent index selects waiting reasons. Legacy roots already use the empty bucket.
    parent: item.waitingOn?.kind ?? '',
    position,
    value: JSON.stringify({
      id: item.id,
      kind: item.kind,
      status: item.status,
      ...(item.purged ? { purged: true } : {}),
      version: item.version,
      initiativeId: item.initiativeId ?? null,
      ...(item.author ? { author: item.author } : {}),
      title: item.title.slice(0, 400),
      titleLength: item.title.length,
      ...(item.title.length > 400 ? { titleTruncated: true } : {}),
      body: item.body.slice(0, 400),
      bodyLength: item.body.length,
      ...(item.body.length > 400 ? { bodyTruncated: true } : {}),
      hasDoneWhen: /done\s+when\s*:/i.test(item.body),
      ...planningModelRow(item),
      ...doneWhenField(item),
      ...(due ? { dueCheck: due } : {}),
    }),
    planning: {
      text: `${item.title}\n${item.body}`.replace(/[\uD800-\uDFFF]/gu, '\uFFFD'),
      kind: item.kind,
      status: item.status,
      initiativeId: item.initiativeId ?? '',
      open: ['proposed', 'open', 'in-progress'].includes(item.status),
    },
  };
}

/** Includes system and enclosing IDs; physical sizing, rather than a new input limit. */
export const planningSearchRowBytes = (entry: IndexEntry) =>
  getDocumentSize({
    ...entry,
    projectId: 'x'.repeat(32),
    generationId: 'x'.repeat(32),
  });

/** Ordinary records keep one row. Oversized legacy text uses the existing payload
 * retirement protocol, with bounded fragments and a compact root for current-version checks. */
export function planningSearchEntries(item: PlanningItem, position: number): IndexEntry[] {
  const entry = planningSearchEntry(item, position);
  if (planningSearchRowBytes(entry) <= 1048576) return [entry];
  const text = entry.planning!.text;
  const payloadKey = `${item.id}:${digest(text)}`;
  const fragments: string[] = [];
  // Preserve whole provider-indexable words. A >32-codepoint word is unindexed;
  // represent it by an equally unindexed placeholder instead of inventing split-word hits.
  let chunk = '';
  for (const match of text.matchAll(/[\p{Alphabetic}\p{Number}]+/gu)) {
    const term = match[0];
    const word = term.length > 64 || [...term].length > 32 ? 'z'.repeat(33) : term;
    if (chunk.length + word.length + 1 > 16000) {
      fragments.push(chunk);
      chunk = '';
    }
    chunk += `${word} `;
  }
  if (chunk || !fragments.length) fragments.push(chunk);
  const root = {
    ...entry,
    value: JSON.stringify({
      ...JSON.parse(entry.value),
      payloadKey,
      payloadParts: fragments.length,
    }),
    planning: { ...entry.planning!, text: '' },
  };
  return [
    root,
    ...fragments.map((text, part) => ({
      collection: 'planningSearch:payload',
      key: `${payloadKey}:${part}`,
      parent: payloadKey,
      position: part,
      // Concatenating payload values restores the exact compact summary, as for other Work payloads.
      value: part === 0 ? entry.value : '',
      planning: { ...entry.planning!, text, itemId: item.id, payloadKey },
    })),
  ];
}

type StatusItem = { lastStatusChangeAt?: string | null | undefined };

export const holdMarker = (openLines: number) =>
  `Intent completed; ${openLines} Done-when line(s) still open`;
/** An Issue whose Intent finished is closed (or abandoned) in planning, and the read says so. */
export function reconciledStatus(item: StatusItem, change?: { to: PlanningItem['status']; at?: string }) {
  if (!change) return {};
  return {
    status: change.to,
    ...(change.at ? { at: change.at } : {}),
    ...(item.lastStatusChangeAt === undefined
      ? {}
      : {
          lastStatusChangeAt: change.at ?? null,
          closedAt: change.to === 'closed' ? (change.at ?? null) : null,
        }),
  };
}

/** Done-when lines not yet ticked: acceptance not yet met. Unticked checkboxes (`- [ ]`, `* [ ]`,
 * `1. [ ]`) count. A Done-when section written without any checkbox (plain bullets or prose, friction
 * 8b4bfd78: Issues c329d191 and 47558a99 closed with agreed work pending) cannot be ticked, so each of
 * its bullet lines (or the paragraph, as one line) counts as open: a person closes such an Issue. A body
 * with no Done-when section keeps closing as before. Returns the line texts (CAS-free, body only). */
export const openDoneWhenLines = (body: string): string[] => closingChecklist(body).open;

/** What a builder needs after a landing that left Done-when lines open: which lines (at most five, 100
 * characters each) and the one command that closes the Issue with evidence. Pure text from the item
 * already read: no call. `version` is the Issue version the close must name. */
export const holdAdvice = (id: string, version: number, lines: string[]) => {
  const shown = lines.slice(0, 5).map(line => (line.length > 100 ? `${line.slice(0, 99)}…` : line));
  const more = lines.length - shown.length;
  return {
    lines: shown,
    close: `nforge agent . put-planning-item '{"itemId":"${id}","expectedVersion":${version},"status":"closed","reason":"Done-when met, evidence in comments"}'`,
    tick: `nforge agent . tick-planning-item '{"planningItemId":"${id}","line":1,"evidence":"…"}'`,
    text: `Open: ${shown.map(line => `"${line}"`).join('; ')}${more > 0 ? `; and ${more} more` : ''}. Tick each line with its evidence: nforge agent . tick-planning-item '{"planningItemId":"${id}","line":1,"evidence":"…"}' (line: the checkbox's position or a unique text prefix); the last tick closes the Issue.`,
  };
};
