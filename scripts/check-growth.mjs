// SPDX-License-Identifier: Apache-2.0
// Growth ratchet (Issue ed28fc6b): Forge grew by patching, and friction -> slice -> guard never removed
// anything. This counts the surfaces that pile up and fails when a count rises above the committed
// baseline (tests/growth-baseline.json) without a recorded reason. Static: it reads source text, runs no
// project code and makes no Convex call.
//
//   node scripts/check-growth.mjs                      check; prints the counts
//   node scripts/check-growth.mjs --print [--json]     print current / baseline / phase-start counts (phase close)
//   node scripts/check-growth.mjs --update             lower the baseline to the current counts; a rise needs --reason
//   node scripts/check-growth.mjs --update --reason "removes X / merges Y / nothing can go because Z"
//   node scripts/check-growth.mjs --init               write the first baseline; refuses to overwrite one
//
// What is counted (each is a distinct name, so renaming one is neutral and adding one is a rise):
//   tables         Convex tables: `name: defineTable(` in convex/*.ts (generated code excluded)
//   errorCodes     public error codes: an UPPER_SNAKE string literal (3+ characters, not a Node errno such as
//                  ENOTDIR) that reaches a caller as a structured error code, in src/, convex/ and netlify/:
//                  the first argument of `new ForgeError(`, the code argument of `invariant(cond, 'CODE', …)`,
//                  and a `code: 'CODE'` property. Test files are excluded. It counts a few result codes that
//                  are not thrown; the count is an upper bound, and the same rule applies to every run.
//   agentActions   agent action names in src/agent-verbs.ts: the lifecycle verbs, every mode flag's action,
//                  the board modes, the named reads and the operator actions
//   cliCommands    top-level commands dispatched in src/cli.ts (`args[0] === 'x'`, `command === 'x'`,
//                  `['a','b'].includes(args[0])` and `case 'x':`)
//   glossaryTerms  public glossary terms: the distinct bold terms in docs/concepts.md
//
// The baseline moves only through --update. A rise is recorded in its `reasons` ledger with the reason
// (what the change removes or merges, or why nothing can go); the check fails when a count is above the
// baseline or when the baseline is above its start plus the recorded rises (a hand edit).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GROWTH_BASELINE = 'tests/growth-baseline.json';
export const KINDS = ['tables', 'errorCodes', 'agentActions', 'cliCommands', 'glossaryTerms'];
const LABEL = {
  tables: 'Convex tables',
  errorCodes: 'public error codes',
  agentActions: 'agent actions',
  cliCommands: 'CLI commands',
  glossaryTerms: 'glossary terms',
};
const MIN_REASON = 12;

const strip = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const names = (source, pattern) => [...source.matchAll(pattern)].map(match => match[1]);

export function countTables(sources) {
  const found = new Set();
  for (const source of sources)
    for (const name of names(strip(source), /^\s*(\w+):\s*defineTable\(/gm)) found.add(name);
  return found.size;
}

const CODE = String.raw`([A-Z][A-Z0-9_]{2,})`;
const ERRNO = /^E[A-Z0-9]+$/;
export function errorCodes(source) {
  const text = strip(source);
  const found = [
    ...names(text, new RegExp(String.raw`new ForgeError\(\s*['"\`]${CODE}['"\`]`, 'g')),
    ...names(text, new RegExp(String.raw`\binvariant\([^;]*?,\s*['"\`]${CODE}['"\`]`, 'g')),
    ...names(text, new RegExp(String.raw`\bcode:\s*['"\`]${CODE}['"\`]`, 'g')),
  ];
  return found.filter(code => !ERRNO.test(code));
}
export const countErrorCodes = sources => new Set(sources.flatMap(errorCodes)).size;

export function agentActionNames(source) {
  const text = strip(source);
  const body = name => {
    const start = text.indexOf(`export const ${name}`);
    if (start < 0) return '';
    const end = text.indexOf(';\n', start);
    return text.slice(start, end < 0 ? undefined : end);
  };
  const quoted = name => names(body(name), /'([^']+)'/g);
  const flagged = name => names(body(name), /'--[\w-]+':\s*'([^']+)'/g);
  return new Set([
    ...quoted('lifecycleVerbs'),
    ...flagged('verbModes'),
    ...flagged('boardModes'),
    ...quoted('operatorActions'),
    ...quoted('namedReads'),
  ]);
}

export function cliCommandNames(source) {
  const text = strip(source);
  const found = new Set(names(text, /(?:args\[0\]|command)\s*===\s*'([a-z][\w-]*)'/g));
  for (const match of text.matchAll(/\[((?:\s*'[a-z][\w-]*',?)+)\s*\]\.includes\((?:args\[0\]|command)!?\)/g))
    for (const name of names(match[1], /'([^']+)'/g)) found.add(name);
  for (const name of names(text, /^\s*case '([a-z][\w-]*)':/gm)) found.add(name);
  found.delete('object'); // `typeof command === 'object'` is a type test, not a command.
  return found;
}

export function glossaryTerms(markdown) {
  return new Set(names(markdown, /\*\*([^*\n]+)\*\*/g).map(term => term.trim().toLowerCase()));
}

const skip = new Set(['_generated', 'node_modules']);
function sourceFiles(dir, root) {
  const base = resolve(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    if (skip.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, root);
    return /\.(?:ts|mts)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

/** Current counts from the repository at `root`. */
export function currentCounts(root = '.') {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const convex = sourceFiles('convex', root).map(read);
  const servers = [...sourceFiles('src', root), ...sourceFiles('netlify', root)].map(read);
  return {
    tables: countTables(convex),
    errorCodes: countErrorCodes([...servers, ...convex]),
    agentActions: agentActionNames(read('src/agent-verbs.ts')).size,
    cliCommands: cliCommandNames(read('src/cli.ts')).size,
    glossaryTerms: glossaryTerms(read('docs/concepts.md')).size,
  };
}

export function readBaseline(root = '.') {
  const baseline = JSON.parse(readFileSync(resolve(root, GROWTH_BASELINE), 'utf8'));
  if (baseline?.version !== 1 || !baseline.counts || !baseline.start || !Array.isArray(baseline.reasons))
    throw new Error(`${GROWTH_BASELINE} is not a version 1 growth baseline`);
  return baseline;
}

/** The recorded rises for one kind, in order. */
const rises = (baseline, kind) => baseline.reasons.filter(entry => entry.kind === kind);

/** Findings: counts above the baseline, and baselines above start plus recorded rises (hand edits). */
export function growthFindings(current, baseline) {
  const findings = [];
  for (const kind of KINDS) {
    const allowed = baseline.counts[kind];
    if (!Number.isInteger(allowed)) {
      findings.push(`${GROWTH_BASELINE}: no baseline count for ${kind}`);
      continue;
    }
    if (current[kind] > allowed)
      findings.push(
        `${LABEL[kind]}: ${current[kind]} now, baseline ${allowed}. Remove or merge one, or record why nothing can go: node scripts/check-growth.mjs --update --reason "<what the change removes or merges, or why nothing can go>"`,
      );
    const ceiling =
      (baseline.start[kind] ?? 0) +
      rises(baseline, kind).reduce((sum, entry) => sum + (entry.to - entry.from), 0);
    if (allowed > ceiling)
      findings.push(
        `${GROWTH_BASELINE}: ${kind} baseline ${allowed} is above its start ${baseline.start[kind]} plus recorded rises (${ceiling}); raise it only with --update --reason`,
      );
  }
  return findings;
}

/**
 * The baseline after --update. Counts below the baseline are lowered; counts above it are raised only
 * when `reason` is given, and each rise is appended to the ledger. Returns { baseline, refused }.
 */
export function updateBaseline(current, baseline, reason, at) {
  const next = structuredClone(baseline);
  const refused = [];
  const why = typeof reason === 'string' ? reason.trim() : '';
  for (const kind of KINDS) {
    if (current[kind] <= baseline.counts[kind]) next.counts[kind] = current[kind];
    else if (why.length >= MIN_REASON) {
      next.reasons.push({ kind, from: baseline.counts[kind], to: current[kind], reason: why, at });
      next.counts[kind] = current[kind];
    } else refused.push(kind);
  }
  return { baseline: next, refused };
}

export function initialBaseline(current, at) {
  return {
    version: 1,
    phase: 'P6',
    recordedAt: at,
    start: { ...current },
    counts: { ...current },
    reasons: [],
  };
}

export function formatCounts(current, baseline) {
  const rows = KINDS.map(
    kind =>
      `${LABEL[kind].padEnd(20)} ${String(current[kind]).padStart(5)} ${String(baseline.counts[kind]).padStart(8)} ${String(baseline.start[kind]).padStart(7)}`,
  );
  return [
    `${'Growth counts'.padEnd(20)} ${'now'.padStart(5)} ${'baseline'.padStart(8)} ${'start'.padStart(7)}`,
    ...rows,
  ].join('\n');
}

function main(argv) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const target = resolve(root, GROWTH_BASELINE);
  const flag = name => argv.includes(name);
  const reasonAt = argv.indexOf('--reason');
  const reason = reasonAt >= 0 ? argv[reasonAt + 1] : undefined;
  const current = currentCounts(root);
  const today = new Date().toISOString().slice(0, 10);
  if (flag('--init')) {
    if (existsSync(target)) {
      console.error(`${GROWTH_BASELINE} exists; --init only writes the first baseline. Use --update.`);
      return 1;
    }
    writeFileSync(target, `${JSON.stringify(initialBaseline(current, today), null, 2)}\n`);
    console.log(`Wrote ${GROWTH_BASELINE}: ${JSON.stringify(current)}`);
    return 0;
  }
  const baseline = readBaseline(root);
  if (flag('--update')) {
    const { baseline: next, refused } = updateBaseline(current, baseline, reason, today);
    writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
    console.log(formatCounts(current, next));
    for (const kind of refused)
      console.error(
        `${LABEL[kind]}: ${current[kind]} is above baseline ${baseline.counts[kind]}; pass --reason "<what the change removes or merges, or why nothing can go>" (at least ${MIN_REASON} characters) to record the rise.`,
      );
    return refused.length ? 1 : 0;
  }
  if (flag('--print')) {
    console.log(
      flag('--json')
        ? JSON.stringify({ current, baseline: baseline.counts, start: baseline.start })
        : formatCounts(current, baseline),
    );
    return 0;
  }
  if (argv.some(arg => arg.startsWith('--') && arg !== '--json')) {
    console.error(
      'Usage: node scripts/check-growth.mjs [--print [--json] | --update [--reason TEXT] | --init]',
    );
    return 1;
  }
  const findings = growthFindings(current, baseline);
  for (const finding of findings) console.error(finding);
  console.log(
    `Growth guard: ${KINDS.map(kind => `${kind} ${current[kind]}/${baseline.counts[kind]}`).join(', ')}`,
  );
  const slack = KINDS.filter(kind => current[kind] < baseline.counts[kind]);
  if (slack.length && !findings.length)
    console.log(
      `Below baseline (${slack.join(', ')}): run node scripts/check-growth.mjs --update to lower it.`,
    );
  return findings.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
