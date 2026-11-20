// SPDX-License-Identifier: Apache-2.0
// Parse repository bytes only: never import or execute the inspected modules.
import { posix } from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import {
  builtNames,
  directoryDependency,
  escape,
  packageSelf,
  pathKind,
  repositoryWorkspaceUsers,
  shadowsRequire,
} from './test-directory-path.mjs';
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
import { moduleSymbols, siteOf } from './test-symbols.mjs';

export function testImportGraph(files, scriptsChanged = [], { typeImports = false } = {}) {
  const reverse = new Map(),
    evidence = new Map();
  // `byName`: a by-name loader's closure edge (every module named anywhere the test's code can reach).
  // It keeps landing coverage but is weak closeness evidence: preflight never ranks it as direct.
  const edge = (dependency, importer, kind = 'package-command', detail, byName = false) => {
    // A runner naming behavior tests describes coverage, not its implementation.
    // Keep test-to-test imports, but never cycle coverage back into the pipeline.
    if (/^tests\/[^/]+\.test\.mjs$/.test(dependency) && !importer.startsWith('tests/')) return;
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    if (!evidence.has(dependency)) evidence.set(dependency, new Map());
    const previous = evidence.get(dependency).get(importer);
    // A workspace path is the narrowest evidence; dynamic is replaced by specific evidence.
    if (
      !previous ||
      previous.kind === 'workspace-path' ||
      (previous.kind === 'dynamic' && kind !== 'workspace-path')
    )
      evidence
        .get(dependency)
        .set(importer, { kind, ...(detail ? { detail } : {}), ...(byName ? { byName: true } : {}) });
    reverse.get(dependency).add(importer);
    // Where the importer refers to the dependency (test-symbols.mjs). An import or re-export
    // declaration is read from the importer's symbols; an edge made outside a parse is whole.
    if (!sites) return;
    if (!sites.has(dependency)) sites.set(dependency, new Map());
    const into = sites.get(dependency);
    if (!into.has(importer)) into.set(importer, { whole: false, statements: new Set() });
    const record = into.get(importer);
    if (!site || sitePath !== importer) record.whole = true;
    else if (!moduleSpecifier(site)) {
      // A widening site makes many edges: classify it once.
      if (siteAt?.node !== site) siteAt = { node: site, ...siteOf(site) };
      const at = siteAt;
      if (at.run || at.statement < 0) record.whole = true;
      else record.statements.add(at.statement);
    }
  };
  // Symbol-level reach is for runtime selection; type-contract graphs keep whole-module edges.
  const symbols = typeImports ? null : new Map(),
    sites = typeImports ? null : new Map();
  let site = null,
    sitePath = null,
    siteAt = null;
  const packageGraph = packageScriptGraph(files, edge);
  if (scriptsChanged.length && packageGraph.error) return { error: packageGraph.error };
  const self = packageSelf(files);
  function resolve(from, value) {
    if (self && (value === self.name || value.startsWith(`${self.name}/`)))
      value = self.exports.get(`.${value.slice(self.name.length)}`)?.slice(2) ?? value;
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
      ...(typeImports ? [`${path}.d.ts`, `${path}/index.d.ts`] : []),
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
  const jsonFiles = [...files.keys()].filter(
    file => file.endsWith('.json') && domains.some(dir => file.startsWith(dir)),
  );
  const jsonReaders = new Set(['readdir', 'readdirSync', 'opendir', 'opendirSync', 'glob', 'globSync']);
  const jsonGlobs = new Map();
  const matchingJson = pattern => {
    if (!jsonGlobs.has(pattern)) {
      // Literal prefixes discard code/example strings before invoking a glob
      // matcher. Cache the matching inventory once per pattern, not per reader.
      const prefix = pattern.includes('\\') ? '' : pattern.split(/[*?{[(!+@]/, 1)[0];
      jsonGlobs.set(
        pattern,
        jsonFiles.filter(target =>
          [target, posix.basename(target)].some(
            candidate => candidate.startsWith(prefix) && posix.matchesGlob(candidate, pattern),
          ),
        ),
      );
    }
    return jsonGlobs.get(pattern);
  };
  const jsonFolders = new Map();
  for (const file of jsonFiles)
    for (let folder = posix.dirname(file); folder !== '.'; folder = posix.dirname(folder)) {
      if (!jsonFolders.has(folder)) jsonFolders.set(folder, new Set());
      jsonFolders.get(folder).add(file);
    }

  const definedLoaders = new Map();
  const definesLoader = home => {
    if (!definedLoaders.has(home)) definedLoaders.set(home, definedLoaderNames(home, files.get(home) ?? ''));
    return definedLoaders.get(home);
  };
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
    if (!/\.(?:[cm]?js|[cm]?tsx?)$/.test(path) || (!typeImports && path.endsWith('.d.ts'))) continue;
    const ast = ts.createSourceFile(path, files.get(path), ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length)
      return { error: `Unparseable ${scriptPath(path) ? 'script' : 'module'}: ${path}` };
    symbols?.set(
      path,
      moduleSymbols(ast, value => resolve(path, value)),
    );
    const loaders = shadowsRequire(ast)
      ? ['moduleUrl', 'moduleSource']
      : ['require', 'moduleUrl', 'moduleSource'];
    // The generated API is anyApi itself; its own changes widen to the namespace.
    // moduleUrl/moduleSource imported from a helper resolve a relative path from the helper's folder
    // (`new URL(path, import.meta.url)` there), not the caller's: tests/sub/x.mjs passing
    // '../convex/a.ts' to the tests/ helper loads convex/a.ts. A locally defined one keeps this file.
    // The helper must define the loader itself; a re-export, a namespace member we cannot follow or a
    // local declaration shadowing the import has an unknown home, so its paths widen.
    const loaderHome = new Map();
    for (const statement of ast.statements) {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : null;
      const home = bindings && ts.isNamedImports(bindings) && resolve(path, statement.moduleSpecifier.text);
      for (const item of home ? bindings.elements : [])
        if (loaderNames.includes((item.propertyName ?? item.name).text))
          loaderHome.set(
            item.name.text,
            definesLoader(home).has((item.propertyName ?? item.name).text) ? home : unknownHome,
          );
    }
    if (loaderHome.size) for (const name of redeclared(ast, loaderHome)) loaderHome.set(name, unknownHome);
    const loaderFrom = call => {
      if (!ts.isCallExpression(call)) return null;
      const callee = call.expression;
      if (ts.isIdentifier(callee)) return loaderHome.get(callee.text) ?? null;
      if (!ts.isPropertyAccessExpression(callee) || !loaderNames.includes(callee.name.text)) return null;
      // `(await import('./convex-module.mjs')).moduleUrl(...)`: that module's own loader.
      let object = callee.expression;
      while (ts.isParenthesizedExpression(object) || ts.isAwaitExpression(object)) object = object.expression;
      const specifier =
        ts.isCallExpression(object) &&
        object.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteralLike(object.arguments[0])
          ? resolve(path, object.arguments[0].text)
          : null;
      return specifier && definesLoader(specifier).has(callee.name.text) ? specifier : unknownHome;
    };
    const apiNames = path.startsWith('convex/_generated/')
      ? new Set()
      : convexApiBindings(ast, value => resolve(path, value));
    // A template widens only to files its literal skeleton can name, as itself or as a
    // folder: `src/file-${i}.ts` names no source file, `../dist/${name}.js` every module.
    const widen = (prefix, detail = 'Computed module path', kind = 'dynamic') => {
      if (prefix?.suffix) {
        for (const candidate of files.keys())
          if (
            builtNames(candidate).some(name => name === prefix.suffix || name.endsWith(`/${prefix.suffix}`))
          )
            edge(candidate, path, kind, detail);
        return;
      }
      // A template inside an imported loader's argument resolves from that loader's folder.
      const from = prefix?.from ?? path;
      const template = typeof prefix === 'string' ? null : (prefix.template ?? prefix);
      if (template) prefix = template.head.text;
      const normalized = prefix.startsWith('.')
        ? posix.normalize(posix.join(posix.dirname(from), prefix))
        : prefix;
      const domain = normalized.startsWith('dist/')
        ? 'src/'
        : normalized.startsWith('scripts/')
          ? 'scripts/'
          : domains.find(dir => normalized.startsWith(dir));
      const pattern =
        template && domain
          ? new RegExp(
              `^${[normalized, ...template.templateSpans.map(span => span.literal.text)].map(escape).join('.*')}(?:/.*)?$`,
              's',
            )
          : null;
      for (const candidate of files.keys())
        if (
          (domain ? candidate.startsWith(domain) : domains.some(dir => candidate.startsWith(dir))) &&
          (!pattern || builtNames(candidate).some(name => pattern.test(name)))
        )
          edge(candidate, path, kind, detail);
    };
    let loaded = [];
    function visit(node) {
      site = node;
      sitePath = path;
      // Browser coverage also follows web-facing type contracts. Keep ordinary
      // runtime test selection unchanged (type-only edits still have static checks).
      if (typeImports) {
        const value =
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
            ? node.moduleSpecifier
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
              ? node.argument.literal
              : undefined;
        if (value && ts.isStringLiteralLike(value)) {
          const target = resolve(path, value.text);
          if (target) edge(target, path, 'import');
        }
      }
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
        // Folder arguments can be repo- or module-relative. Keep JSON readers
        // even when another importer already resolves the changed data file.
        // A default argument has caller-relative cwd, not this module's folder.
        const locations = [
          posix.normalize(value),
          ...(!ts.isParameter(node.parent) && !posix.isAbsolute(value)
            ? [posix.join(posix.dirname(path), value)]
            : []),
        ];
        const folders = locations.map(value => jsonFolders.get(value.replace(/\/$/, ''))).filter(Boolean);
        const glob = /[*?{[(]/.test(value);
        if (value && (folders.length || glob) && directoryDependency(node, ast, false, jsonReaders)) {
          for (const folder of folders)
            for (const target of folder) edge(target, path, 'runtime-path', 'JSON directory reader');
          if (glob)
            for (const pattern of locations)
              for (const target of matchingJson(pattern))
                edge(target, path, 'runtime-path', 'Matching JSON glob');
        }
        const name = value.match(/^([A-Za-z_][\w-]*(?:\/[A-Za-z_][\w-]*)*):[A-Za-z_]\w*$/)?.[1];
        // A well-formed name of a module absent from this inventory loads no module.
        if (name && convexModule(name)) functionReference(path, [name], 'Convex function name');
        else if (makeReferenceArgument(node) && !name)
          widenFunctions(path, '', `Unknown Convex function name: ${value}`);
        const from = loaderFrom(node.parent);
        const target = from === unknownHome ? undefined : resolve(from ?? path, value);
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
                (ts.isIdentifier(parent.expression) && loaders.includes(parent.expression.text))));
          // A path used only for comparison observes its name, not source bytes.
          // Reuse the same escape/data-flow proof as directory comparisons.
          if (importing || directoryDependency(node, ast, true))
            edge(target, path, importing ? 'import' : pathKind(path, value));
        }
        // A script path or command name that is only compared (`path === 'scripts/x.mjs'`) runs nothing.
        if (
          (path.startsWith('tests/') || path.startsWith('scripts/')) &&
          directoryDependency(node, ast, true)
        )
          packageGraph.reference?.(value, path);
        // Built web bundles, directory enumeration and generated CLI module paths.
        if (
          /^(?:\.\.\/)?web-dist(?:\/|$)/.test(value) &&
          (path.startsWith('tests/') || path.startsWith('scripts/')) &&
          directoryDependency(node, ast)
        )
          widen('web/src/');
        if (
          (path.startsWith('tests/') || path.startsWith('scripts/')) &&
          ['../dist', 'dist', '../src', '../web/src', 'web/src', '../convex'].includes(
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
        if (file && file.endsWith(literal.replace(/^(?:\.\.?\/)+/, '')))
          edge(file, path, pathKind(path, literal));
        else if (functionNameLoader(node, path)) nameLoaders.add(path);
        else if (/^(?:\.\.\/|\.\/)?(?:dist|src|web|convex|netlify|scripts)\//.test(prefix)) {
          // `../convex/${name}.ts` over a literal list names exactly those files.
          const targets = enumerated?.map(value => resolve(path, value));
          if (targets?.every(Boolean))
            for (const [i, target] of targets.entries()) edge(target, path, pathKind(path, enumerated[i]));
          // Not a loader call: a computed path names files the way a literal does. In product code a
          // non-relative one is a path in the user's workspace (`pathKind`), not a load of this
          // repository (5dcfce75: `dist/${built[1]}.js` in a list of failure-text aliases made every
          // src file reach the tests of every module that imports it).
          else
            widen(
              node,
              undefined,
              pathKind(path, prefix) === 'workspace-path' ? 'workspace-path' : 'dynamic',
            );
        }
      }
      // A literal Vite glob (`import.meta.glob('./*/route.ts')`) loads exactly the files it matches.
      const viteGlob =
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'glob' &&
        ts.isMetaProperty(node.expression.expression);
      const globbed = viteGlob ? literalGlobTargets(path, node.arguments, files) : null;
      // Vite compiles an eager glob into static imports: it loads with the module wherever it stands
      // (even inside a function), so its edges are whole. An unproven glob may be eager too.
      if (viteGlob && (!globbed || eagerGlob(node.arguments[1]))) site = null;
      if (globbed) {
        for (const target of globbed) edge(target, path, 'import');
        return;
      }
      // Unknown module loading widens coverage, including wrapper calls such as moduleUrl().
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && loaders.includes(node.expression.text)) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'glob' &&
            ts.isMetaProperty(node.expression.expression)))
      ) {
        const home = loaderFrom(node);
        // Every value the loader is proven to load becomes an edge (below, after the literals' own
        // edges), so a branch, cast or enumerated template that loadingPrefixes accepts can never be
        // missing from the graph.
        const known = (value, from = home) => {
          if (from === unknownHome) return false;
          const target = resolve(from ?? path, value);
          if (target) loaded.push(target);
          return target || external(value) || installedPath(value);
        };
        // Node internals are bare only straight inside require or a dynamic import; a wrapper's argument
        // (`moduleUrl('internal/x')`) is a name the wrapper turns into a path.
        const direct =
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require');
        const prefixes = viteGlob
          ? ['']
          : loadingPrefixes(node.arguments[0], known, loaderFrom, direct ? nodeInternal : null, home);
        if (prefixes.length) {
          // Packagers load installed artifacts, not repository sources. A literal ending is bounded.
          if (
            prefixes.some(prefix => !prefix.suffix) &&
            scriptsChanged.some(item => item.path === path) &&
            !docsPackager(path)
          )
            uncertain = `Unknown module loading in changed script: ${path}`;
          for (const prefix of prefixes)
            widen(
              prefix,
              prefix.suffix
                ? `Computed loader path ending: ${prefix.suffix}`
                : typeof prefix !== 'string' || prefix
                  ? `Computed loader domain: ${typeof prefix === 'string' ? prefix : (prefix.template ?? prefix).head.text}`
                  : 'Unknown module loader',
            );
        }
      }
      const proven = loaded;
      loaded = [];
      ts.forEachChild(node, visit);
      // After the children: a literal's own (narrower) evidence kind is recorded first and kept.
      // The loader call is the site (the children moved it).
      if (proven.length) ((site = node), (sitePath = path));
      for (const target of proven) edge(target, path, 'import');
    }
    // convex-module is a known test loader: its moduleUrl callers contribute literal
    // edges above; its recursive resolver is represented by transitive source imports.
    visit(ast);
    site = null;
  }
  if (uncertain) return { error: uncertain };
  const workspaceUsers = repositoryWorkspaceUsers(files);
  if (scriptsChanged.length && packageGraph.error) return { error: packageGraph.error };
  byNameDispatch(files, reverse, evidence, edge, named, nameLoaders);
  return { reverse, evidence, packageGraph, workspaceUsers, symbols, sites };
}

const moduleSpecifier = node =>
  ts.isStringLiteralLike(node) &&
  (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
  node.parent.moduleSpecifier === node;

const eagerGlob = options =>
  !!options &&
  ts.isObjectLiteralExpression(options) &&
  options.properties.some(
    item =>
      ts.isPropertyAssignment(item) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)) &&
      item.name.text === 'eager' &&
      item.initializer.kind === ts.SyntaxKind.TrueKeyword,
  );

// A resolved literal in one branch must never hide an unknown alternative.
/** Only proven literal Vite forms narrow coverage. Unknown patterns/options use the broad loader. */
function literalGlobTargets(path, args, files) {
  const [node, options] = args;
  let base = posix.dirname(path);
  if (args.length > 2) return null;
  if (options) {
    if (!ts.isObjectLiteralExpression(options)) return null;
    for (const property of options.properties) {
      if (!ts.isPropertyAssignment(property)) return null;
      const name =
        ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : null;
      const value = property.initializer;
      if (name === 'base') {
        if (!ts.isStringLiteralLike(value) || !/^\.\.?\/[\w./-]*$/.test(value.text)) return null;
        base = posix.join(posix.dirname(path), value.text);
      } else if (name === 'eager') {
        if (![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) return null;
      } else if (name !== 'import' || !ts.isStringLiteralLike(value)) return null;
    }
  }
  const patterns = node && ts.isArrayLiteralExpression(node) ? [...node.elements] : [node];
  if (!patterns.every(item => item && ts.isStringLiteralLike(item) && /^\.\/[\w./*-]*$/.test(item.text)))
    return null;
  // A globstar is recursive only as a complete segment. Other syntax stays conservative.
  if (patterns.some(item => item.text.split('/').some(part => part.includes('**') && part !== '**')))
    return null;
  const matchers = patterns.map(
    item =>
      new RegExp(
        `^${posix
          .join(base, item.text)
          .split(/(\*\*\/|\*\*|\*)/)
          .map(part =>
            part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : escape(part),
          )
          .join('')}$`,
      ),
  );
  return [...files.keys()].filter(candidate => matchers.some(matcher => matcher.test(candidate)));
}

const loaderNames = ['moduleUrl', 'moduleSource'];
const unknownHome = Symbol('unknown loader home');
/** The loader names a module defines and exports itself (not a re-export or an imported binding). */
function definedLoaderNames(path, text) {
  const names = new Set();
  if (text && loaderNames.some(name => text.includes(name))) {
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const local = new Set();
    const exported = node => node.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword);
    for (const statement of ast.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        local.add(statement.name.text);
        if (exported(statement)) names.add(statement.name.text);
      }
      if (ts.isVariableStatement(statement))
        for (const item of statement.declarationList.declarations)
          if (ts.isIdentifier(item.name)) {
            local.add(item.name.text);
            if (exported(statement)) names.add(item.name.text);
          }
    }
    for (const statement of ast.statements)
      if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause)
        for (const item of ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : [])
          if (local.has((item.propertyName ?? item.name).text)) names.add(item.name.text);
    for (const name of [...names]) if (!loaderNames.includes(name)) names.delete(name);
  }
  return names;
}
/** Names declared anywhere in a file other than by an import: a local `moduleUrl` may shadow the
 * imported one at some call sites, and scope is not worth proving here, so every call widens. */
function redeclared(ast, names) {
  const found = new Set();
  const visit = node => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      names.has(node.name.text)
    )
      found.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

/** A path into an installed package's folder loads no repository source: the lockfile owns it. */
const installedPath = value => /(?:^|\/)node_modules\//.test(value);
/** A Node internal given straight to require or a dynamic import loads no repository source (for
 * example 'internal/fs/watchers', only loadable under --expose-internals). Only there: a wrapper's argument
 * (`moduleUrl('file-mode')`) is a name the wrapper turns into a path. Any other unlocked bare
 * specifier may be a local alias (`@local/leaf`), so it still widens. */
const nodeInternal = value => /^internal\/[\w/-]+$/.test(value);

function loadingPrefixes(node, known, loaderFrom = () => null, bare = null, home = null) {
  if (!node) return [''];
  if (ts.isStringLiteralLike(node)) return known(node.text) || bare?.(node.text) ? [] : [''];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return loadingPrefixes(node.expression, known, loaderFrom, bare, home);
  if (ts.isConditionalExpression(node))
    return [
      ...loadingPrefixes(node.whenTrue, known, loaderFrom, bare, home),
      ...loadingPrefixes(node.whenFalse, known, loaderFrom, bare, home),
    ];
  if (ts.isTemplateExpression(node)) {
    const values = templateStrings(node);
    // A by-name loader's modules are added from dispatched names (byNameDispatch).
    if (values?.every(value => known(value)) || functionNameLoader(node, node.getSourceFile().fileName))
      return [];
    return home === unknownHome ? [''] : home ? [{ template: node, from: home }] : [node];
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'href')
    return loadingPrefixes(node.expression, known, loaderFrom, null, home);
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const expression = node.expression;
    const name = ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : '';
    if (['moduleUrl', 'moduleSource', 'URL', 'pathToFileURL', 'fileURLToPath'].includes(name)) {
      const inner = loaderFrom(node);
      return loadingPrefixes(
        node.arguments?.[0],
        inner ? value => known(value, inner) : known,
        loaderFrom,
        null,
        inner ?? home,
      );
    }
    // createRequire(...).resolve('pkg'), import.meta.resolve('pkg'): a literal specifier.
    if (
      name === 'resolve' &&
      node.arguments?.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      known(node.arguments[0].text)
    )
      return [];
    if (['join', 'resolve'].includes(name)) {
      // `join(dir, 'dist/a.js')` loads a file whose path ends with its trailing literal segments,
      // whatever `dir` is: those name one module (or none in this repository), never every file.
      const args = node.arguments ?? [];
      let tail = args.length;
      while (tail > 0 && ts.isStringLiteralLike(args[tail - 1])) tail--;
      const suffix = args
        .slice(tail)
        .map(arg => arg.text)
        .join('/');
      if (
        tail > 0 &&
        /\.(?:[cm]?js|[cm]?tsx?|json)$/.test(suffix) &&
        !/^\/|[\\:]/.test(suffix) &&
        suffix.split('/').every(part => part && part !== '.' && part !== '..')
      )
        return [{ suffix }];
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
