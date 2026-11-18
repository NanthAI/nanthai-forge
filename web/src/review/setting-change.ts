// SPDX-License-Identifier: Apache-2.0
// A held settings change as a person reads it (Item 16093ed1): one summary line, then a before/after row per changed
// field, a line diff for every script, and nothing internal unless asked. Pure: the server sends the setting as it is
// now and as the grant would leave it (convex/projectSettingCompare.ts); this only compares and words them. What the
// owner grants is still the exact request (its digest), never this view.

export type SettingOriginName =
  | 'policy'
  | 'check-definition'
  | 'check-import'
  | 'runner'
  | 'main-audit'
  | 'membership'
  | 'address';
export type SettingCompare = { subject?: string; before: unknown; after: unknown };
type ChangeRow = {
  path: string;
  label: string;
  kind: 'added' | 'removed' | 'changed';
  before: string;
  after: string;
  /** For a list: what the request adds and drops (counted, so a dropped duplicate shows), so a long list is not read twice. */
  added?: string[];
  dropped?: string[];
  /** The entries a list keeps change order. */
  reordered?: boolean;
  /** An added entry lands before a kept one: an argument inserted into `bash -c` changes what runs. */
  inserted?: boolean;
  /** For a list: every entry before and after, in order, each one drawn on its own, added and dropped ones marked. */
  beforeEntries?: ListEntry[];
  afterEntries?: ListEntry[];
  /** A command field (executable, args, env, credentials): non-ASCII letters are flagged with their code point. */
  command?: boolean;
};
export type ListEntry = { text: string; mark?: 'added' | 'dropped' };
type DiffLine = { op: 'same' | 'add' | 'del'; text: string };
type ScriptDiff = {
  path: string;
  label: string;
  lines: DiffLine[] | null;
  before: string;
  after: string;
};
type SettingChangeView = {
  summary: string;
  rows: ChangeRow[];
  scripts: ScriptDiff[];
  /** Fields the request leaves as they are. */
  same: number;
  /** The server sent no comparison (an older server, or an ended request): only the request can be shown. */
  unavailable: boolean;
};

const WHAT: Record<SettingOriginName, string> = {
  policy: 'Project policy',
  'check-definition': 'Check',
  'check-import': 'Check import',
  runner: 'Check runner',
  'main-audit': 'Main audit',
  membership: 'Project membership',
  address: 'Project address',
};
/** Top-level request fields that say how the request is applied, not what it changes: shown only behind "Details".
 * Only at the top: a nested field with one of these names is part of the setting and shows when it changes. */
const INTERNAL = new Set([
  'operationId',
  'authorityEpoch',
  'expected',
  'expectedPolicy',
  'checkId',
  'definition',
  'digest',
  'id',
  'at',
]);
/** Fields whose text becomes what a check runs: a look-alike letter there (Cyrillic і in a URL) is flagged. */
const COMMAND_FIELDS = new Set(['executable', 'args', 'env', 'credentials']);
/** A line diff past this many lines on either side shows both versions whole instead (bounded work). */
export const DIFF_LINE_LIMIT = 400;

type Leaf = string | number | boolean | null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isLeaf = (value: unknown): value is Leaf =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** Leaves by dotted path; a list of plain values stays one leaf, a list of objects is one leaf per entry. */
function flatten(value: unknown, path = '', out = new Map<string, unknown>()) {
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value))
      if (path || !INTERNAL.has(key)) flatten(child, path ? `${path}.${key}` : key, out);
  } else if (Array.isArray(value) && value.some(entry => !isLeaf(entry)))
    value.forEach((entry, index) => flatten(entry, `${path}[${index}]`, out));
  else if (path) out.set(path, value);
  return out;
}

const words = (key: string) =>
  key
    .replace(/\[(\d+)\]/g, ' $1')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
/** "acceptance.protectedPaths" reads "Acceptance › protected paths". */
function fieldLabel(path: string) {
  const parts = path.split('.').map(words);
  parts[0] = parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1);
  return parts.join(' › ');
}
function valueText(value: unknown): string {
  if (value === undefined || value === null) return 'not set';
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (typeof value === 'number') return value.toLocaleString('en', { maximumFractionDigits: 20 });
  // Quoted when it would read like a word this view uses or hides outer spaces, so "on" never reads like true.
  if (typeof value === 'string')
    return VIEW_WORDS.has(value) || value.trim() !== value ? JSON.stringify(value) : value;
  // An entry holding the separator is quoted, so ["--a, --b"] never reads like ["--a", "--b"].
  if (Array.isArray(value))
    return value.length
      ? value
          .map(entry => {
            const text = valueText(entry);
            return typeof entry === 'string' && text === entry && text.includes(',')
              ? JSON.stringify(entry)
              : text;
          })
          .join(', ')
      : 'none';
  return JSON.stringify(value);
}
const VIEW_WORDS = new Set(['', 'on', 'off', 'not set', 'empty', 'none']);
/** Characters that change how text displays without showing: direction overrides and isolates (Trojan Source),
 * zero-width and invisible format characters, invisible filler letters (Hangul fillers, the blank braille pattern,
 * the combining grapheme joiner), variation selectors, tag characters and control characters other than tab and
 * newline. */
const HIDDEN_CLASS =
  '[\\0-\\x08\\x0B-\\x1F\\x7F-\\x9F\\xAD\\u034F\\u061C\\u115F\\u1160\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\u2800\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]';
const HIDDEN = new RegExp(HIDDEN_CLASS, 'gu');
const HIDDEN_OR_WIDE = new RegExp(`${HIDDEN_CLASS}|[^\\0-\\x7F]`, 'gu');
const isHidden = new RegExp(`^${HIDDEN_CLASS}$`, 'u');
const codePoint = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
export type Revealed = string | { hidden: string } | { char: string; code: string };
/** Agent text split so every hidden character can be drawn as a visible marker ("U+202E") instead of acting; with
 * `nonAscii`, every other non-ASCII character is also split out with its code point, for command text. */
export function revealHidden(text: string, nonAscii = false): Revealed[] {
  const parts: Revealed[] = [];
  let last = 0;
  for (const match of text.matchAll(nonAscii ? HIDDEN_OR_WIDE : HIDDEN)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      isHidden.test(match[0])
        ? { hidden: codePoint(match[0]) }
        : { char: match[0], code: codePoint(match[0]) },
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
/** The request as sent, as indented JSON with every hidden character escaped (\u202e): the same JSON value, and it
 * cannot reorder how the text displays. */
export const requestJson = (change: unknown) =>
  JSON.stringify(change ?? null, null, 2).replace(HIDDEN, char =>
    Array.from(
      { length: char.length },
      (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, '0')}`,
    ).join(''),
  );
const multiline = (value: unknown): value is string => typeof value === 'string' && value.includes('\n');

/** Longest-common-subsequence line diff; null when either side is past the limit. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n'),
    b = after.split('\n');
  if (a.length > DIFF_LINE_LIMIT || b.length > DIFF_LINE_LIMIT) return null;
  const n = a.length,
    m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const lines: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push({ op: 'same', text: a[i]! });
      i++;
      j++;
      // A removed line reads before the line that replaces it.
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!))
      lines.push({ op: 'del', text: a[i++]! });
    else lines.push({ op: 'add', text: b[j++]! });
  }
  return lines;
}

const entryOf = (value: unknown, mark?: ListEntry['mark']): ListEntry =>
  mark ? { text: valueText(value), mark } : { text: valueText(value) };
/** Adds and drops counted per entry (a dropped duplicate shows), and whether the kept entries changed order. */
function listChange(old: unknown[], neu: unknown[]) {
  const key = (value: unknown) => JSON.stringify(value) ?? 'undefined';
  const kept = (from: unknown[], against: unknown[]) => {
    const left = new Map<string, number>();
    for (const entry of against) left.set(key(entry), (left.get(key(entry)) ?? 0) + 1);
    const keep: string[] = [],
      rest: unknown[] = [],
      flags = from.map(entry => {
        const count = left.get(key(entry)) ?? 0;
        if (count) left.set(key(entry), count - 1);
        (count ? keep : rest).push(count ? key(entry) : entry);
        return Boolean(count);
      });
    return { keep, rest, flags };
  };
  const fromOld = kept(old, neu),
    fromNew = kept(neu, old);
  const firstKept = fromNew.flags.lastIndexOf(true);
  return {
    added: fromNew.rest.map(valueText),
    dropped: fromOld.rest.map(valueText),
    reordered: fromOld.keep.join('\n') !== fromNew.keep.join('\n'),
    // An added entry before the last kept one is an insertion, not an append.
    inserted: fromNew.flags.some((isKept, index) => !isKept && index < firstKept),
    beforeEntries: old.map((entry, index) => entryOf(entry, fromOld.flags[index] ? undefined : 'dropped')),
    afterEntries: neu.map((entry, index) => entryOf(entry, fromNew.flags[index] ? undefined : 'added')),
  };
}

/** Leaf lists with a multi-line entry (a check's `bash -c` script) split into one leaf per entry. */
function splitScripts(leaves: Map<string, unknown>) {
  for (const [path, value] of [...leaves])
    if (Array.isArray(value) && value.some(multiline)) {
      leaves.delete(path);
      value.forEach((entry, index) => leaves.set(`${path}[${index}]`, entry));
    }
  return leaves;
}

export function settingChangeView(
  origin: SettingOriginName | undefined,
  compare: SettingCompare | null | undefined,
): SettingChangeView {
  const what = `${origin ? WHAT[origin] : 'Setting'}${compare?.subject ? ` ${compare.subject}` : ''}`;
  if (!compare || compare.after === null || compare.after === undefined)
    return {
      summary: `${what}: the change could not be compared with the current setting. Open Details to read the request.`,
      rows: [],
      scripts: [],
      same: 0,
      unavailable: true,
    };
  const before = splitScripts(flatten(compare.before)),
    after = splitScripts(flatten(compare.after));
  const rows: ChangeRow[] = [],
    scripts: ScriptDiff[] = [];
  let same = 0;
  const paths = new Set([...before.keys(), ...after.keys()]);
  // Two keys that differ only in case or separators ("Mac" and "mac") would get one label: those keep their raw path.
  const byLabel = new Map<string, string[]>();
  for (const path of paths) byLabel.set(fieldLabel(path), [...(byLabel.get(fieldLabel(path)) ?? []), path]);
  const labels = new Map<string, string>();
  for (const group of byLabel.values())
    if (group.length > 1) for (const path of group) labels.set(path, path);
  for (const path of paths) {
    const was = before.get(path),
      now = after.get(path);
    // A policy read sends every field: a field the request does not name and the grant does not move is unchanged.
    if (JSON.stringify(was) === JSON.stringify(now)) {
      same++;
      continue;
    }
    const label = labels.get(path) ?? fieldLabel(path);
    if (multiline(was) || multiline(now)) {
      const a = typeof was === 'string' ? was : '',
        b = typeof now === 'string' ? now : '';
      scripts.push({ path, label, lines: lineDiff(a, b), before: a, after: b });
      continue;
    }
    const row: ChangeRow = {
      path,
      label: labels.get(path) ?? label,
      kind: was === undefined ? 'added' : now === undefined ? 'removed' : 'changed',
      ...(COMMAND_FIELDS.has(path.split(/[.[]/)[0]!) ? { command: true } : {}),
      before: valueText(was),
      after: valueText(now),
    };
    if (Array.isArray(was) || Array.isArray(now)) {
      const list = listChange(Array.isArray(was) ? was : [], Array.isArray(now) ? now : []);
      row.added = list.added;
      row.dropped = list.dropped;
      row.beforeEntries = list.beforeEntries;
      row.afterEntries = list.afterEntries;
      if (list.reordered) row.reordered = true;
      if (list.inserted) row.inserted = true;
    }
    rows.push(row);
  }
  return { summary: summaryLine(what, rows, scripts), rows, scripts, same, unavailable: false };
}

const listed = (items: string[]) =>
  items.length > 2 ? `${items.slice(0, 2).join(', ')} and ${items.length - 2} more` : items.join(' and ');
/** "Check verify: adds Java 17 to actions toolchains, changes environment label; script changed". */
function summaryLine(what: string, rows: ChangeRow[], scripts: ScriptDiff[]) {
  const parts = rows.map(row => {
    const field = row.label.charAt(0).toLowerCase() + row.label.slice(1);
    const order = row.reordered ? ' and reorders it' : '';
    if (row.added?.length && !row.dropped?.length)
      return `${row.inserted ? 'inserts' : 'adds'} ${listed(row.added)} ${row.inserted ? 'into' : 'to'} ${field}${order}`;
    if (row.dropped?.length && !row.added?.length)
      return `drops ${listed(row.dropped)} from ${field}${order}`;
    if (row.reordered && !row.added?.length && !row.dropped?.length) return `reorders ${field}`;
    if (row.kind === 'added') return `sets ${field} to ${row.after}`;
    if (row.kind === 'removed') return `clears ${field}`;
    return `changes ${field}`;
  });
  const shown = parts.length > 3 ? [...parts.slice(0, 3), `${parts.length - 3} more`] : parts;
  const script = scripts.length
    ? `${scripts.length === 1 ? 'script' : `${scripts.length} scripts`} changed`
    : '';
  if (!shown.length && !script) return `${what}: no field changes; granting applies the request as sent.`;
  return `${what}: ${[shown.join(', '), script].filter(Boolean).join('; ')}.`;
}
