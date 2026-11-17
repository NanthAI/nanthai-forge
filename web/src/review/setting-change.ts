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
  /** For a list: what the request adds and drops, so a long list is not read twice. */
  added?: string[];
  dropped?: string[];
};
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
/** Fields that say how the request is applied, not what it changes: shown only behind "Details". */
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
      if (!INTERNAL.has(key)) flatten(child, path ? `${path}.${key}` : key, out);
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
  if (typeof value === 'number') return value.toLocaleString('en');
  if (typeof value === 'string') return value === '' ? 'empty' : value;
  if (Array.isArray(value)) return value.length ? value.map(valueText).join(', ') : 'none';
  return JSON.stringify(value);
}
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
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(path),
      now = after.get(path);
    // A policy read sends every field: a field the request does not name and the grant does not move is unchanged.
    if (JSON.stringify(was) === JSON.stringify(now)) {
      same++;
      continue;
    }
    const label = fieldLabel(path);
    if (multiline(was) || multiline(now)) {
      const a = typeof was === 'string' ? was : '',
        b = typeof now === 'string' ? now : '';
      scripts.push({ path, label, lines: lineDiff(a, b), before: a, after: b });
      continue;
    }
    const row: ChangeRow = {
      path,
      label,
      kind: was === undefined ? 'added' : now === undefined ? 'removed' : 'changed',
      before: valueText(was),
      after: valueText(now),
    };
    if (Array.isArray(was) || Array.isArray(now)) {
      const old = (Array.isArray(was) ? was : []).map(valueText),
        neu = (Array.isArray(now) ? now : []).map(valueText);
      row.added = neu.filter(entry => !old.includes(entry));
      row.dropped = old.filter(entry => !neu.includes(entry));
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
    const field = row.label.toLowerCase();
    if (row.added?.length && !row.dropped?.length) return `adds ${listed(row.added)} to ${field}`;
    if (row.dropped?.length && !row.added?.length) return `drops ${listed(row.dropped)} from ${field}`;
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
