// SPDX-License-Identifier: Apache-2.0
// Test-signal ratchet (ffbec6ef): a test guards a behaviour, a contract or an incident. Real sleeps,
// elapsed-time asserts and reads of docs/ text guard none of those: they flake on a loaded runner,
// and they fail on prose edits. Per test file this counts the three patterns and fails only when a
// count goes above its committed baseline (tests/test-signal-baseline.json). Counts are per source
// line, so a statement split over lines is counted by the line that holds the call.
//
//   node scripts/check-test-signal.mjs             check every test file (the standard check
//                                                  scans only the changed ones)
//   node scripts/check-test-signal.mjs --update    lower the baseline after deletions; never raises it
//   node scripts/check-test-signal.mjs --init      write the first baseline; refuses to overwrite one
//
// Exempt one line with `// test-signal: allow <reason>` on that line, or alone on the line above it.
// A bare marker without a reason exempts nothing. Findings name file, line numbers and pattern only;
// they never echo source.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SIGNAL_BASELINE = 'tests/test-signal-baseline.json';
export const SIGNAL_PATTERNS = ['sleep', 'elapsed', 'docs'];
const FIX = {
  sleep:
    'wait on the event or inject a clock or timer instead of a real sleep, or mark the line `// test-signal: allow <reason>`',
  elapsed:
    'assert the behaviour or a call-count budget, not wall time (inject a clock), or mark the line `// test-signal: allow <reason>`',
  docs: 'assert the behaviour the document describes, not its text (the documents check covers prose), or mark the line `// test-signal: allow <reason>`',
};

const ALLOW = /\/\/\s*test-signal:\s*allow\s+\S/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
const TIME_CALL = String.raw`(?:Date\.now\(\)|performance\.now\(\)|process\.hrtime\.bigint\(\)|\bnew Date\(\)\.getTime\(\))`;
const COMPARE = /[<>]=?/;
// A time call on either side of a subtraction, or a monotonic clock compared to a bound.
const TIME_DELTA = new RegExp(String.raw`${TIME_CALL}\s*-\s|\s-\s*${TIME_CALL}|performance\.now\(\)\s*[<>]`);
const ASSERT = /\bassert(?:\.\w+)?\(|\bt\.assert\w*\(|\bexpect\(/;
// `import { setTimeout as pause } from 'node:timers/promises'` makes `pause(` a sleep.
const SLEEP_NAMES = ['sleep', 'delay', 'pause', 'nap', 'snooze'];
const TIMER_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?timers\/promises['"]/g;

/** Names that sleep for this file: the common helper names plus `setTimeout`/`setInterval` aliases. */
function sleepNames(source) {
  const names = new Set(SLEEP_NAMES);
  for (const match of source.matchAll(TIMER_IMPORT))
    for (const part of match[1].split(',')) {
      const alias = /^\s*(?:setTimeout|setInterval|scheduler\.wait)\s+as\s+([\w$]+)\s*$/.exec(part);
      if (alias) names.add(alias[1]);
    }
  return [...names];
}

/** Variables assigned `<time call> - x` (directly or inside a call such as Math.round): an elapsed
 * time. A deadline (`Date.now() + 5000`) is not one. */
function deltaVariables(source) {
  const names = new Set();
  const assign = new RegExp(
    String.raw`([A-Za-z_$][\w$]*)\s*(?<![<>=!])=(?![=>])\s*(?:[\w$.]+\s*\(\s*)*\(*\s*${TIME_CALL}\s*-\s`,
    'g',
  );
  for (const match of source.matchAll(assign)) names.add(match[1]);
  return names;
}

const DOCS_PATH = [
  // Resolved from the test file: new URL('../docs/x.md', import.meta.url)
  /new URL\(\s*[`'"](?:\.\.?\/)+docs\b/,
  // Resolved from the repository root: readFileSync('docs/x.md'), resolve('docs/x.md')
  /\b(?:readFileSync|readFile|readdirSync|readdir|resolve|join)\(\s*[`'"](?:\.\.?\/)*docs\b/,
  // join(repo, 'docs/x.md'); a fixture project's `root` or `cwd` is not the repository.
  /\bjoin\(\s*(?:repo|repoRoot|rootDir|ROOT|REPO|projectRoot|process\.cwd\(\)|import\.meta\.dirname|__dirname)\s*,\s*(?:[`'"]\.\.[`'"]\s*,\s*)*[`'"]docs\b/,
];

/** Counts per pattern and the 1-based lines behind each count; allowed lines are not counted. */
export function signalCounts(source) {
  const lines = source.split('\n');
  const names = sleepNames(source);
  const calls = names.map(name => name.replace(/[$]/g, '\\$'));
  const sleepCall = new RegExp(
    String.raw`(?<![\w$.])(?:setTimeout|setInterval)\s*\(|\bAtomics\.wait\s*\(|(?<![\w$.]|function\s)(?:${calls.join('|')})\s*\(|\b(?:execSync|spawnSync|execFileSync)\(\s*['"\`]sleep\b`,
    'g',
  );
  const deltas = deltaVariables(source);
  const deltaName = deltas.size
    ? new RegExp(
        String.raw`(?<![\w$.])(?:${[...deltas].map(name => name.replace(/[$]/g, '\\$')).join('|')})(?![\w$])`,
      )
    : null;
  const found = { sleep: [], elapsed: [], docs: [] };
  lines.forEach((line, index) => {
    const number = index + 1;
    if (ALLOW.test(line) || (index > 0 && COMMENT.test(lines[index - 1]) && ALLOW.test(lines[index - 1])))
      return;
    if (COMMENT.test(line)) return;
    const sleeps = line.match(sleepCall);
    for (const _ of sleeps ?? []) found.sleep.push(number);
    if (ASSERT.test(line)) {
      const body = line.replace(/=>/g, '');
      if (COMPARE.test(body) && (TIME_DELTA.test(body) || (deltaName && deltaName.test(body))))
        found.elapsed.push(number);
    }
    if (DOCS_PATH.some(pattern => pattern.test(line))) found.docs.push(number);
  });
  return found;
}

export const countsOf = source =>
  Object.fromEntries(Object.entries(signalCounts(source)).map(([pattern, lines]) => [pattern, lines.length]));

export const emptyBaseline = () => ({ version: 1, files: {} });

export function readBaseline(root = '.') {
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, SIGNAL_BASELINE), 'utf8'));
    return parsed?.version === 1 && parsed.files && typeof parsed.files === 'object'
      ? parsed
      : emptyBaseline();
  } catch {
    return emptyBaseline();
  }
}

/** One finding per pattern whose count in this file went above its baseline. */
export function testSignalFindings(path, source, baseline) {
  const allowed = baseline?.files?.[path] ?? {};
  const found = signalCounts(source);
  return SIGNAL_PATTERNS.flatMap(pattern => {
    const limit = Number.isInteger(allowed[pattern]) ? allowed[pattern] : 0;
    const lines = found[pattern];
    if (lines.length <= limit) return [];
    return [
      `${path}:${[...new Set(lines)].join(',')}: ${lines.length} ${pattern} signal(s), baseline ${limit} (${LABEL[pattern]}); ${FIX[pattern]}`,
    ];
  });
}
const LABEL = {
  sleep: 'real sleeps or timer waits',
  elapsed: 'elapsed-time asserts',
  docs: 'reads of docs/ text',
};

/** A baseline with every count lowered to the current one (never raised); empty files are dropped. */
export function lowerBaseline(baseline, current) {
  const files = {};
  for (const path of Object.keys(baseline.files).sort()) {
    const counts = current.get(path);
    if (!counts) continue; // File deleted.
    const next = {};
    for (const pattern of SIGNAL_PATTERNS) {
      const value = Math.min(baseline.files[path][pattern] ?? 0, counts[pattern]);
      if (value > 0) next[pattern] = value;
    }
    if (Object.keys(next).length) files[path] = next;
  }
  return { version: 1, files };
}

/** A fresh baseline from the current counts (first adoption only). */
export function initialBaseline(current) {
  const files = {};
  for (const path of [...current.keys()].sort()) {
    const next = {};
    for (const pattern of SIGNAL_PATTERNS)
      if (current.get(path)[pattern] > 0) next[pattern] = current.get(path)[pattern];
    if (Object.keys(next).length) files[path] = next;
  }
  return { version: 1, files };
}

export function baselineTotals(baseline) {
  const totals = Object.fromEntries(SIGNAL_PATTERNS.map(pattern => [pattern, 0]));
  for (const counts of Object.values(baseline.files))
    for (const pattern of SIGNAL_PATTERNS) totals[pattern] += counts[pattern] ?? 0;
  return { ...totals, files: Object.keys(baseline.files).length };
}

export const isTestFile = path =>
  /^(?:tests|scripts|src|web|convex|netlify|evals|models)\/(?:.*\/)?[^/]+\.test\.[cm]?[jt]sx?$/.test(path) &&
  !path.includes('node_modules/');

/** Test files to scan: those among `changed` (repository paths), or all of `files` when nothing is
 * pinned or the baseline or this scanner changed. `files` maps repository path -> read function. */
export function scanSet(files, changed) {
  const all = [...files.keys()].filter(isTestFile);
  if (!changed) return all;
  if (changed.includes(SIGNAL_BASELINE) || changed.includes('scripts/check-test-signal.mjs')) return all;
  const set = new Set(changed);
  return all.filter(path => set.has(path));
}

/** Findings for the standard check: `files` is a Map of repository path -> source text. */
export function testSignalCheck(files, changed, baseline) {
  return scanSet(files, changed).flatMap(path => testSignalFindings(path, files.get(path), baseline));
}

const skip = new Set([
  '.git',
  'node_modules',
  'dist',
  'web-dist',
  'hosted-web-dist',
  'build',
  'coverage',
  '.forge',
  '.netlify',
]);
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (skip.has(entry.name)) return [];
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function loadTests(root) {
  const files = new Map();
  for (const file of walk(root)) {
    const path = relative(root, file).split(sep).join('/');
    if (isTestFile(path)) files.set(path, readFileSync(file, 'utf8'));
  }
  return files;
}

function main(argv) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = loadTests(root);
  const current = new Map([...files].map(([path, text]) => [path, countsOf(text)]));
  const target = resolve(root, SIGNAL_BASELINE);
  const baseline = readBaseline(root);
  const mode = argv.find(arg => arg.startsWith('--'));
  if (mode === '--init') {
    if (existsSync(target)) {
      console.error(
        `${SIGNAL_BASELINE} exists; --init only writes the first baseline. Use --update to lower it.`,
      );
      return 1;
    }
    const next = initialBaseline(current);
    writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Wrote ${SIGNAL_BASELINE}: ${JSON.stringify(baselineTotals(next))}`);
    return 0;
  }
  if (mode === '--update') {
    const next = lowerBaseline(baseline, current);
    writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `Lowered ${SIGNAL_BASELINE}: ${JSON.stringify(baselineTotals(baseline))} -> ${JSON.stringify(baselineTotals(next))}`,
    );
    const above = testSignalCheck(files, null, next);
    for (const finding of above) console.error(finding);
    return above.length ? 1 : 0;
  }
  if (mode) {
    console.error('Usage: node scripts/check-test-signal.mjs [--update | --init]');
    return 1;
  }
  const findings = testSignalCheck(files, null, baseline);
  for (const finding of findings) console.error(finding);
  console.log(
    `Test signal: ${JSON.stringify(baselineTotals(baseline))} baseline; ${findings.length} file/pattern(s) above it`,
  );
  return findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));
