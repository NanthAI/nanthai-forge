// SPDX-License-Identifier: Apache-2.0
// Parse repository bytes only: never import or execute the inspected modules.
import { posix } from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import { directoryDependency } from './test-directory-path.mjs';
import { docsPackager, packageScriptGraph, scriptPath } from './script-impact.mjs';
import {
  byNameDispatch,
  convexApiBindings,
  declarationName,
  functionNameArgument,
  functionNameLoader,
  makeReferenceArgument,
  templateFunctionModules,
  templateStrings,
} from './convex-function-names.mjs';

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
        return {
          error: 'Local or workspace package dependency cannot be classified as external: package-lock.json',
        };
      for (const path of Object.keys(locked)) {
        const name = path.split('node_modules/').pop();
        if (name) packages.add(name);
      }
    } catch {
      return { error: 'Cannot classify locked external imports: package-lock.json' };
    }
  }
  const external = value =>
    value.startsWith('node:') || [...packages].some(name => value === name || value.startsWith(`${name}/`));
  let uncertain;
  const domains = ['src/', 'web/src/', 'convex/', 'netlify/', 'scripts/', 'tests/'];
  const convexModules = [...files.keys()]
    .map(file => file.match(/^convex\/(?!_generated\/)(.+)\.[jt]s$/)?.[1])
    .filter(name => name && !name.endsWith('.d'));
  const convexModule = name =>
    ['.ts', '.js'].map(ext => 'convex/' + name + ext).find(file => files.has(file));
  // Convex calls functions by name ("module:function", api.module.function), not by
  // import. Every file's names are recorded; a name we cannot read stands for the
  // matching modules, or for every module. Backend and test code dispatch names
  // in-process (ctx.run*, scheduler, harness maps), so their names are edges: a
  // module's callers depend on it. Product clients send names over the network; in
  // tests that network is a fake, and a fake that runs a real module loads it by
  // import, by a literal list, or by name through a by-name loader (below).
  const named = new Map(),
    nameLoaders = new Set();
  const dispatches = path => /^(?:convex|tests)\//.test(path);
  const functionReference = (path, names, detail, kind = 'function-reference') => {
    if (!named.has(path)) named.set(path, new Map());
    for (const name of names) {
      const module = convexModule(name),
        evidence = { kind, detail: kind === 'dynamic' ? detail : `${detail}: ${name}` };
      if (named.get(path).get(module)?.kind !== 'function-reference') named.get(path).set(module, evidence);
      if (dispatches(path)) edge(module, path, evidence.kind, evidence.detail);
    }
  };
  const widenFunctions = (path, prefix, detail) => {
    const matches = convexModules.filter(name => name.startsWith(prefix));
    functionReference(path, matches.length ? matches : convexModules, detail, 'dynamic');
  };
  for (const path of [...files.keys()].sort()) {
    if (!/\.(?:[cm]?js|[cm]?tsx?)$/.test(path) || path.endsWith('.d.ts')) continue;
    const ast = ts.createSourceFile(path, files.get(path), ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length)
      return { error: `Unparseable ${scriptPath(path) ? 'script' : 'module'}: ${path}` };
    // The generated API is anyApi itself; its own changes widen to the namespace.
    const apiNames = path.startsWith('convex/_generated/')
      ? new Set()
      : convexApiBindings(ast, value => resolve(path, value));
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
      if (ts.isIdentifier(node) && apiNames.has(node.text) && !declarationName(node)) {
        if (!ts.isPropertyAccessExpression(node.parent) && !ts.isElementAccessExpression(node.parent))
          widenFunctions(path, '', `Whole Convex API object: ${node.text}`);
        else {
          let chain = node;
          const segments = [];
          while (
            (ts.isPropertyAccessExpression(chain.parent) || ts.isElementAccessExpression(chain.parent)) &&
            chain.parent.expression === chain
          ) {
            chain = chain.parent;
            const segment = ts.isPropertyAccessExpression(chain)
              ? chain.name.text
              : ts.isStringLiteralLike(chain.argumentExpression)
                ? chain.argumentExpression.text
                : null;
            if (segment === null) break;
            segments.push(segment);
          }
          // api.a.b.fn: the longest prefix naming a module file is the module.
          const length = segments.findLastIndex((_, i) => convexModule(segments.slice(0, i + 1).join('/')));
          if (length >= 0)
            functionReference(path, [segments.slice(0, length + 1).join('/')], 'Convex API reference');
          else {
            const folder = segments.join('/');
            widenFunctions(path, folder ? `${folder}/` : '', `Unresolved Convex API reference: ${folder}`);
          }
        }
      }
      if (ts.isStringLiteralLike(node)) {
        const value = node.text;
        const name = value.match(/^([A-Za-z_][\w-]*(?:\/[A-Za-z_][\w-]*)*):[A-Za-z_]\w*$/)?.[1];
        // A well-formed name of a module absent from this inventory loads no module.
        if (name && convexModule(name)) functionReference(path, [name], 'Convex function name');
        else if (makeReferenceArgument(node) && !name)
          widenFunctions(path, '', `Unknown Convex function name: ${value}`);
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
          ['../dist', 'dist', '../web/src', 'web/src', '../convex'].includes(
            value.replace(/^(\.\.\/.+)\/$/, '$1'),
          ) &&
          directoryDependency(node, ast)
        )
          widen(`${value.replace(/\/$/, '')}/`);
      }
      if (ts.isTemplateExpression(node)) {
        const reference = makeReferenceArgument(node) || functionNameArgument(node);
        const names = templateFunctionModules(node, ast, reference);
        const matches = names ? convexModules.filter(name => names.test(name)) : [];
        // Enumerated names are exact; a wildcard's matches are every module it could name.
        if (names?.exact) functionReference(path, matches, 'Convex function name from literal values');
        else if (names && matches.length)
          functionReference(path, matches, `Computed Convex function name: ${node.getText()}`, 'dynamic');
        else if (names && reference)
          widenFunctions(path, '', `Unknown Convex function name: ${node.getText()}`);
        const prefix = node.head.text;
        // `convex/schema.ts:${line}` names one file, not its folder.
        const literal = prefix.match(/^((?:\.\.\/|\.\/)?[\w./-]+)[^\w./-]/)?.[1];
        const file = literal && resolve(path, literal);
        const enumerated = templateStrings(node);
        if (file && file.endsWith(literal.replace(/^(?:\.\.?\/)+/, ''))) edge(file, path, 'runtime-path');
        else if (functionNameLoader(node, path)) nameLoaders.add(path);
        else if (/^(?:\.\.\/|\.\/)?(?:dist|src|web|convex|netlify|scripts)\//.test(prefix)) {
          // `../convex/${name}.ts` over a literal list names exactly those files.
          const targets = enumerated?.map(value => resolve(path, value));
          if (targets?.every(Boolean)) for (const target of targets) edge(target, path, 'runtime-path');
          else widen(prefix);
        }
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
  byNameDispatch(files, reverse, evidence, edge, named, nameLoaders);
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
  if (ts.isTemplateExpression(node)) {
    const values = templateStrings(node);
    // A by-name loader's modules are added from dispatched names (byNameDispatch).
    return values?.every(known) || functionNameLoader(node, node.getSourceFile().fileName)
      ? []
      : [node.head.text];
  }
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
