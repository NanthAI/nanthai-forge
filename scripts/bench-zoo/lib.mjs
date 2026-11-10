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
  '.cxx': '//',
  '.hh': '//',
  '.hpp': '//',
  '.hxx': '//',
  '.ts': '//',
  '.js': '//',
  '.mjs': '//',
  '.cjs': '//',
  '.cs': '//',
  '.swift': '//',
  '.dart': '//',
  '.php': '//',
  '.zig': '//',
  '.py': '#',
  '.rb': '#',
  '.ex': '#',
  '.exs': '#',
  '.sh': '#',
});

// Test, fixture and sample paths of every ecosystem the zoo covers (directory names are matched
// case-insensitively: Swift `Tests/`, Ruby `spec/`, JS `__tests__/`; file names by suffix).
const TEST_PATH =
  /(^|\/)(tests?|specs?|__tests__|testdata|fixtures?|examples?|samples?|benches|benchmarks?|docs?|vendor|third_party|node_modules)(\/|$)|(^|\/)[^/]*\.(unit|integration)?tests?(\/|$)|_(test|spec)\.(go|rb|exs?|dart|php|rs|py)$|(^|\/)test_[^/]*\.py$|(^|\/)(tests?|specs?)\.[^/]+$|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.(kt|java|cs|swift|php)$/i;
const SHORT_LINE = 60;
const ext = path => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
};
const dir = path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The paths a `.gitmodules` text declares. Files below them belong to another repository: an edit
 * there is not a change of this one (Forge refuses it with NOTHING_TO_LAND, as git would commit
 * nothing), so the probe never picks them. */
export const submodulePaths = text =>
  [...String(text).matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map(m => m[1].replace(/\/+$/, ''));

/** Two non-test source files in different directories (two packages where the layout has them),
 * chosen deterministically: the most common source extension wins, then the shallowest, then
 * lexical order. Returns { ext, first, second } or null when the tree has no editable source.
 * `files` is [{ path, size, symlink? }]. */
export function pickProbeFiles(files) {
  const editable = f =>
    !f.symlink &&
    COMMENT[ext(f.path)] &&
    !f.path.includes('\ufffd') && // a name that is not valid UTF-8 cannot be addressed on both sides
    !f.path.startsWith('.') &&
    !f.path.includes('/.') &&
    (f.size ?? 0) > 0 &&
    (f.size ?? 0) < 512 * 1024;
  const candidates = files.filter(f => editable(f) && !TEST_PATH.test(f.path));
  // A repository whose only source beyond one file is its tests (a one-module library) still gets
  // a second probe: a test file of the same extension, chosen last.
  const testFiles = files.filter(f => editable(f) && TEST_PATH.test(f.path));
  if (!candidates.length) return null;
  const counts = new Map();
  for (const f of candidates) counts.set(ext(f.path), (counts.get(ext(f.path)) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const depth = p => p.split('/').length;
  const byDepth = (a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0);
  const ordered = candidates
    .filter(f => ext(f.path) === top)
    .map(f => f.path)
    .sort(byDepth);
  const first = ordered[0];
  const second =
    ordered.find(p => dir(p) !== dir(first)) ??
    ordered.find(p => p !== first) ??
    testFiles
      .filter(f => ext(f.path) === top)
      .map(f => f.path)
      .sort(byDepth)[0] ??
    null;
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
  // The last non-blank line short enough that a trailing comment keeps it inside a formatter's
  // line limit (spotless, ktlint, rustfmt and gofmt-style checks reject a long line with a
  // comment appended); the last non-blank line when none is short.
  const short = line => line.trim() && line.replace(/\s+$/, '').length <= SHORT_LINE;
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i < 0) throw Error(`ZOO_EMPTY_FILE ${path}`);
  let pick = i;
  while (pick >= 0 && !short(lines[pick])) pick--;
  if (pick >= 0) i = pick;
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
/** The CLI build (State id) that `release-number.json` of the installed CLI names, or null. The
 * auto-updating CLI keeps this file next to its `current` checkout; no receipt carries a CLI id. */
export function cliHead(releaseJsonText) {
  try {
    const head = JSON.parse(releaseJsonText)?.head;
    return typeof head === 'string' && /^[0-9a-f]{8,64}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

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
/** A land that has not settled: IN PROGRESS (exit 3), or the asynchronous SUBMITTED receipt (exit 0,
 * `inProgress: true`), both followed with the blocking wait on the original operation id. */
export const landPending = res => res.code === 3 || findAll(res.json, 'inProgress').some(v => v === true);

/** The land receipt's preflight block (affected-test selection): status, what was selected and
 * how many tests, or null when the receipt carries none. */
export function preflightFacts(receipt) {
  // A `preflight` action's receipt: the plan names the scope, the selected test files or package
  // commands, and why (`result.plan`).
  const plan = findAll(receipt, 'plan').find(v => v && Array.isArray(v.tests) && 'scope' in v);
  if (plan)
    return {
      status: plan.status ?? null,
      scope: plan.scope ?? null,
      selected: plan.tests.slice(0, 8),
      tests: plan.tests.length,
      estimateMinutes: plan.estimateMinutes ?? null,
      reason: typeof plan.reason === 'string' ? plan.reason.slice(0, 240) : null,
    };
  const p =
    findAll(receipt, 'preflight').find(v => v && typeof v === 'object' && !Array.isArray(v)) ??
    findAll(receipt, 'result').find(v => v && typeof v === 'object' && Array.isArray(v.selected));
  if (!p) return null;
  return {
    status: p.status ?? null,
    selected: Array.isArray(p.selected) ? p.selected.slice(0, 8) : [],
    tests: p.tests ?? null,
    estimateMinutes: p.estimateMinutes ?? null,
    reason: typeof p.reason === 'string' ? p.reason.slice(0, 200) : null,
  };
}

/** What a runner workflow says about the control code it runs: the `repository` and `ref` of its
 * checkout step with `path: control`, and whether the ref is a pinned commit/digest rather than
 * the workflow's own sha. Reads the workflow text only. */
export function controlCodeSource(workflowText) {
  const lines = String(workflowText).split('\n');
  const at = lines.findIndex(l => /^\s*path:\s*control\s*$/.test(l));
  if (at < 0) return null;
  const indent = lines[at].length - lines[at].trimStart().length;
  const sibling = i => {
    const l = lines[i];
    return l !== undefined && l.trim() !== '' && l.length - l.trimStart().length === indent;
  };
  const block = [];
  for (let i = at; sibling(i); i--) block.push(lines[i]);
  for (let i = at + 1; sibling(i); i++) block.push(lines[i]);
  const value = key =>
    block.map(l => l.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`))?.[1]).find(Boolean) ?? null;
  const ref = value('ref');
  return {
    repository: value('repository') ?? 'the runner repository itself',
    ref,
    byDigest: Boolean(ref && /^[0-9a-f]{40,64}$/.test(ref.replace(/['"]/g, ''))),
  };
}

export function checkFacts(receipt) {
  const strings = key => [...new Set(findAll(receipt, key).filter(v => typeof v === 'string'))];
  const timing = findAll(receipt, 'timing').filter(t => t && typeof t === 'object');
  const span = (a, b) =>
    timing.map(t => (Date.parse(t[b]) - Date.parse(t[a])) / 1000).filter(s => Number.isFinite(s) && s >= 0);
  const reused = findAll(receipt, 'reused').some(v => v === true || (v && typeof v === 'object'));
  return {
    runIds: strings('runId'),
    preflight: preflightFacts(receipt),
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
