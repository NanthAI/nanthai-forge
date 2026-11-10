// SPDX-License-Identifier: Apache-2.0
// Growth ratchet (Issue ed28fc6b): Forge grew by patching, and friction -> slice -> guard never removed
// anything. This counts the surfaces that pile up and fails when a count rises above the committed
// baseline (tests/growth-baseline.json) without a recorded reason. Static: it reads source text, runs no
// project code and makes no Convex call.
//
//   node scripts/check-growth.mjs                      check; prints the counts
//   node scripts/check-growth.mjs --print [--json]     print current / baseline / phase-start counts (phase close)
//   node scripts/check-growth.mjs --print --machines [--json]  also list the machine dependencies and the hosted paths guarded
//   node scripts/check-growth.mjs --update             lower the baseline to the current counts; a rise needs --reason
//   node scripts/check-growth.mjs --update --reason "removes X / merges Y / nothing can go because Z"
//                                                      (a rise of unreferencedExports must name an 8-hex Forge Issue in the reason)
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
//   machineDependencies  entries in tests/machine-dependencies.json `machineDependencies` (Issue 56cf99cc):
//                  product paths (service, landing, checks, storage, mirror, deploys, release, backup) that need
//                  one specific machine. Target 0. Where the lead, builders, bench, optional local check runner
//                  and maintenance run is the user's choice and is not counted. Each entry has an Issue that
//                  removes it or a `staysBecause` reason; `hostedPaths` is the guarded list of paths that run
//                  hosted (moving one back onto a machine is a rise). Print the list with `--print --machines`.
//   unreferencedExports  exported names (function, const, class, enum, type, interface) declared in src/,
//                  web/src/, convex/ or netlify/ whose name appears nowhere else as a word in src, web/src,
//                  convex, netlify, tests, scripts or evals (comments and strings count as a mention, and a
//                  name that is common elsewhere is never flagged, so this undercounts). Public entry points
//                  are not counted: Convex query/mutation/action/httpAction functions (clients call them by
//                  address) and the package entry files src/index.ts, src/query.ts and src/cli-entry.ts.
//
// The baseline is phase start plus the deltas in tests/growth-ledger/. --update adds one hashed JSON
// file per changed kind, with the reason and date; no shared count or reasons array is rewritten.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GROWTH_BASELINE = 'tests/growth-baseline.json';
const LEDGER = 'tests/growth-ledger';
export const MACHINE_DEPENDENCIES = 'tests/machine-dependencies.json';
export const KINDS = [
  'tables',
  'errorCodes',
  'agentActions',
  'cliCommands',
  'glossaryTerms',
  'machineDependencies',
  'unreferencedExports',
];
const LABEL = {
  tables: 'Convex tables',
  errorCodes: 'public error codes',
  agentActions: 'agent actions',
  cliCommands: 'CLI commands',
  glossaryTerms: 'glossary terms',
  machineDependencies: 'machine dependencies',
  unreferencedExports: 'unreferenced exports',
};
const MIN_REASON = 12;
// A rise of these kinds must name the Forge Issue that removes it again (8-hex id), like a machine dependency
// (Issue ed28fc6b): the unreferenced export count was re-baselined from 19 to 68 with prose alone.
const ISSUE_KINDS = new Set(['unreferencedExports']);
const ISSUE_ID = /\b[0-9a-f]{8}\b/;
const issueOf = text => (typeof text === 'string' ? ISSUE_ID.exec(text)?.[0] : undefined);

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

const EXPORT_DECL =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|enum|type|interface)\s+([A-Za-z_$][\w$]*)([^\n]*)/gm;
const PUBLIC_FUNCTION =
  /^\s*=\s*(?:query|mutation|action|httpAction|sourceMutation|receiptMutation|withFinishReads)\s*[(<]/;
const ENTRY_FILES = new Set(['src/index.ts', 'src/query.ts', 'src/cli-entry.ts']);

/**
 * Names exported by `exporters` ({ path, text }) that no file in `exporters` or `others` mentions again.
 * A name declared twice still counts once; any further mention (even in a comment) keeps it.
 */
export function unreferencedExportNames(exporters, others = []) {
  const declared = new Map();
  for (const { path, text } of exporters) {
    if (ENTRY_FILES.has(path)) continue;
    for (const match of text.matchAll(EXPORT_DECL)) {
      if (path.startsWith('convex/') && PUBLIC_FUNCTION.test(match[2])) continue;
      declared.set(match[1], (declared.get(match[1]) ?? 0) + 1);
    }
  }
  const seen = new Map([...declared.keys()].map(name => [name, 0]));
  for (const { text } of [...exporters, ...others])
    for (const word of text.split(/[^\w$]+/)) {
      const count = seen.get(word);
      if (count !== undefined) seen.set(word, count + 1);
    }
  return new Set([...declared].filter(([name, sites]) => seen.get(name) <= sites).map(([name]) => name));
}

const scanSkip = new Set([...skip, 'dist', '.git', '.forge']);
function scanFiles(dir, root, pattern) {
  const base = resolve(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    if (scanSkip.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return scanFiles(path, root, pattern);
    return pattern.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : [];
  });
}

function countUnreferencedExports(root) {
  const read = path => ({ path, text: readFileSync(resolve(root, path), 'utf8') });
  const exporters = ['src', 'web/src', 'convex', 'netlify']
    .flatMap(dir => scanFiles(dir, root, /\.(?:ts|tsx|mts)$/))
    .filter(path => !/\.test\./.test(path))
    .map(read);
  const others = ['tests', 'scripts', 'evals']
    .flatMap(dir => scanFiles(dir, root, /\.(?:[cm]?js|[cm]?ts|tsx)$/))
    .map(read);
  return unreferencedExportNames(exporters, others).size;
}

export function readMachineDependencies(root = '.') {
  return JSON.parse(readFileSync(resolve(root, MACHINE_DEPENDENCIES), 'utf8'));
}

/** Problems with the machine dependency list: every entry needs a removing Issue or a reason, ids are unique. */
export function machineDependencyFindings(list) {
  if (list?.version !== 1 || !Array.isArray(list.machineDependencies) || !Array.isArray(list.hostedPaths))
    return [`${MACHINE_DEPENDENCIES} is not a version 1 machine dependency list`];
  const findings = [];
  const seen = new Set();
  const text = (value, min) => typeof value === 'string' && value.trim().length >= min;
  for (const entry of [...list.machineDependencies, ...list.hostedPaths]) {
    const id = entry?.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id) || seen.has(id))
      findings.push(
        `${MACHINE_DEPENDENCIES}: entry id ${JSON.stringify(id)} is missing, not kebab-case or repeated`,
      );
    else seen.add(id);
  }
  for (const entry of list.machineDependencies) {
    const hasIssue = typeof entry.issue === 'string' && /^[0-9a-f]{8}$/.test(entry.issue);
    if (!text(entry.what, MIN_REASON) || (!hasIssue && !text(entry.staysBecause, MIN_REASON)))
      findings.push(
        `${MACHINE_DEPENDENCIES}: ${entry.id} needs what, and an 8-hex Issue that removes it or a staysBecause reason`,
      );
    if (entry.issue !== undefined && !hasIssue)
      findings.push(`${MACHINE_DEPENDENCIES}: ${entry.id} issue must be an 8-character Forge Issue id`);
  }
  const needs = new Set(list.machineDependencies.map(entry => entry.id));
  for (const entry of list.hostedPaths)
    if (needs.has(entry.id) || !text(entry.how, MIN_REASON))
      findings.push(
        `${MACHINE_DEPENDENCIES}: hostedPaths ${entry.id} needs how, and cannot also be in machineDependencies`,
      );
  return findings;
}

export function formatMachineDependencies(list, current, baseline) {
  const row = entry =>
    `  ${entry.id.padEnd(22)} ${entry.issue ? `Issue ${entry.issue}` : 'stays'.padEnd(14)}  ${entry.what}`;
  return [
    `Machine dependencies: ${current.machineDependencies} now, baseline ${baseline.counts.machineDependencies}, start ${baseline.start.machineDependencies}`,
    ...list.machineDependencies.map(row),
    `Hosted paths guarded (${list.hostedPaths.length}): ${list.hostedPaths.map(entry => entry.id).join(', ')}`,
  ].join('\n');
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
    machineDependencies: readMachineDependencies(root).machineDependencies.length,
    unreferencedExports: countUnreferencedExports(root),
  };
}

const ledgerText = entry => `${JSON.stringify(entry, null, 2)}\n`;
const ledgerHash = text => createHash('sha256').update(text).digest('hex');

/** Each update adds unique, content-verified files, including identical deltas from different Lanes. */
export function writeLedger(root, entries) {
  mkdirSync(resolve(root, LEDGER), { recursive: true });
  return entries.map(entry => {
    const text = ledgerText(entry),
      name = `${entry.kind}-${randomUUID()}-${ledgerHash(text)}.json`;
    const path = resolve(root, LEDGER, name);
    writeFileSync(path, text, { flag: 'wx' });
    return name;
  });
}

export function readBaseline(root = '.') {
  const baseline = JSON.parse(readFileSync(resolve(root, GROWTH_BASELINE), 'utf8'));
  if (
    baseline?.version !== 2 ||
    typeof baseline.phase !== 'string' ||
    Object.keys(baseline).some(key => !['version', 'phase', 'start'].includes(key)) ||
    !KINDS.every(kind => Number.isInteger(baseline.start?.[kind]) && baseline.start[kind] >= 0)
  )
    throw new Error(
      `${GROWTH_BASELINE} must contain only version 2, phase and start; counts come from ${LEDGER}`,
    );
  const directory = resolve(root, LEDGER);
  const reasons = existsSync(directory)
    ? readdirSync(directory)
        .sort()
        .map(name => {
          const text = readFileSync(join(directory, name), 'utf8'),
            entry = JSON.parse(text);
          if (
            !KINDS.includes(entry.kind) ||
            !Number.isInteger(entry.delta) ||
            entry.delta === 0 ||
            typeof entry.reason !== 'string' ||
            entry.reason.trim().length < MIN_REASON ||
            !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
            Object.keys(entry).some(key => !['kind', 'delta', 'reason', 'date'].includes(key)) ||
            !name.startsWith(`${entry.kind}-`) ||
            !/^[a-zA-Z]+-[a-f0-9-]{36}-[a-f0-9]{64}\.json$/.test(name) ||
            !name.endsWith(`-${ledgerHash(text)}.json`)
          )
            throw new Error(`${LEDGER}/${name}: invalid entry or content hash; use --update`);
          return entry;
        })
    : [];
  const counts = { ...baseline.start };
  for (const { kind, delta } of reasons) counts[kind] += delta;
  return { ...baseline, counts, reasons };
}

/** Findings: counts above the ratchet, invalid reasons, and derived counts changed by hand. */
export function growthFindings(current, baseline) {
  const findings = [];
  for (const kind of KINDS) {
    const allowed = baseline.counts[kind];
    if (!Number.isInteger(allowed) || allowed < 0) {
      findings.push(`${GROWTH_BASELINE}: no valid baseline count for ${kind}`);
      continue;
    }
    if (current[kind] > allowed)
      findings.push(
        `${LABEL[kind]}: ${current[kind]} now, baseline ${allowed}. Remove or merge one, or record why nothing can go: node scripts/check-growth.mjs --update --reason "<what the change removes or merges, or why nothing can go>"`,
      );
    const entries = baseline.reasons.filter(entry => entry.kind === kind);
    for (const entry of entries)
      if (ISSUE_KINDS.has(kind) && entry.delta > 0 && !issueOf(entry.reason))
        findings.push(
          `${LEDGER}: the ${LABEL[kind]} rise +${entry.delta} names no Issue; a rise needs the 8-hex Issue that removes it: --update --reason "<what it removes, Issue ID>"`,
        );
    const expected = baseline.start[kind] + entries.reduce((sum, entry) => sum + entry.delta, 0);
    if (allowed !== expected)
      findings.push(
        `${GROWTH_BASELINE}: ${kind} baseline ${allowed} differs from its start ${baseline.start[kind]} plus recorded deltas (${expected}); change it only with --update`,
      );
  }
  return findings;
}

/** Lower counts freely; every rise still needs a reason, and unused exports also need an Issue. */
export function updateBaseline(current, baseline, reason, date) {
  const next = structuredClone(baseline),
    refused = [];
  const why = typeof reason === 'string' ? reason.trim() : '';
  for (const kind of KINDS) {
    const delta = current[kind] - baseline.counts[kind];
    if (!delta) continue;
    if (delta < 0 || (why.length >= MIN_REASON && (!ISSUE_KINDS.has(kind) || issueOf(why)))) {
      next.reasons.push({
        kind,
        delta,
        reason: why.length >= MIN_REASON ? why : 'Lower baseline to the current count',
        date,
      });
      next.counts[kind] = current[kind];
    } else refused.push(kind);
  }
  return { baseline: next, refused };
}

export function initialBaseline(current) {
  return { version: 2, phase: 'P6', start: { ...current }, counts: { ...current }, reasons: [] };
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
    const { counts, reasons, ...header } = initialBaseline(current);
    writeFileSync(target, `${JSON.stringify(header, null, 2)}\n`);
    console.log(`Wrote ${GROWTH_BASELINE}: ${JSON.stringify(current)}`);
    return 0;
  }
  const baseline = readBaseline(root);
  if (flag('--update')) {
    const { baseline: next, refused } = updateBaseline(current, baseline, reason, today);
    writeLedger(root, next.reasons.slice(baseline.reasons.length));
    console.log(formatCounts(current, next));
    for (const kind of refused)
      console.error(
        ISSUE_KINDS.has(kind)
          ? `${LABEL[kind]}: ${current[kind]} is above baseline ${baseline.counts[kind]}; pass --reason "<what removes it again>, Issue <8-hex id>" naming the Forge Issue that deletes the extra exports.`
          : `${LABEL[kind]}: ${current[kind]} is above baseline ${baseline.counts[kind]}; pass --reason "<what the change removes or merges, or why nothing can go>" (at least ${MIN_REASON} characters) to record the rise.`,
      );
    return refused.length ? 1 : 0;
  }
  if (flag('--print')) {
    const list = flag('--machines') ? readMachineDependencies(root) : undefined;
    console.log(
      flag('--json')
        ? JSON.stringify({ current, baseline: baseline.counts, start: baseline.start, machines: list })
        : [formatCounts(current, baseline), list && formatMachineDependencies(list, current, baseline)]
            .filter(Boolean)
            .join('\n\n'),
    );
    return 0;
  }
  if (argv.some(arg => arg.startsWith('--') && arg !== '--json')) {
    console.error(
      'Usage: node scripts/check-growth.mjs [--print [--machines] [--json] | --update [--reason TEXT] | --init]',
    );
    return 1;
  }
  const findings = [
    ...machineDependencyFindings(readMachineDependencies(root)),
    ...growthFindings(current, baseline),
  ];
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
