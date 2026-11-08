// SPDX-License-Identifier: Apache-2.0
// Pure helpers of the cross-ecosystem zoo run (Issue 85d26a8b). No repository-specific branches:
// every choice is made from the file list, the ecosystem extension table or the receipt shape.

/** Line-comment syntax by source extension. A file type not listed here is never edited. */
export const COMMENT = Object.freeze({
  '.go': '//',
  '.rs': '//',
  '.kt': '//',
  '.kts': '//',
  '.java': '//',
  '.scala': '//',
  '.c': '//',
  '.h': '//',
  '.cc': '//',
  '.cpp': '//',
  '.ts': '//',
  '.js': '//',
  '.py': '#',
  '.rb': '#',
  '.sh': '#',
});

const TEST_PATH =
  /(^|\/)(tests?|testdata|fixtures?|examples?|benches|docs?|vendor|third_party)(\/|$)|_test\.go$|(^|\/)test_[^/]*\.py$|Test\.(kt|java)$/;
const ext = path => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
};
const dir = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Two non-test source files in different directories (two packages where the layout has them),
 * chosen deterministically: the most common source extension wins, then the shallowest, then
 * lexical order. Returns { ext, first, second } or null when the tree has no editable source.
 * `files` is [{ path, size, symlink? }]. */
export function pickProbeFiles(files) {
  const candidates = files.filter(
    f =>
      !f.symlink &&
      COMMENT[ext(f.path)] &&
      !TEST_PATH.test(f.path) &&
      !f.path.startsWith('.') &&
      !f.path.includes('/.') &&
      (f.size ?? 0) > 0 &&
      (f.size ?? 0) < 512 * 1024,
  );
  if (!candidates.length) return null;
  const counts = new Map();
  for (const f of candidates) counts.set(ext(f.path), (counts.get(ext(f.path)) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const depth = p => p.split('/').length;
  const ordered = candidates
    .filter(f => ext(f.path) === top)
    .map(f => f.path)
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  const first = ordered[0];
  const second = ordered.find(p => dir(p) !== dir(first)) ?? ordered.find(p => p !== first) ?? null;
  return { ext: top, first, second };
}

/** The text appended to a probe file: one comment line, so every ecosystem still builds. */
export function probeLine(path, tag) {
  const mark = COMMENT[ext(path)];
  if (!mark) throw Error(`ZOO_NO_COMMENT_SYNTAX ${path}`);
  return `${mark} forge-zoo probe ${tag}\n`;
}

/** Appends `line`, adding a newline first when the file does not end with one. */
export function appendLine(text, line) {
  return (text.length && !text.endsWith('\n') ? text + '\n' : text) + line;
}

/** Adds a trailing comment to the last non-blank line. Two Lanes doing this with different tags
 * change the same line, which no line merge can combine: a forced conflict in every tool. (Two
 * appended lines are not one: Forge lands both in order, Git conflicts.) */
export function tagLastLine(text, path, tag) {
  const mark = COMMENT[ext(path)];
  if (!mark) throw Error(`ZOO_NO_COMMENT_SYNTAX ${path}`);
  const lines = text.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i < 0) throw Error(`ZOO_EMPTY_FILE ${path}`);
  lines[i] = `${lines[i].replace(/\s+$/, '')} ${mark} forge-zoo ${tag}`;
  return lines.join('\n');
}

/** Resolves two-sided text conflicts as an agent would for two independent probe edits: hunks
 * whose sides are one line each carrying a `forge-zoo` tag become one line with both tags;
 * other hunks keep both sides (ours then theirs). The diff3 base is dropped. Throws without markers. */
export function resolveKeepBoth(text) {
  const out = [];
  let state = 'outside',
    seen = 0,
    ours = [],
    theirs = [];
  const merge = () => {
    const tagOf = line => line.match(/\s+(\/\/|#) forge-zoo \S+\s*$/)?.[0];
    if (ours.length === 1 && theirs.length === 1 && tagOf(ours[0]) && tagOf(theirs[0])) {
      const nl = ours[0].endsWith('\n') ? '\n' : '';
      out.push(ours[0].replace(/\s*\n?$/, '') + tagOf(theirs[0]).replace(/\n$/, '') + nl);
    } else out.push(...ours, ...theirs);
    ours = [];
    theirs = [];
  };
  for (const line of text.split(/(?<=\n)/)) {
    if (state === 'outside' && /^<{7}( |$)/.test(line)) {
      state = 'ours';
      seen++;
    } else if (state !== 'outside' && /^\|{7}( |$)/.test(line)) state = 'base';
    else if (state !== 'outside' && /^={7}\s*$/.test(line)) state = 'theirs';
    else if (state === 'theirs' && /^>{7}( |$)/.test(line)) {
      merge();
      state = 'outside';
    } else if (state === 'ours') ours.push(line);
    else if (state === 'theirs') theirs.push(line);
    else if (state === 'outside') out.push(line);
  }
  if (!seen) throw Error('ZOO_NO_CONFLICT_MARKERS');
  if (state !== 'outside') throw Error('ZOO_UNTERMINATED_CONFLICT');
  return out.join('');
}

/** Every value stored under `key` anywhere in a receipt, depth first. */
export function findAll(value, key, out = []) {
  if (Array.isArray(value)) for (const v of value) findAll(v, key, out);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (k === key) out.push(v);
      findAll(v, key, out);
    }
  return out;
}

/** The structured error code of a CLI receipt (error.code), or null. */
export const errorCode = receipt =>
  receipt?.error?.code ??
  findAll(receipt, 'error').find(e => e && typeof e === 'object' && e.code)?.code ??
  null;

/** What a land/check receipt says about its check: run ids, plan scope and reason, reuse, and
 * check timing. Tolerant of receipt shape: it reads named fields wherever they sit. */
export function checkFacts(receipt) {
  const strings = key => [...new Set(findAll(receipt, key).filter(v => typeof v === 'string'))];
  const timing = findAll(receipt, 'timing').filter(t => t && typeof t === 'object');
  const span = (a, b) =>
    timing.map(t => (Date.parse(t[b]) - Date.parse(t[a])) / 1000).filter(s => Number.isFinite(s) && s >= 0);
  const reused = findAll(receipt, 'reused').some(v => v === true || (v && typeof v === 'object'));
  return {
    runIds: strings('runId'),
    scopes: strings('scope'),
    reasons: strings('reason').slice(0, 8),
    reused,
    reuseFacts: findAll(receipt, 'reuse')
      .filter(v => v && typeof v === 'object')
      .slice(0, 3),
    ciSeconds: span('ciObservedAt', 'ciEndedAt')[0] ?? null,
    conflictPaths: [
      ...new Set(
        findAll(receipt, 'conflicts')
          .flat()
          .map(c => (typeof c === 'string' ? c : c?.path))
          .filter(p => typeof p === 'string'),
      ),
    ],
    state: strings('state').slice(0, 4),
    error: errorCode(receipt),
  };
}

/** GitHub-equivalent check minutes for the same flow: a pull-request run per pushed PR head
 * plus a merge-queue run per merge, each the measured full run. */
export function githubEquivalent({ fullRunSeconds, prPushes, merges }) {
  if (!Number.isFinite(fullRunSeconds)) return null;
  const runs = prPushes + merges;
  return { runs, minutes: Math.round(((runs * fullRunSeconds) / 60) * 10) / 10 };
}

const fmt = v =>
  v === null || v === undefined ? '–' : typeof v === 'number' ? String(Math.round(v * 10) / 10) : String(v);

/** One Markdown table row per repository and operation: Forge seconds next to plain git. */
export function summaryTable(results) {
  const ops = ['import', 'clone', 'save', 'sync', 'conflict', 'resolve', 'land', 'landReuse'];
  const rows = ['| Repo | Operation | Forge s | git s | Forge result |', '| --- | --- | --- | --- | --- |'];
  for (const r of results)
    for (const op of ops) {
      const s = r.steps?.[op];
      if (!s) continue;
      rows.push(
        `| ${r.id} | ${op} | ${fmt(s.forge?.seconds)} | ${fmt(s.git?.seconds)} | ${s.forge?.ok ? 'ok' : (s.forge?.refusal ?? s.forge?.error ?? 'not run')} |`,
      );
    }
  return rows.join('\n');
}
