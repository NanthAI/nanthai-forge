// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Parse one file into unresolved facts. No inventory, package, or target resolution belongs here.
import ts from 'typescript';
import { directoryDependency, repositoryWorkspaceUser, shadowsRequire } from './test-directory-path.mjs';
import {
  convexApiBindings,
  declarationName,
  functionNameArgument,
  functionNameLoader,
  makeReferenceArgument,
  templateFunctionModules,
  templateStrings,
} from './convex-function-names.mjs';
import { moduleSymbols, siteOf } from './test-symbols.mjs';
import { recursiveRootListings } from './test-tree-readers.mjs';
import {
  definedLoaderNames,
  literalGlob,
  loadAlternatives,
  loaderBindings,
  loaderReference,
  templateParts,
} from './test-import-loaders.mjs';

const jsonReaders = new Set(['readdir', 'readdirSync', 'opendir', 'opendirSync', 'glob', 'globSync']);
const spawnCalls = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const widenedDirectories = new Set(['../dist', 'dist', '../src', '../web/src', 'web/src', '../convex']);

export function parseImportFacts(path, text, withSymbols) {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const defines = definedLoaderNames(ast);
  if (ast.parseDiagnostics.length) return { invalid: true, defines };
  // Repository tooling (scripts and test helpers) reads this tree; product code reads a user's tree,
  // and a test's own walks are its scan scopes (test-tree-scanners.mjs).
  const isScriptOrTest = /^(?:tests|scripts)\//.test(path);
  const walks = isScriptOrTest && !/^tests\/[^/]+\.test\.mjs$/.test(path) ? new Map() : undefined;
  const roots = recursiveRootListings(ast, walks);
  const loader = loaderBindings(ast);
  const requireShadow = shadowsRequire(ast);
  const api = path.startsWith('convex/_generated/') ? [] : convexApiBindings(ast);
  const apiLocals = new Set(api.map(([name]) => name));
  const events = [];
  function record(node, kind, fact, whole = false) {
    const declaration =
      ts.isStringLiteralLike(node) &&
      (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
      node.parent.moduleSpecifier === node;
    const at = !whole && !declaration && siteOf(node);
    const site = declaration ? null : !at || at.run || at.statement < 0 ? false : at.statement;
    events.push({ kind, ...fact, site });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
    if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
    if (ts.isImportEqualsDeclaration(node) && node.isTypeOnly) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    // The expression of `extends Base` executes. Nested type arguments do not.
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (roots.has(node)) record(node, 'root', { suffix: roots.get(node) });
    for (const { folder, code } of walks?.get(node) ?? []) record(node, 'walk', { folder, code });
    if (ts.isIdentifier(node) && apiLocals.has(node.text) && !declarationName(node)) {
      let segments = null;
      if (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) {
        segments = [];
        let chain = node;
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
      }
      record(node, 'api', { name: node.text, segments });
    }
    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      const parent = node.parent;
      const specifier =
        ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        ts.isExternalModuleReference(parent);
      const importing =
        specifier ||
        (ts.isCallExpression(parent) &&
          (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(parent.expression) &&
              (['moduleUrl', 'moduleSource'].includes(parent.expression.text) ||
                (parent.expression.text === 'require' && !requireShadow)))));
      const reference = value.match(/^([A-Za-z_][\w-]*(?:\/[A-Za-z_][\w-]*)*):([A-Za-z_]\w*)$/);
      const name = reference?.[1];
      const glob = /[*?{[(]/.test(value);
      const json = Boolean(value) && directoryDependency(node, ast, false, jsonReaders, roots);
      const home = loaderReference(parent, loader.locals);
      const runtime = directoryDependency(node, ast, true);
      let widen;
      if (isScriptOrTest) {
        if (/^(?:\.\.\/)?web-dist(?:\/|$)/.test(value)) {
          if (directoryDependency(node, ast)) widen = 'web/src/';
        } else if (
          widenedDirectories.has(value.replace(/^(\.\.\/.+)\/$/, '$1')) &&
          directoryDependency(node, ast)
        )
          widen = `${value.replace(/\/$/, '')}/`;
      }
      const unknownName = !name && makeReferenceArgument(node);
      if (specifier || importing || runtime || json || name || unknownName || widen) {
        const fact = { value };
        if (specifier) fact.specifier = true;
        if (importing) fact.importing = true;
        if (runtime) {
          fact.runtime = true;
          if (!importing && (value.includes('/') || value.includes('.')))
            fact.spawn = directoryDependency(node, ast, false, spawnCalls);
        }
        if (json) {
          fact.json = true;
          if (glob) fact.glob = true;
          if (ts.isParameter(parent)) fact.parameter = true;
        }
        if (name) {
          fact.name = name;
          fact.fn = reference[2];
        }
        if (unknownName) fact.unknownName = true;
        if (home) fact.home = home;
        if (widen) fact.widen = widen;
        record(node, 'literal', fact);
      }
    }
    if (ts.isTemplateExpression(node)) {
      const reference = makeReferenceArgument(node) || functionNameArgument(node);
      const names = templateFunctionModules(node, ast, reference);
      const prefix = node.head.text;
      const literal = prefix.match(/^((?:\.\.\/|\.\/)?[\w./-]+)[^\w./-]/)?.[1];
      const nameLoader = functionNameLoader(node, path);
      const parts = /^(?:\.\.\/|\.\/)?(?:dist|src|web|convex|site|scripts)\//.test(prefix)
        ? templateParts(node)
        : null;
      if (names || literal || nameLoader || parts)
        record(node, 'template', {
          reference,
          names,
          literal,
          nameLoader,
          parts,
          spawn: parts && directoryDependency(node, ast, false, spawnCalls),
          source: names && !names.exact ? node.getText() : null,
          enumerated: parts && templateStrings(node),
        });
    }
    const call = ts.isCallExpression(node);
    const viteGlob =
      call &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'glob' &&
      ts.isMetaProperty(node.expression.expression);
    const globbed = viteGlob && literalGlob(path, node.arguments);
    if (globbed) {
      record(node, 'glob', { matchers: globbed.matchers }, globbed.eager);
      return;
    }
    let load;
    if (viteGlob) record(node, 'load', { alternatives: [{ prefixes: [''] }], unprovenGlob: true }, true);
    else if (
      call &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          (['moduleUrl', 'moduleSource'].includes(node.expression.text) ||
            (node.expression.text === 'require' && !requireShadow))))
    ) {
      const direct =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require');
      const home = loaderReference(node, loader.locals);
      load = { alternatives: loadAlternatives(node.arguments[0], loader.locals, direct, home ? [home] : []) };
      // Widening precedes literal evidence. Proven targets follow it.
      record(node, 'load', load);
    }
    ts.forEachChild(node, visit);
    if (load) record(node, 'loaded', {});
  }
  const types = [];
  function visitTypes(node) {
    const value =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        ? node.moduleSpecifier
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : undefined;
    if (value && ts.isStringLiteralLike(value)) types.push(value.text);
    ts.forEachChild(node, visitTypes);
  }
  visitTypes(ast);
  visit(ast);
  return {
    defines,
    loader,
    api,
    events,
    types,
    ...(withSymbols ? { symbols: moduleSymbols(ast) } : {}),
    workspaceUser: repositoryWorkspaceUser(path, () => text),
  };
}
