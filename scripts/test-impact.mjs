// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import { posix, join } from 'node:path';
import ts from 'typescript';
import { classifyCheckPath, webTest } from './check-path-scopes.mjs';
import { builtinModules } from 'node:module';
import {
  docsPackager,
  docsWrapper,
  packageScriptGraph,
  scriptPath,
  scriptSelectionReason,
} from './script-impact.mjs';

export const smokeTests = [
  'tests/files.test.mjs',
  'tests/ci-scope.test.mjs',
  'tests/test-impact.test.mjs',
  'tests/check-path-scopes.test.mjs',
];
export const documentation = path => /^(?:docs\/.+|[^/]+)\.md$/.test(path);
export const safePath = path =>
  typeof path === 'string' &&
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.split('/').some(part => ['', '.', '..'].includes(part)) &&
  !/[\x00-\x1f\x7f\ufffd\\*?\[\]{}!]/.test(path);

export function sourceFiles(root = '.') {
  const files = new Map();
  function walk(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:[cm]?js|[cm]?tsx?|css|json|svg|html)$/.test(path))
        files.set(path, readFileSync(join(root, path), 'utf8'));
    }
  }
  for (const dir of ['src', 'web', 'convex', 'netlify', 'tests', 'scripts']) walk(dir);
  files.set('package.json', readFileSync(join(root, 'package.json'), 'utf8'));
  files.set('package-lock.json', readFileSync(join(root, 'package-lock.json'), 'utf8'));
  return files;
}

/** Static imports plus literal runtime source paths used by moduleUrl/readFile/CLI tests.
 * Nonliteral paths widen to their entire source domain, never prove independence. */
export function selectTests({ paths, files, forceFull = false }) {
  const tests = [...files.keys()].filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path)).sort();
  const full = reason => ({ scope: 'full', reason, tests });
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
  for (const path of paths) {
    if (documentation(path)) continue;
    const classification = classifyCheckPath(path, files);
    if (!classification) return full(`Unclassified or deleted path: ${path}`);
    classifications.push({ path, ...classification });
  }
  const reverse = new Map();
  const edge = (dependency, importer) => {
    // A runner naming behavior tests describes coverage, not its implementation.
    // Keep test-to-test imports, but never cycle coverage back into the pipeline.
    if (/^tests\/[^/]+\.test\.mjs$/.test(dependency) && !importer.startsWith('tests/')) return;
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    reverse.get(dependency).add(importer);
  };
  const scriptsChanged = classifications.filter(item => scriptPath(item.path) && files.has(item.path));
  const packageGraph = packageScriptGraph(files, edge);
  if (scriptsChanged.length && packageGraph.error) return full(packageGraph.error);
  function resolve(from, value) {
    let path = value.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), value)) : value;
    path = path.replace(/^dist\//, 'src/').replace(/^(src\/.+)\.(?:js|d\.ts)$/, '$1.ts');
    return [
      path,
      path.replace(/\.js$/, '.ts'),
      path.replace(/\.js$/, '.tsx'),
      `${path}.ts`,
      `${path}.tsx`,
      `${path}.js`,
      `${path}/index.ts`,
      `${path}/index.tsx`,
    ].find(candidate => files.has(candidate));
  }
  const packages = new Set(builtinModules);
  if (files.has('package-lock.json')) {
    try {
      const locked = JSON.parse(files.get('package-lock.json')).packages;
      if (
        Object.values(locked).some(
          item => item.link || /^(?:file:|workspace:|\.|\/)/.test(item.resolved ?? ''),
        )
      )
        return full('Local or workspace package dependency cannot be classified as external');
      for (const path of Object.keys(locked)) {
        const name = path.split('node_modules/').pop();
        if (name) packages.add(name);
      }
    } catch {
      return full('Cannot classify locked external imports');
    }
  }
  const external = value =>
    value.startsWith('node:') || [...packages].some(name => value === name || value.startsWith(`${name}/`));
  let uncertain;
  const domains = ['src/', 'web/src/', 'convex/', 'netlify/'];
  for (const [path, text] of files) {
    if (!/\.(?:[cm]?js|[cm]?tsx?)$/.test(path) || path.endsWith('.d.ts')) continue;
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (scriptsChanged.length && scriptPath(path) && ast.parseDiagnostics.length)
      return full(`Unparseable script: ${path}`);
    const widen = prefix => {
      const normalized = prefix.startsWith('.')
        ? posix.normalize(posix.join(posix.dirname(path), prefix))
        : prefix;
      const domain = normalized.startsWith('dist/')
        ? 'src/'
        : normalized.startsWith('scripts/')
          ? 'scripts/'
          : domains.find(dir => normalized.startsWith(dir));
      for (const candidate of files.keys())
        if (domain ? candidate.startsWith(domain) : domains.some(dir => candidate.startsWith(dir)))
          edge(candidate, path);
    };
    function visit(node) {
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
      if (ts.isImportTypeNode(node)) return;
      if (ts.isStringLiteralLike(node)) {
        const value = node.text;
        const target = resolve(path, value);
        if (
          (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
          !target &&
          !external(value)
        ) {
          uncertain = `Unresolved import ${value} in ${path}`;
        }
        if (target) edge(target, path);
        if (path.startsWith('tests/') || path.startsWith('scripts/')) packageGraph.reference?.(value, path);
        // Built web bundles, directory enumeration and generated CLI module paths.
        if (/^(?:\.\.\/)?web-dist(?:\/|$)/.test(value) && path.startsWith('tests/')) widen('web/src/');
        if (
          (path.startsWith('tests/') || path.startsWith('scripts/')) &&
          ['../dist', 'dist', '../web/src', 'web/src', '../convex'].includes(value)
        )
          widen(`${value}/`);
      }
      if (ts.isTemplateExpression(node)) {
        const prefix = node.head.text;
        if (/^(?:\.\.\/|\.\/)?(?:dist|src|web|convex|netlify|scripts)\//.test(prefix)) widen(prefix);
      }
      // Unknown module loading widens coverage, including wrapper calls such as moduleUrl().
      if (
        path !== 'tests/convex-module.mjs' &&
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && ['require', 'moduleUrl'].includes(node.expression.text)))
      ) {
        const arg = node.arguments[0];
        const literals = [],
          templates = [];
        if (arg) {
          const scan = n => {
            if (ts.isStringLiteralLike(n)) literals.push(n.text);
            if (ts.isTemplateExpression(n)) templates.push(n.head.text);
            ts.forEachChild(n, scan);
          };
          scan(arg);
        }
        if (
          !literals.some(value => resolve(path, value)) &&
          !(arg && ts.isStringLiteralLike(arg) && external(arg.text))
        ) {
          // Packagers load installed artifacts, not repository sources.
          if (scriptsChanged.some(item => item.path === path) && !docsPackager(path))
            uncertain = `Unknown module loading in changed script: ${path}`;
          if (templates.some(Boolean)) {
            for (const prefix of templates.filter(Boolean)) widen(prefix);
          } else {
            const directories = literals.filter(value =>
              ['dist', 'src', 'web/src', 'convex', 'netlify', 'scripts', '../scripts'].includes(value),
            );
            if (directories.length) {
              for (const directory of directories) widen(`${directory}/`);
            } else widen('');
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    // convex-module is a known test loader: its moduleUrl callers contribute literal
    // edges above; its recursive resolver is represented by transitive source imports.
    visit(ast);
  }
  if (uncertain) return full(uncertain);
  if (scriptsChanged.length && packageGraph.error) return full(packageGraph.error);
  // The docs-check wrapper only spawns the docs check; the runner importing it is not a consumer.
  const affected = new Set();
  const spread = (seeds, blocked) => {
    const queue = [...seeds];
    for (const seed of seeds) affected.add(seed);
    while (queue.length) {
      const current = queue.shift();
      if (blocked && docsWrapper(current)) continue;
      for (const importer of reverse.get(current) ?? []) {
        if (!affected.has(importer)) {
          affected.add(importer);
          queue.push(importer);
        }
      }
    }
  };
  spread(
    classifications.filter(item => !docsPackager(item.path)).flatMap(item => item.seeds),
    false,
  );
  spread(
    classifications.filter(item => docsPackager(item.path)).flatMap(item => item.seeds),
    true,
  );
  for (const item of scriptsChanged) {
    const evidence = scriptSelectionReason(item, packageGraph.roots, tests, reverse);
    if (evidence.full) return full(evidence.full);
    item.tests = [...(item.tests ?? []), ...evidence.tests];
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
    domain: scopeDomains.length === 1 ? scopeDomains[0] : 'mixed',
    reason:
      `${scopeDomains.join('+')} scope; ` +
      [
        ...reasons,
        'Transitive importers, runtime paths, conservative dynamic domains and fixed smoke tests',
      ].join('; '),
    tests: selected,
  };
}

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

export function standardSelection({
  paths,
  files,
  mainCheck,
  interaction,
  optimistic,
  recovery,
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
    selection.tests = [...new Set([...selection.tests, ...recovery.tests])].sort();
    selection.reason += '; failed audit shards plus newly affected tests';
  }
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
  const full = reason => ({ ...selectTests({ files, forceFull: true }), reason });
  if (mainCheck) return full(`Pinned main audit View for ${mainCheck.channel}`);
  if (env.FORGE_CHECK_FULL === '1') return full('FORGE_CHECK_FULL=1');
  if (env.FORGE_CHECK_SCOPED !== '1') return full('Scoped mode is OFF for interaction retry');
  if (!validInteraction(interaction)) return full('Missing or malformed interaction pins');
  if (!interaction.eligible) {
    const selection = standardSelection({ paths, files, env: { ...env, FORGE_CHECK_INTERACTION: '0' } });
    return { ...selection, reason: `Interaction ineligible: ${interaction.reason}; ${selection.reason}` };
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
  return {
    scope: 'interaction',
    reason: 'Impacted-test intersection plus overlap and fixed smoke',
    tests: [
      ...new Set([
        ...left.tests.filter(path => right.tests.includes(path)),
        ...overlap.tests,
        ...smokeTests.filter(path => files.has(path)),
      ]),
    ].sort(),
  };
}
