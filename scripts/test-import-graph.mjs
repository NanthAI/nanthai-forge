// SPDX-License-Identifier: Apache-2.0
// Parse repository bytes only: never import or execute the inspected modules.
import { posix } from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import { directoryDependency } from './test-directory-path.mjs';
import { docsPackager, packageScriptGraph, scriptPath } from './script-impact.mjs';

export function testImportGraph(files, scriptsChanged = []) {
  const reverse = new Map(),
    evidence = new Map();
  const edge = (dependency, importer, kind = 'package-command', detail) => {
    // A runner naming behavior tests describes coverage, not its implementation.
    // Keep test-to-test imports, but never cycle coverage back into the pipeline.
    if (/^tests\/[^/]+\.test\.mjs$/.test(dependency) && !importer.startsWith('tests/')) return;
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    if (!evidence.has(dependency)) evidence.set(dependency, new Map());
    const previous = evidence.get(dependency).get(importer);
    if (!previous || previous.kind === 'dynamic')
      evidence.get(dependency).set(importer, { kind, ...(detail ? { detail } : {}) });
    reverse.get(dependency).add(importer);
  };
  const packageGraph = packageScriptGraph(files, edge);
  if (scriptsChanged.length && packageGraph.error) return { error: packageGraph.error };
  function resolve(from, value) {
    let path = value.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), value)) : value;
    path = path.replace(/^dist\//, 'src/').replace(/^(src\/.+)\.(?:js|d\.ts)$/, '$1.ts');
    return [
      path,
      path.replace(/\.js$/, '.ts'),
      path.replace(/\.mjs$/, '.mts'),
      path.replace(/\.cjs$/, '.cts'),
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
        return { error: 'Local or workspace package dependency cannot be classified as external' };
      for (const path of Object.keys(locked)) {
        const name = path.split('node_modules/').pop();
        if (name) packages.add(name);
      }
    } catch {
      return { error: 'Cannot classify locked external imports' };
    }
  }
  const external = value =>
    value.startsWith('node:') || [...packages].some(name => value === name || value.startsWith(`${name}/`));
  let uncertain;
  const domains = ['src/', 'web/src/', 'convex/', 'netlify/', 'scripts/', 'tests/'];
  for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!/\.(?:[cm]?js|[cm]?tsx?)$/.test(path) || path.endsWith('.d.ts')) continue;
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length)
      return { error: `Unparseable ${scriptPath(path) ? 'script' : 'module'}: ${path}` };
    const widen = (prefix, detail = 'Computed module path') => {
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
          edge(candidate, path, 'dynamic', detail);
    };
    function visit(node) {
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
      if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
      if (ts.isImportEqualsDeclaration(node) && node.isTypeOnly) return;
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
      // Type literals can look like source paths or computed runtime loaders. They
      // disappear during compilation and belong to the always-on static checks.
      // A class's `extends` is ExpressionWithTypeArguments too: its expression
      // executes, so retain it (and only discard its nested type arguments).
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
      if (ts.isStringLiteralLike(node)) {
        const value = node.text;
        const target = resolve(path, value);
        if (
          (ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent) ||
            ts.isExternalModuleReference(node.parent)) &&
          !target &&
          !external(value)
        ) {
          uncertain = `Unresolved import ${value} in ${path}`;
        }
        if (target) {
          const parent = node.parent;
          const importing =
            ts.isImportDeclaration(parent) ||
            ts.isExportDeclaration(parent) ||
            ts.isExternalModuleReference(parent) ||
            (ts.isCallExpression(parent) &&
              (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(parent.expression) &&
                  ['require', 'moduleUrl', 'moduleSource'].includes(parent.expression.text))));
          edge(target, path, importing ? 'import' : 'runtime-path');
        }
        if (path.startsWith('tests/') || path.startsWith('scripts/')) packageGraph.reference?.(value, path);
        // Built web bundles, directory enumeration and generated CLI module paths.
        if (
          /^(?:\.\.\/)?web-dist(?:\/|$)/.test(value) &&
          (path.startsWith('tests/') || path.startsWith('scripts/')) &&
          directoryDependency(node, ast)
        )
          widen('web/src/');
        if (
          (path.startsWith('tests/') || path.startsWith('scripts/')) &&
          ['../dist', 'dist', '../web/src', 'web/src', '../convex'].includes(value) &&
          directoryDependency(node, ast)
        )
          widen(`${value}/`);
      }
      if (ts.isTemplateExpression(node)) {
        const prefix = node.head.text;
        if (/^(?:\.\.\/|\.\/)?(?:dist|src|web|convex|netlify|scripts)\//.test(prefix)) widen(prefix);
      }
      // Unknown module loading widens coverage, including wrapper calls such as moduleUrl().
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            ['require', 'moduleUrl', 'moduleSource'].includes(node.expression.text)) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'glob' &&
            ts.isMetaProperty(node.expression.expression)))
      ) {
        const prefixes = loadingPrefixes(node.arguments[0], value => resolve(path, value) || external(value));
        if (prefixes.length) {
          // Packagers load installed artifacts, not repository sources.
          if (scriptsChanged.some(item => item.path === path) && !docsPackager(path))
            uncertain = `Unknown module loading in changed script: ${path}`;
          for (const prefix of prefixes)
            widen(prefix, prefix ? `Computed loader domain: ${prefix}` : 'Unknown module loader');
        }
      }
      ts.forEachChild(node, visit);
    }
    // convex-module is a known test loader: its moduleUrl callers contribute literal
    // edges above; its recursive resolver is represented by transitive source imports.
    visit(ast);
  }
  if (uncertain) return { error: uncertain };
  if (scriptsChanged.length && packageGraph.error) return { error: packageGraph.error };
  return { reverse, evidence, packageGraph };
}

// A resolved literal in one branch must never hide an unknown alternative.
function loadingPrefixes(node, known) {
  if (!node) return [''];
  if (ts.isStringLiteralLike(node)) return known(node.text) ? [] : [''];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return loadingPrefixes(node.expression, known);
  if (ts.isConditionalExpression(node))
    return [...loadingPrefixes(node.whenTrue, known), ...loadingPrefixes(node.whenFalse, known)];
  if (ts.isTemplateExpression(node)) return [node.head.text];
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'href')
    return loadingPrefixes(node.expression, known);
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const expression = node.expression;
    const name = ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : '';
    if (['moduleUrl', 'moduleSource', 'URL', 'pathToFileURL', 'fileURLToPath'].includes(name))
      return loadingPrefixes(node.arguments?.[0], known);
    if (['join', 'resolve'].includes(name)) {
      const dirs = (node.arguments ?? [])
        .filter(ts.isStringLiteralLike)
        .map(arg => arg.text)
        .filter(value =>
          ['dist', 'src', 'web/src', 'convex', 'netlify', 'scripts', '../scripts'].includes(value),
        );
      if (dirs.length) return dirs.map(dir => `${dir}/`);
    }
  }
  return [''];
}
