// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import { posix, join } from 'node:path';
import { testImportGraph } from './test-import-graph.mjs';
import { watchRanking } from './test-name-watchers.mjs';
import { closenessIndex, compareRank } from './test-closeness.mjs';
import { changeSalt, compareRelevance, relevanceFor, stableKey } from './test-tiebreak.mjs';
import { coverageShadow } from './test-coverage.mjs';
import { classifyCheckPath, webTest } from './check-path-scopes.mjs';
import { guardSelection } from './selection-guard.mjs';
import { docsPackager, docsWrapper, scriptPath, scriptSelectionReason } from './script-impact.mjs';
import { docsReaders } from './docs-readers.mjs';
import { scanDetail, scanReaders } from './test-tree-scanners.mjs';

export const smokeTests = [
  'tests/files.test.mjs',
  'tests/ci-scope.test.mjs',
  'tests/test-impact.test.mjs',
  'tests/check-path-scopes.test.mjs',
  // Any src, web or convex change can pull Node-only code into the browser bundle.
  'tests/web-bundle-node-free.test.mjs',
];
export const documentation = path => /^(?:docs\/.+|[^/]+)\.md$/.test(path);
export const safePath = path =>
  typeof path === 'string' &&
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.split('/').some(part => ['', '.', '..'].includes(part)) &&
  !/[\x00-\x1f\x7f\ufffd\\*?\[\]{}!]/.test(path);

export const selectionSourcePath = path =>
  ['package.json', 'package-lock.json'].includes(path) ||
  /^(?:src|web|convex|netlify|tests|scripts)\/.+\.(?:[cm]?js|[cm]?tsx?|css|json|svg|html)$/.test(path);

export function sourceFiles(root = '.') {
  const files = new Map();
  function walk(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (selectionSourcePath(path)) files.set(path, readFileSync(join(root, path), 'utf8'));
    }
  }
  for (const dir of ['src', 'web', 'convex', 'netlify', 'tests', 'scripts']) walk(dir);
  files.set('package.json', readFileSync(join(root, 'package.json'), 'utf8'));
  files.set('package-lock.json', readFileSync(join(root, 'package-lock.json'), 'utf8'));
  return files;
}

/** Static imports plus literal runtime source paths used by moduleUrl/readFile/CLI tests.
 * Nonliteral paths widen to their entire source domain, never prove independence. */
export function selectTests(input, graphCache) {
  return selectWithGraph(input, undefined, graphCache);
}
/** Paired independence analysis parses one graph per immutable inventory.
 * Changed-script uncertainty is widened across both comparisons. */
export function selectImpactPair(files, comparisons) {
  const scripts = [...new Set(comparisons.flat())]
    .filter(path => scriptPath(path) && files.has(path))
    .map(path => ({ path }));
  const graph = testImportGraph(files, scripts);
  return comparisons.map(paths =>
    paths.length
      ? selectWithGraph({ paths, files }, graph)
      : {
          scope: 'docs',
          reason: 'No paths in this inventory',
          tests: [],
          affectedTests: [],
        },
  );
}
/** Local execution is a partition of complete landing coverage, never an independence proof.
 * Tiers, most relevant first (also the run order under the wall-time budget): mandatory (changed
 * tests, explicit coverage, smoke, declared guards); learned (tests that failed in a landing check or
 * preflight for a changed path); direct (tests that run a changed module: they load it, directly or
 * through test fixtures, or load a module that imports it, directly or through fixtures, the
 * "fixture-reached" consumers; or are named for it); wide (the same consumers of a hub module most
 * tests load, recent failures first among equals); recent (tests that run a changed module within two
 * product modules and failed in a landing check under other paths lately); name watchers (tests that match a distinctive
 * name in a changed source, at any import distance: an import graph cannot see a test that hooks the
 * paths a module creates); then tests two product modules away (`near`). Within each, the most specific
 * consumers come first (fewest product modules between, then a fixture few tests use before a shared
 * harness), then, among equally close tests, a recent landing failure, how much the test's name and
 * text are about the changed modules, and a stable hash (`test-tiebreak.mjs`), never the file name.
 * Mandatory, learned and direct are protected: the plan never trims them. Nothing here
 * counts files: the whole neighbourhood is returned, and `fitPreflightBudget` trims the unprotected
 * tiers by time, least relevant last. Other uncertain and distant consumers (dynamic, domain, a
 * by-name loader's closure, three or more edges) stay explicit pre-queue/landing work. A
 * comment-only path (`commentOnly`, bytes equal to its base outside comments) runs nothing new: it
 * adds only the tests that read its text. A docs-only change parses no graph: it runs only the tests
 * that read a changed document (`docsReaders`), beside the static checks. The landing check selects the
 * same readers (`withDocsReaders`, one shared selector). */
export const preflightTierRule =
  'changed tests, explicit coverage and smoke; then tests that failed for these paths before; then tests that run a changed module directly, through a test fixture or through one module that imports it, or are named for it (never trimmed, most specific first); then the same consumers of hub modules (their direct tests would push protected tests past the budget; closest first); then tests that run a changed module within two modules and failed in a landing check lately; then tests that watch a distinctive name in a changed source; then tests that run a changed module through two modules, most specific first; comment-only edits add only tests that read the file; a docs-only change runs only the tests that read the changed documents';
/** Tiers the time budget never trims from the plan; the run starts them first. */
export const protectedTiers = new Set(['mandatory', 'learned', 'direct']);
const testFile = path => /^tests\/[^/]+\.test\.mjs$/.test(path);
const moduleName = path => posix.basename(path).replace(/(?:\.test)?\.[cm]?[jt]sx?$/, '');
const wordCache = new Map();
const words = name => {
  if (!wordCache.has(name)) wordCache.set(name, splitWords(name));
  return wordCache.get(name);
};
const splitWords = name =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/** A test is named for a module when its name is the module's name, or the module's trailing words
 * (at least two): `hosted-landing-cancel.test.mjs` for `convex/projectHostedLandingCancel.ts`. */
const namedFor = (test, modules) => {
  const name = moduleName(test);
  if (modules.has(name)) return true;
  const own = words(name);
  if (own.length < 2) return false;
  for (const module of modules) {
    const theirs = words(module);
    if (theirs.length > own.length && own.every((word, i) => theirs[theirs.length - own.length + i] === word))
      return true;
  }
  return false;
};
export function selectPreflightTests(input, graphCache = {}) {
  // The consumers-only pass reads the same inventory, so it reuses the graph the first pass built.
  const selection = selectTests(input, graphCache);
  if (selection.scope === 'docs') {
    const readers = docsReaders(input.files, input.paths);
    const tests = [...readers.keys()].sort();
    return {
      ...selection,
      tests,
      tiers: [{ tier: 'mandatory', tests }],
      docsReaders: Object.fromEntries(tests.map(test => [test, readers.get(test)])),
      deferredTests: [],
      reason: `${selection.reason}; local: ${
        tests.length
          ? `the ${tests.length} test file(s) that read a changed document`
          : 'no test reads a changed document'
      }, beside the static checks; the landing check runs the same readers and the documents checks`,
    };
  }
  const commentOnly = new Set((input.commentOnly ?? []).filter(path => input.paths.includes(path)));
  const behavioural = input.paths.filter(path => !commentOnly.has(path));
  // Ranking reads only the paths whose behaviour can change and that the graph can place; coverage
  // (`selection`) keeps them all. A path that makes coverage full (a manifest, an unclassified file)
  // must not cost the rest of the change its ranking: the graph still ranks the other paths' consumers.
  const rankable = behavioural.filter(path => documentation(path) || classifyCheckPath(path, input.files));
  const consumers = !rankable.length
    ? { tests: [], reasons: {} }
    : selection.scope === 'full' || commentOnly.size || rankable.length < behavioural.length
      ? selectWithGraph({ ...input, paths: rankable, consumersOnly: true }, undefined, graphCache)
      : selection;
  const changed = new Set(behavioural);
  const rankedPaths = rankable.filter(path => !testFile(path) && !documentation(path));
  const allTests = [...input.files.keys()].filter(testFile).sort();
  const kind = test => consumers.reasons?.[test]?.kind;
  const distance = test => consumers.reasons?.[test]?.edges?.length ?? Infinity;
  const guards = new Set((input.guards ?? []).filter(test => input.files.has(test)));
  const mandatory = test =>
    changed.has(test) || smokeTests.includes(test) || guards.has(test) || kind(test) === 'explicit';
  const learned = new Set((input.learned ?? []).filter(test => input.files.has(test) && !mandatory(test)));
  const covered = new Set(selection.tests);
  const named = new Set(
    behavioural
      .filter(path => !testFile(path) && !documentation(path))
      .map(moduleName)
      .filter(Boolean),
  );
  const direct = new Set(),
    wide = new Set();
  const rank = new Map();
  const offer = (test, value) => {
    if (!rank.has(test) || compareRank(value, rank.get(test)) < 0) rank.set(test, value);
  };
  // Direct tests are protected module by module, most specific module (fewest tests that load it)
  // first, while the cost of those loaders fits `hubBudget.seconds`. A module whose loaders would
  // push past it is broad (a hub or a shared harness every test uses): its consumers are ranked
  // (`wide`), not protected, so one shared-helper change does not turn preflight into the full
  // suite. Fixture-reached consumers (one module between) follow their module and never make it
  // broad. Named tests stay protected. Without a budget (preflight trim:false) every module's
  // consumers are protected.
  const graph = graphCache.graph;
  const index = graph?.reverse ? closenessIndex(graph) : null;
  const eligible = test => covered.has(test) && !mandatory(test) && !learned.has(test);
  const far = new Map();
  const modules = index
    ? [
        ...rankedPaths.map(path => {
          const all = [...index.consumers(path, { maxHops: 2 })];
          // Two modules between: ranked last (`near`), and close enough for a recent failure.
          for (const [test, value] of all) if (value[0] === 2) far.set(test, value);
          return { path, tests: all.filter(([, value]) => value[0] < 2) };
        }),
        // A comment-only edit runs the same tokens: only tests that read the file's text reach it.
        ...[...commentOnly].map(path => ({ path, tests: [...index.consumers(path, { readers: true })] })),
      ]
        .map(item => ({ ...item, tests: item.tests.filter(([test]) => eligible(test)) }))
        .filter(item => item.tests.length)
        .map(item => ({ ...item, loaders: item.tests.filter(([, value]) => value[0] === 0).length }))
        .sort((a, b) => a.loaders - b.loaders || (a.path < b.path ? -1 : 1))
    : [];
  const cost = test => input.hubBudget?.secondsFor(test) ?? 0;
  let spent = 0;
  const broad = [];
  for (const { path, tests } of modules) {
    for (const [test, value] of tests) offer(test, value);
    const added = tests.map(([test]) => test).filter(test => !direct.has(test));
    const extra = tests
      .filter(([test, value]) => value[0] === 0 && !direct.has(test))
      .reduce((sum, [test]) => sum + cost(test), 0);
    if (input.hubBudget && spent + extra > input.hubBudget.seconds) {
      broad.push(path);
      for (const test of added) wide.add(test);
      continue;
    }
    spent += extra;
    for (const test of added) {
      direct.add(test);
      wide.delete(test);
    }
  }
  for (const test of consumers.tests ?? []) {
    if (!covered.has(test)) continue;
    if (namedFor(test, named)) {
      direct.add(test);
      wide.delete(test);
      offer(test, [0, 1, 0]);
    }
    // Without a graph the selector's own one-edge reason still counts.
    else if (!index && kind(test) === 'dependency' && distance(test) === 1) direct.add(test);
  }
  // Tests that failed in a landing check under other paths, not these: the failure proves the test
  // guards its region, not that this change reaches it. Only tests that run a changed module within
  // two product modules qualify (a computed path, a by-name closure or a chain through the backend's
  // shared wrapper is coverage, not evidence that the test runs this code).
  // Without a graph, only the selector's own dependency chain of at most two edges is evidence.
  const reaches = index
    ? test => direct.has(test) || wide.has(test) || far.has(test)
    : test => kind(test) === 'dependency' && distance(test) <= 2;
  const recentFailed = new Set(
    (input.recent ?? []).filter(
      test => covered.has(test) && !mandatory(test) && !learned.has(test) && reaches(test),
    ),
  );
  const recent = new Set([...recentFailed].filter(test => !direct.has(test) && !wide.has(test)));
  // Rarity is measured over every test in the inventory; only landing-covered tests are promoted.
  const watchers = watchRanking({
    files: input.files,
    tests: allTests,
    candidates: (consumers.tests ?? []).filter(
      test =>
        covered.has(test) &&
        !mandatory(test) &&
        !learned.has(test) &&
        !direct.has(test) &&
        !recent.has(test) &&
        !wide.has(test),
    ),
    changed: behavioural,
  });
  const tierOf = test =>
    mandatory(test)
      ? 'mandatory'
      : learned.has(test)
        ? 'learned'
        : direct.has(test)
          ? 'direct'
          : wide.has(test)
            ? 'wide'
            : recent.has(test)
              ? 'recent'
              : watchers.has(test)
                ? 'watch'
                : (index ? far.has(test) : kind(test) === 'dependency' && distance(test) === 2) &&
                    covered.has(test)
                  ? 'near'
                  : null;
  // A named test, or one ranked without a graph, counts as a specific loader.
  const rankOf = test => rank.get(test) ?? [0, 1, 0];
  // Equally close tests order by relevance (a recent landing failure, then how much the test is
  // about the changed modules), then a stable hash: never by file name, so adding a test file can
  // not move a relevant one out of the time budget (Issue 964e2d2b).
  const relevance = relevanceFor({ files: input.files, changed: rankedPaths, recent: recentFailed });
  const salt = changeSalt(input.paths);
  const keyOf = new Map();
  const key = test => (keyOf.has(test) ? keyOf.get(test) : keyOf.set(test, stableKey(salt, test)).get(test));
  const tied = (a, b) => compareRelevance(relevance(a), relevance(b)) || (key(a) < key(b) ? -1 : 1);
  const byRank = (a, b) => compareRank(rankOf(a), rankOf(b)) || tied(a, b);
  const ranked = tier => {
    // A learned test may sit outside this path's graph selection: that miss is why it was learned.
    // A project-declared guard runs even where the import graph does not reach them: that is why it is declared.
    const pool =
      tier === 'learned'
        ? [...learned].sort()
        : tier === 'mandatory'
          ? [...new Set([...selection.tests, ...guards])]
          : tier === 'direct' || tier === 'wide'
            ? [...(tier === 'direct' ? direct : wide)]
            : tier === 'near' && index
              ? [...far.keys()]
              : selection.tests;
    const tests = pool.filter(test => tierOf(test) === tier);
    if (tier === 'watch')
      return tests.sort((a, b) => watchers.get(b).score - watchers.get(a).score || tied(a, b));
    // Closest first; among equally close tests, a recent landing failure, then relevance, then hash.
    if (tier === 'direct' || tier === 'near' || tier === 'wide' || tier === 'recent')
      return tests.sort(byRank);
    return tests.sort();
  };
  for (const [test, value] of far) if (!rank.has(test)) rank.set(test, value);
  const tiers = ['mandatory', 'learned', 'direct', 'wide', 'recent', 'watch', 'near'].map(tier => ({
    tier,
    tests: ranked(tier),
  }));
  const local = new Set(tiers.flatMap(item => item.tests));
  return {
    ...selection,
    tests: tiers.flatMap(item => item.tests),
    tiers,
    broadModules: broad,
    ...(commentOnly.size ? { commentOnly: [...commentOnly].sort() } : {}),
    /** Rank of each direct and wide test ([product hops, carrier fan-in, helper hops]). */
    ranks: Object.fromEntries([...local].filter(test => rank.has(test)).map(test => [test, rank.get(test)])),
    /** Tie-break tuple of each local direct, wide, recent and near test: [recent failure, name affinity, mentions]. */
    relevance: Object.fromEntries(
      tiers
        .filter(item => ['direct', 'wide', 'recent', 'near'].includes(item.tier))
        .flatMap(item => item.tests.map(test => [test, relevance(test)])),
    ),
    recentFailed: [...recentFailed].sort(),
    watchedNames: Object.fromEntries([...watchers].map(([test, item]) => [test, item.names])),
    deferredTests: selection.tests.filter(test => !local.has(test)),
    reason: `${selection.reason}; local: ${preflightTierRule}; the rest runs in the pre-queue check`,
  };
}

/** Time-budget trim of ranked tiers. Protected tiers (mandatory, learned, direct) always run. Each
 * later tier keeps a prefix that fits; once a tier is cut, every farther tier is deferred whole, so a
 * distance-2 test never runs while a nearer consumer waits. `free` tests (already passed for this
 * source) cost nothing. Returns what was cut and why; a cut is never silent. */
export function fitPreflightBudget({
  tiers,
  budgetSeconds,
  secondsPerFile,
  secondsFor = () => secondsPerFile,
  free = new Set(),
}) {
  const cost = tests =>
    tests.filter(test => !free.has(test)).reduce((sum, test) => sum + secondsFor(test), 0);
  const kept = [];
  const trimmed = [];
  let used = 0;
  let cut = false;
  for (const { tier, tests } of tiers) {
    if (protectedTiers.has(tier)) {
      kept.push(...tests);
      used += cost(tests);
      continue;
    }
    const deferred = [];
    for (const test of tests) {
      if (free.has(test)) kept.push(test);
      else if (!cut && used + secondsFor(test) <= budgetSeconds) {
        kept.push(test);
        used += secondsFor(test);
      } else {
        cut = true;
        deferred.push(test);
      }
    }
    if (deferred.length)
      trimmed.push({
        tier,
        kept: tests.length - deferred.length,
        total: tests.length,
        deferred,
      });
  }
  const mandatory = tiers.find(item => item.tier === 'mandatory')?.tests ?? [];
  const guarded = tiers.filter(item => protectedTiers.has(item.tier)).flatMap(item => item.tests);
  return {
    tests: kept,
    trimmed,
    estimateSeconds: Math.ceil(used),
    mandatoryOverBudget: cost(mandatory) > budgetSeconds,
    protectedOverBudget: cost(guarded) > budgetSeconds,
  };
}

/** `graphCache` is an optional caller-owned `{}`: calls for one immutable inventory and one path
 * list may share it so the import graph is parsed once. Never reuse it across inventories or paths. */
function selectWithGraph(
  { paths, files, forceFull = false, consumersOnly = false },
  suppliedGraph,
  graphCache = {},
) {
  const tests = [...files.keys()].filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path)).sort();
  const full = reason => explainAll({ scope: 'full', reason, tests });
  if (forceFull) return full('FORGE_CHECK_FULL=1');
  if (!Array.isArray(paths) || !paths.length || paths.some(path => !safePath(path)))
    return full('Missing, empty or invalid pinned comparison');
  if (paths.every(documentation))
    return {
      scope: 'docs',
      reason: 'Only Markdown documentation changed (including packaged docs)',
      tests: [],
    };
  const classifications = [];
  for (const path of [...new Set(paths)].sort()) {
    if (documentation(path)) continue;
    const classification = classifyCheckPath(path, files);
    if (!classification) return full(`Unclassified or deleted path: ${path}`);
    classifications.push({
      path,
      ...classification,
      seeds: classification.seeds.sort(),
    });
  }
  const scriptsChanged = classifications.filter(item => scriptPath(item.path) && files.has(item.path));
  const graph = suppliedGraph ?? (graphCache.graph ||= testImportGraph(files, scriptsChanged));
  if (graph.error) return full(graph.error);
  const { reverse, evidence, packageGraph, workspaceUsers } = graph;
  // Product source is data to the static tools (build, typecheck, lint, format,
  // schema, package smoke), which run on every exact Candidate. Its chains stop at
  // those commands, and at those tools when the tool reads it rather than imports it.
  const fenced = (item, importer, edge) =>
    productSource(item.changedPath) &&
    (packageGraph.staticCommands?.has(importer) ||
      (packageGraph.staticTools?.has(importer) && edge.kind !== 'import'));
  // The docs-check wrapper only spawns the docs check; the runner importing it is not a consumer.
  const affected = new Map();
  // Workspace-path edges wait here; they reach only code that makes this repository a workspace.
  const held = new Map();
  const step = (previous, edge, importer) => ({
    kind: previous.kind === 'dynamic' || edge.kind === 'dynamic' ? 'dynamic' : 'dependency',
    changedPath: previous.changedPath,
    chain: [...previous.chain, importer],
    edges: [...previous.edges, edge.kind],
    ...(edge.detail || previous.detail ? { detail: edge.detail ?? previous.detail } : {}),
  });
  const walk = (queue, blocked) => {
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      if (blocked && docsWrapper(current)) continue;
      const previous = affected.get(current) ?? held.get(current);
      const holding = !affected.has(current);
      for (const importer of reverse.get(current) ?? []) {
        if (affected.has(importer) || (holding && held.has(importer))) continue;
        const edge = evidence.get(current).get(importer);
        if (fenced(previous, importer, edge)) continue;
        const entry = step(previous, edge, importer);
        if ((holding || edge.kind === 'workspace-path') && !workspaceUsers?.has(importer)) {
          if (held.has(importer)) continue;
          held.set(importer, entry);
        } else affected.set(importer, entry);
        queue.push(importer);
      }
    }
  };
  const spread = (items, blocked) => {
    const queue = [];
    for (const item of items)
      for (const seed of item.seeds) {
        if (affected.has(seed)) continue;
        affected.set(seed, {
          kind: seed === item.path ? 'changed' : 'domain',
          changedPath: item.path,
          chain: seed === item.path ? [seed] : [item.path, seed],
          edges: [],
          ...(item.reason ? { detail: item.reason } : {}),
        });
        queue.push(seed);
      }
    walk(queue, blocked);
  };
  spread(
    classifications.filter(item => !docsPackager(item.path)),
    false,
  );
  spread(
    classifications.filter(item => docsPackager(item.path)),
    true,
  );
  for (const item of scriptsChanged) {
    const evidence = scriptSelectionReason(item, packageGraph.roots, tests, reverse);
    if (evidence.full && !consumersOnly) return full(evidence.full);
    item.tests = [...(item.tests ?? []), ...(evidence.tests ?? [])];
    item.reason = evidence.reason;
  }
  for (const item of classifications) {
    if (item.requireConsumer && !hasTestConsumer(item.path, reverse, tests)) {
      // Fixtures used only by standalone measurement tooling have no test to run; static
      // checks cover them. Anything unused, or reaching the pipeline or product, stays full.
      const users = importersOf(item.path, reverse);
      if (
        users.size &&
        ![...users].some(
          path => packageGraph.roots?.has(path) || /^(?:src|web\/src|convex|netlify)\//.test(path),
        )
      )
        continue;
      return full(`No known consuming test for helper or fixture: ${item.path}`);
    }
  }
  const webChanged = classifications.some(
    item => item.domain === 'web' || item.seeds.some(path => path.startsWith('web/')),
  );
  const explicit = new Set(classifications.flatMap(item => item.tests ?? []));
  // Changed documents beside code: the tests that read them are their coverage.
  const readers = docsReaders(files, paths.filter(documentation));
  for (const test of readers.keys()) explicit.add(test);
  // Repo-wide guards that scan a folder holding a changed file read it, with no import edge.
  const scans = scanReaders(
    files,
    paths.filter(path => !documentation(path)),
  );
  for (const test of scans.keys()) explicit.add(test);
  const selected = tests.filter(
    path =>
      affected.has(path) || smokeTests.includes(path) || explicit.has(path) || (webChanged && webTest(path)),
  );
  const scopeDomains = [...new Set(classifications.map(item => item.domain))];
  const reasons = [...new Set(classifications.map(item => item.reason).filter(Boolean))];
  return {
    scope: 'scoped',
    // Proof consumers need affected tests, separately from fixed smoke coverage.
    // A smoke test reached by an actual dependency remains affected.
    affectedTests: tests.filter(
      path => affected.has(path) || explicit.has(path) || (webChanged && webTest(path)),
    ),
    domain: scopeDomains.length === 1 ? scopeDomains[0] : 'mixed',
    reason:
      `${scopeDomains.join('+')} scope; ` +
      [
        ...reasons,
        'Transitive importers, runtime paths, conservative dynamic domains and fixed smoke tests',
      ].join('; '),
    tests: selected,
    reasons: Object.fromEntries(
      selected.map(test => {
        if (smokeTests.includes(test)) return [test, { kind: 'smoke', detail: 'Fixed scoped smoke test' }];
        const item = classifications.find(item => item.tests?.includes(test));
        const reader = readers.get(test);
        // Reading a changed document is direct evidence, stronger than any import chain to code.
        if (reader && affected.get(test)?.kind !== 'changed')
          return [test, { kind: 'explicit', changedPath: reader.doc, detail: readerDetail(reader, test) }];
        const scan = scans.get(test);
        if (scan && affected.get(test)?.kind !== 'changed')
          return [test, { kind: 'explicit', changedPath: scan.path, detail: scanDetail(scan) }];
        return [
          test,
          affected.get(test) ??
            (item
              ? {
                  kind: 'explicit',
                  changedPath: item.path,
                  detail: item.reason,
                }
              : {
                  kind: 'domain',
                  detail: 'Web change: UI regression coverage',
                }),
        ];
      }),
    ),
  };
}

const readerDetail = (reader, test) =>
  reader.scan !== undefined
    ? scanDetail({ path: reader.doc, folder: reader.scan })
    : `Reads changed document ${reader.doc}${reader.via === test ? '' : ` through ${reader.via}`}`;

const productSource = path => /^(?:src|web\/src|convex|netlify)\//.test(path);

function importersOf(path, reverse) {
  const visited = new Set(),
    queue = [path];
  while (queue.length)
    for (const importer of reverse.get(queue.shift()) ?? [])
      if (!visited.has(importer)) {
        visited.add(importer);
        queue.push(importer);
      }
  return visited;
}

function hasTestConsumer(path, reverse, tests) {
  const visited = new Set([path]),
    queue = [path];
  while (queue.length) {
    const current = queue.shift();
    if (tests.includes(current)) return true;
    for (const importer of reverse.get(current) ?? []) {
      if (!visited.has(importer)) {
        visited.add(importer);
        queue.push(importer);
      }
    }
  }
  return false;
}

export function pinnedComparison(env = process.env) {
  try {
    const input = JSON.parse(readFileSync(env.FORGE_CHECK_CHANGES, 'utf8'));
    if (
      input.version !== 1 ||
      input.comparison !== 'main' ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.base) ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.head) ||
      input.base !== env.FORGE_CHECK_BASE ||
      input.head !== env.FORGE_CHECK_HEAD
    )
      return null;
    if (input.mainCheck !== undefined && (!input.mainCheck || typeof input.mainCheck.channel !== 'string'))
      return null;
    if (input.interaction !== undefined && !validInteraction(input.interaction, input)) return null;
    return input;
  } catch {
    return null;
  }
}

export const pinnedPaths = (env = process.env) => pinnedComparison(env)?.paths ?? null;

/** Never returns a non-docs selection with zero tests: see selection-guard.mjs. */
export function guardedSelection(selection, { files, paths, interaction }) {
  return guardSelection(selection, { files, paths, interaction, documentation, smoke: smokeTests });
}

/** The hosted and machine checks run the same readers as local preflight (`docsReaders`, one shared
 * selector): a docs scope keeps its scope, so the documents checks and every rule that keys on `docs`
 * (main-audit skip, gate, clean-disjoint admission) hold, and its tests are the test files that read a
 * changed document, none when no test reads one. Never a full re-check for docs. Mutates and returns
 * `selection`; any other scope is returned untouched. */
function withDocsReaders(selection, files, paths) {
  if (selection.scope !== 'docs' || !Array.isArray(paths) || !paths.every(documentation)) return selection;
  const readers = docsReaders(files, paths);
  if (!readers.size) return selection;
  selection.tests = [...readers.keys()].sort();
  selection.reasons = Object.fromEntries(
    selection.tests.map(test => {
      const reader = readers.get(test);
      return [test, { kind: 'explicit', changedPath: reader.doc, detail: readerDetail(reader, test) }];
    }),
  );
  selection.reason = `${selection.reason}; plus the ${selection.tests.length} test file(s) that read a changed document`;
  return selection;
}

export function standardSelection(input) {
  return guardedSelection(composedSelection(input), input);
}

/** For reads that only report what a check would select (the `tests` query, Intent contracts):
 * a project with no test file reports an empty selection and why, instead of failing the read.
 * The check itself still fails closed through standardSelection. */
export function advisorySelection(input) {
  try {
    return standardSelection(input);
  } catch (error) {
    if (error?.code !== 'ZERO_SELECTION') throw error;
    return { ...composedSelection(input), reason: error.message };
  }
}

function composedSelection(input) {
  const selection = baseStandardSelection(input);
  const tests = input.semanticTests ?? [];
  if (!tests.length) return selection;
  if (
    tests.some(
      test => !safePath(test) || !/^tests\/.+\.test\.[cm]?[jt]s$/.test(test) || !input.files.has(test),
    )
  )
    throw new Error('An Intent contract test is absent from the composed Candidate.');
  return {
    ...selection,
    scope: selection.scope === 'docs' ? 'scoped' : selection.scope,
    tests: [...new Set([...selection.tests, ...tests])].sort(),
    reason: `${selection.reason}; composed Intent contract union`,
  };
}

function baseStandardSelection({
  paths,
  files,
  mainCheck,
  interaction,
  optimistic,
  recovery,
  coverage,
  env = process.env,
}) {
  if (optimistic && !mainCheck) env = { ...env, FORGE_CHECK_SCOPED: '1', FORGE_CHECK_FULL: '0' };
  if (interaction !== undefined || env.FORGE_CHECK_INTERACTION === '1')
    return interactionSelection({ paths, files, mainCheck, interaction, env });
  const selection = selectTests({
    paths,
    files,
    forceFull:
      !!mainCheck ||
      env.FORGE_CHECK_FULL === '1' ||
      (env.FORGE_CHECK_SCOPED !== '1' &&
        !(
          Array.isArray(paths) &&
          paths.length &&
          paths.every(path => safePath(path) && documentation(path))
        )),
  });
  withDocsReaders(selection, files, paths);
  if (mainCheck) selection.reason = `Pinned main audit View for ${mainCheck.channel}`;
  else if (env.FORGE_CHECK_FULL !== '1' && env.FORGE_CHECK_SCOPED !== '1' && selection.scope !== 'docs')
    selection.reason =
      'Scoped mode is OFF; enable FORGE_CHECK_SCOPED=1 after post-accept full main checks are active';
  if (
    recovery?.tests?.length &&
    selection.scope === 'scoped' &&
    recovery.tests.every(test => /^tests\/[A-Za-z0-9_.-]+\.test\.mjs$/.test(test) && files.has(test))
  ) {
    for (const test of recovery.tests)
      selection.reasons[test] ??= {
        kind: 'recovery',
        detail: 'Failed audit shard',
      };
    selection.tests = [...new Set([...selection.tests, ...recovery.tests])].sort();
    selection.reason += '; failed audit shards plus newly affected tests';
  }
  if (selection.scope === 'full') explainAll(selection);
  selection.coverage = coverageShadow({ selection, paths, files, coverage });
  return selection;
}

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const uuid = value =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const pathSet = value =>
  Array.isArray(value) &&
  value.every(safePath) &&
  JSON.stringify(value) === JSON.stringify([...new Set(value)].sort());
const collides = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
export function validInteraction(value, comparison) {
  if (
    !value ||
    value.version !== 1 ||
    !uuid(value.reusedRunId) ||
    !['base', 'checkedHead', 'main', 'mergedHead'].every(key => oid(value[key])) ||
    typeof value.eligible !== 'boolean' ||
    typeof value.reason !== 'string' ||
    !['lanePaths', 'mainPaths', 'overlap'].every(key => pathSet(value[key]))
  )
    return false;
  if (comparison && (value.main !== comparison.base || value.mergedHead !== comparison.head)) return false;
  const overlap = [
    ...new Set(
      [...value.lanePaths, ...value.mainPaths].filter(path =>
        value.lanePaths.some(a => value.mainPaths.some(b => collides(a, b) && (path === a || path === b))),
      ),
    ),
  ].sort();
  if (value.basis !== undefined && !['docs-overlap', 'main-full-coverage'].includes(value.basis))
    return false;
  const docsBasis = value.basis === 'docs-overlap' && overlap.length && overlap.every(documentation);
  return (
    (value.basis !== 'docs-overlap' || !!docsBasis) &&
    JSON.stringify(overlap) === JSON.stringify(value.overlap) &&
    (!value.eligible || docsBasis || uuid(value.mainRunId))
  );
}
export function interactionSelection({ paths, files, mainCheck, interaction, env = process.env }) {
  const full = reason =>
    explainAll({
      scope: 'full',
      reason,
      tests: selectTests({ files, forceFull: true }).tests,
    });
  if (mainCheck) return full(`Pinned main audit View for ${mainCheck.channel}`);
  if (env.FORGE_CHECK_FULL === '1') return full('FORGE_CHECK_FULL=1');
  if (env.FORGE_CHECK_SCOPED !== '1') return full('Scoped mode is OFF for interaction retry');
  if (!validInteraction(interaction)) return full('Missing or malformed interaction pins');
  if (!interaction.eligible) {
    const selection = standardSelection({
      paths,
      files,
      env: { ...env, FORGE_CHECK_INTERACTION: '0' },
    });
    return {
      ...selection,
      reason: `Interaction ineligible: ${interaction.reason}; ${selection.reason}`,
    };
  }
  const left = selectTests({ files, paths: interaction.lanePaths });
  const right = selectTests({ files, paths: interaction.mainPaths });
  // Classify complete sides before docs overlap, so tooling cannot hide behind Markdown.
  if (left.scope === 'full' || right.scope === 'full')
    return full(`Interaction side requires full: ${left.scope === 'full' ? left.reason : right.reason}`);
  if (interaction.overlap.length && interaction.overlap.every(documentation))
    return {
      scope: 'docs',
      reason: `${interaction.reason.includes('resolved conflicts') ? 'Resolved' : 'Clean'} Markdown-only interaction overlap; all merged static checks`,
      tests: [],
    };
  const overlap = interaction.overlap.length
    ? selectTests({ files, paths: interaction.overlap })
    : { tests: [] };
  if (overlap.scope === 'full') return full(overlap.reason);
  return explainAll(
    {
      scope: 'interaction',
      reason: 'Impacted-test intersection plus overlap and fixed smoke',
      tests: [
        ...new Set([
          ...left.tests.filter(path => right.tests.includes(path)),
          ...overlap.tests,
          ...smokeTests.filter(path => files.has(path)),
        ]),
      ].sort(),
    },
    'interaction',
  );
}

function explainAll(selection, kind = 'full') {
  selection.reasons = Object.fromEntries(
    selection.tests.map(test => [test, { kind, detail: selection.reason }]),
  );
  return selection;
}
