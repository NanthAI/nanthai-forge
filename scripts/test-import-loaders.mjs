// SPDX-License-Identifier: Apache-2.0
import { posix } from 'node:path';
import ts from 'typescript';
import { escape } from './test-directory-path.mjs';
import { functionNameLoader, templateStrings } from './convex-function-names.mjs';

const loaderNames = ['moduleUrl', 'moduleSource'];
export const templateParts = node => [node.head.text, ...node.templateSpans.map(span => span.literal.text)];

/** Import homes become active only when their specifier resolves in the current file set. */
export function loaderBindings(ast) {
  const imports = [],
    locals = new Set();
  for (const statement of ast.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : null;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const item of bindings.elements) {
      const name = (item.propertyName ?? item.name).text;
      if (!loaderNames.includes(name)) continue;
      imports.push([item.name.text, statement.moduleSpecifier.text, name]);
      locals.add(item.name.text);
    }
  }
  const shadows = new Set();
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
      locals.has(node.name.text)
    )
      shadows.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  if (locals.size) visit(ast);
  return { imports, locals, shadows };
}

/** A loader must define the export itself. Re-exports and namespace members stay unknown. */
export function definedLoaderNames(ast) {
  const names = new Set();
  if (!loaderNames.some(name => ast.text.includes(name))) return names;
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
  return new Set(loaderNames.filter(name => names.has(name)));
}

export function loaderReference(node, locals) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return locals.has(callee.text) ? callee.text : null;
  if (!ts.isPropertyAccessExpression(callee) || !loaderNames.includes(callee.name.text)) return null;
  let object = callee.expression;
  while (ts.isParenthesizedExpression(object) || ts.isAwaitExpression(object)) object = object.expression;
  const specifier =
    ts.isCallExpression(object) &&
    object.expression.kind === ts.SyntaxKind.ImportKeyword &&
    ts.isStringLiteralLike(object.arguments[0])
      ? object.arguments[0].text
      : null;
  return [specifier, callee.name.text];
}

const nodeInternal = value => /^internal\/[\w/-]+$/.test(value);

/** Flatten the alternatives a loader may evaluate. Each fact carries its unresolved loader home
 * chain, from the innermost wrapper to the outermost one. A resolved branch never hides another. */
export function loadAlternatives(node, locals, direct, homes) {
  if (!node) return [{ prefixes: [''] }];
  if (ts.isStringLiteralLike(node))
    return [{ values: [node.text], homes, knownBare: direct && nodeInternal(node.text), prefixes: [''] }];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return loadAlternatives(node.expression, locals, direct, homes);
  if (ts.isConditionalExpression(node))
    return [
      ...loadAlternatives(node.whenTrue, locals, direct, homes),
      ...loadAlternatives(node.whenFalse, locals, direct, homes),
    ];
  if (ts.isTemplateExpression(node))
    return [
      {
        values: templateStrings(node),
        homes,
        knownBare: functionNameLoader(node, node.getSourceFile().fileName),
        template: templateParts(node),
      },
    ];
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'href')
    return loadAlternatives(node.expression, locals, false, homes);
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const expression = node.expression;
    const name = ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : '';
    if (['moduleUrl', 'moduleSource', 'URL', 'pathToFileURL', 'fileURLToPath'].includes(name)) {
      const inner = loaderReference(node, locals);
      return loadAlternatives(node.arguments?.[0], locals, false, inner ? [inner, ...homes] : homes);
    }
    if (name === 'join' || name === 'resolve') {
      const args = node.arguments ?? [];
      const values =
        name === 'resolve' && args.length === 1 && ts.isStringLiteralLike(args[0]) ? [args[0].text] : null;
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
      const dirs = args
        .filter(ts.isStringLiteralLike)
        .map(arg => arg.text)
        .filter(value =>
          ['dist', 'src', 'web/src', 'convex', 'site', 'scripts', '../scripts'].includes(value),
        );
      return [{ values, homes, prefixes: dirs.length ? dirs.map(dir => `${dir}/`) : [''] }];
    }
  }
  return [{ prefixes: [''] }];
}

/** Only proven literal Vite forms narrow coverage. */
export function literalGlob(path, args) {
  const [node, options] = args;
  let base = posix.dirname(path),
    eager = false;
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
        eager ||= value.kind === ts.SyntaxKind.TrueKeyword;
      } else if (name !== 'import' || !ts.isStringLiteralLike(value)) return null;
    }
  }
  const patterns = node && ts.isArrayLiteralExpression(node) ? [...node.elements] : [node];
  if (!patterns.every(item => item && ts.isStringLiteralLike(item) && /^\.\/[\w./*-]*$/.test(item.text)))
    return null;
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
  return { eager, matchers };
}
