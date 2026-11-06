// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import { posix, join } from 'node:path';
import { testImportGraph } from './test-import-graph.mjs';
import { watchRanking } from './test-name-watchers.mjs';
import { coverageShadow } from './test-coverage.mjs';
import { classifyCheckPath, webTest } from './check-path-scopes.mjs';
import { guardSelection } from './selection-guard.mjs';
import { docsPackager, docsWrapper, scriptPath, scriptSelectionReason } from './script-impact.mjs';

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
 * Tiers, nearest first: mandatory (changed tests, explicit coverage, smoke), direct consumers
 * (one import edge), name watchers (tests that match a distinctive name in a changed source, at any
 * import distance: an import graph cannot see a test that hooks the paths a module creates), then
 * distance-2 consumers. Nothing here counts files: the whole neighbourhood is returned, and
 * `fitPreflightBudget` trims it by time. Other uncertain and distant consumers (dynamic, domain,
 * three or more edges) stay explicit pre-queue/landing work. */
export const preflightTierRule =
  'changed tests, explicit coverage and smoke; then direct consumers; then tests that watch a distinctive name in a changed source; then distance-2 consumers, nearest first';
export function selectPreflightTests(input, graphCache = {}) {
  // The consumers-only pass reads the same inventory, so it reuses the graph the first pass built.
  const selection = selectTests(input, graphCache);
  if (selection.scope === 'docs') return { ...selection, deferredTests: [], tiers: [] };
  const consumers =
    selection.scope === 'full'
      ? selectWithGraph({ ...input, consumersOnly: true }, undefined, graphCache)
      : selection;
  const changed = new Set(input.paths);
  const kind = test => consumers.reasons?.[test]?.kind;
  const distance = test => consumers.reasons?.[test]?.edges?.length ?? Infinity;
  const mandatory = test => changed.has(test) || smokeTests.includes(test) || kind(test) === 'explicit';
  const direct = test => kind(test) === 'dependency' && distance(test) === 1;
  // Rarity is measured over every test in the inventory; only landing-covered tests are promoted.
  const watchers = watchRanking({
    files: input.files,
    tests: [...input.files.keys()].filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path)).sort(),
    candidates: selection.tests.filter(test => !mandatory(test) && !direct(test)),
    changed: input.paths,
  });
  const tierOf = test =>
    mandatory(test)
      ? 'mandatory'
      : direct(test)
        ? 'direct'
        : watchers.has(test)
          ? 'watch'
          : kind(test) === 'dependency' && distance(test) === 2
            ? 'near'
            : null;
  const ranked = tier => {
    const tests = selection.tests.filter(test => tierOf(test) === tier);
    return tier === 'watch'
      ? tests.sort((a, b) => watchers.get(b).score - watchers.get(a).score || (a < b ? -1 : 1))
      : tests;
  };
  const tiers = ['mandatory', 'direct', 'watch', 'near'].map(tier => ({ tier, tests: ranked(tier) }));
  const local = new Set(tiers.flatMap(item => item.tests));
  return {
    ...selection,
    tests: tiers.flatMap(item => item.tests),
    tiers,
    watchedNames: Object.fromEntries([...watchers].map(([test, item]) => [test, item.names])),
    deferredTests: selection.tests.filter(test => !local.has(test)),
    reason: `${selection.reason}; local: ${preflightTierRule}; the rest runs in the pre-queue check`,
  };
}

/** Time-budget trim of ranked tiers. Mandatory tests always run. Each later tier keeps a prefix
 * that fits; once a tier is cut, every farther tier is deferred whole, so a distance-2 test never
 * runs while a direct consumer waits. `free` tests (already passed for this source) cost nothing.
 * Returns what was cut and why; a cut is never silent. */
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
    if (tier === 'mandatory') {
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
  return {
    tests: kept,
    trimmed,
    estimateSeconds: Math.ceil(used),
    mandatoryOverBudget: cost(mandatory) > budgetSeconds,
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
