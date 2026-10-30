// SPDX-License-Identifier: Apache-2.0
// Convex function names in repository source, parsed as data (never executed):
// api.module.fn chains, "module:fn" strings and templates, and by-name loaders.
import { posix } from 'node:path';
import ts from 'typescript';

// Local names for the generated Convex API objects (api, internal, components) and
// convex/server's anyApi. Only these bindings carry function references.
export function convexApiBindings(ast, resolve) {
  const names = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const from = statement.moduleSpecifier.text;
    const generated = /(?:^|\/)convex\/_generated\/api\.[jt]s$/.test(resolve(from) ?? '');
    const bindings = statement.importClause?.namedBindings;
    if (generated && bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    for (const specifier of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
      if (specifier.isTypeOnly) continue;
      const imported = (specifier.propertyName ?? specifier.name).text;
      if (generated || (from === 'convex/server' && imported === 'anyApi')) names.add(specifier.name.text);
    }
  }
  return names;
}
// Binding and member names are not reads of the API object; every other use is.
export const declarationName = node => {
  const parent = node.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    (ts.isExportSpecifier(parent) && parent.propertyName === node) ||
    ((ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) && parent.name === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent)) &&
      parent.name === node)
  );
};
// A by-name loader (tests/convex-context.mjs) imports `../convex/${module}.ts` for
// whatever reference reaches it, so a test reaching one depends on every module
// named by any code it runs: imports, loaded and spawned files, and the named
// modules themselves, transitively. Names in src/ and web/ count here.
export function byNameDispatch(files, reverse, evidence, edge, named, nameLoaders) {
  if (!nameLoaders.size) return;
  // Code a process runs: imports, loaders and names everywhere; literal paths only
  // from test code (spawned children, fixtures). A path string in product code is data.
  const runs = (dependency, importer) => {
    const kind = evidence.get(dependency).get(importer).kind;
    return (
      !dependency.startsWith('package-script:') &&
      !importer.startsWith('package-script:') &&
      kind !== 'package-command' &&
      (kind !== 'runtime-path' || importer.startsWith('tests/'))
    );
  };
  const forward = new Map();
  for (const [dependency, importers] of reverse)
    for (const importer of importers)
      if (runs(dependency, importer)) {
        if (!forward.has(importer)) forward.set(importer, []);
        forward.get(importer).push(dependency);
      }
  const reaching = new Set(nameLoaders),
    queue = [...nameLoaders];
  for (let i = 0; i < queue.length; i++)
    for (const importer of reverse.get(queue[i]) ?? [])
      if (!reaching.has(importer) && runs(queue[i], importer)) {
        reaching.add(importer);
        queue.push(importer);
      }
  // One explanation per naming file; the chain names the module and the test.
  const details = new Map();
  const detail = current => {
    if (!details.has(current))
      details.set(current, `By-name loader runs Convex functions named in ${current}`);
    return details.get(current);
  };
  for (const test of [...reaching].filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path)).sort()) {
    const seen = new Set([test]),
      visit = [test],
      names = new Map();
    for (let i = 0; i < visit.length; i++) {
      const current = visit[i];
      for (const [module, item] of named.get(current) ?? []) {
        if (
          !names.has(module) ||
          (item.kind === 'function-reference' && names.get(module).kind !== item.kind)
        )
          names.set(module, { kind: item.kind, current });
        if (!seen.has(module)) seen.add(module) && visit.push(module);
      }
      for (const dependency of forward.get(current) ?? [])
        if (!seen.has(dependency)) seen.add(dependency) && visit.push(dependency);
    }
    for (const [module, item] of names)
      if (module !== test && files.has(module)) edge(module, test, item.kind, detail(item.current));
  }
}
// `../convex/${module}.ts` where module is the first part of name.split(':'): the
// loader imports the module of a dispatched function name.
export function functionNameLoader(node, path) {
  if (node.templateSpans.length !== 1 || !/^\.[jt]s$/.test(node.templateSpans[0].literal.text)) return false;
  if (posix.normalize(posix.join(posix.dirname(path), node.head.text)) !== 'convex/') return false;
  const span = node.templateSpans[0].expression;
  if (!ts.isIdentifier(span)) return false;
  const binding = bindingOf(span, node.getSourceFile());
  const pattern = binding?.parent;
  const declaration = pattern?.parent;
  return (
    !!binding &&
    ts.isBindingElement(binding) &&
    ts.isArrayBindingPattern(pattern) &&
    pattern.elements[0] === binding &&
    ts.isVariableDeclaration(declaration) &&
    !!declaration.initializer &&
    ts.isCallExpression(declaration.initializer) &&
    ts.isPropertyAccessExpression(declaration.initializer.expression) &&
    declaration.initializer.expression.name.text === 'split' &&
    declaration.initializer.arguments.length === 1 &&
    ts.isStringLiteralLike(declaration.initializer.arguments[0]) &&
    declaration.initializer.arguments[0].text === ':'
  );
}
// Module names a template like `projectHosted${kind}:progress` can produce. Spans
// typed or initialized as string-literal sets enumerate (exact); any other span is
// a wildcard. Outside a function-name argument a template counts only with a
// literal identifier prefix that names at least one module (the caller checks).
export function templateFunctionModules(node, ast, reference) {
  const pieces = [node.head.text];
  for (const span of node.templateSpans) pieces.push(span.expression, span.literal.text);
  const colon = pieces.findIndex(piece => typeof piece === 'string' && piece.includes(':'));
  if (colon < 0) return null;
  const after = pieces[colon].slice(pieces[colon].indexOf(':') + 1);
  if (!/^[A-Za-z_]\w*$/.test(after) && !(colon < pieces.length - 1 && after === '')) return null;
  if (!reference && !/^[A-Za-z_][\w/-]*$/.test(node.head.text)) return null;
  for (let i = 1; i < colon; i += 2) pieces[i] = literalValues(pieces[i], ast);
  const module = [...pieces.slice(0, colon), pieces[colon].slice(0, pieces[colon].indexOf(':'))];
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = module.every(piece => piece !== null);
  const pattern = module
    .map(piece =>
      piece === null
        ? '.*'
        : typeof piece === 'string'
          ? escape(piece)
          : `(?:${piece.map(escape).join('|')})`,
    )
    .join('');
  const regex = new RegExp(`^${pattern}$`);
  return { test: name => regex.test(name), exact };
}
// Every string a template can produce, when each span has literal values (≤ 256).
export function templateStrings(node) {
  let values = [node.head.text];
  for (const span of node.templateSpans) {
    const options = literalValues(span.expression, node.getSourceFile());
    if (!options || values.length * options.length > 256) return null;
    values = values.flatMap(value => options.map(option => value + option + span.literal.text));
  }
  return values;
}
// The elements of a literal string array, directly or through an unmutated const.
function arrayValues(expression, ast) {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    expression = expression.expression;
  if (ts.isArrayLiteralExpression(expression)) {
    const values = expression.elements.map(element =>
      ts.isStringLiteralLike(element) ? element.text : null,
    );
    return values.includes(null) ? null : values;
  }
  if (!ts.isIdentifier(expression)) return null;
  const declaration = bindingOf(expression, ast);
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null;
  if (!(declaration.parent.flags & ts.NodeFlags.Const) || fileIndex(ast).mutated.has(expression.text))
    return null;
  return arrayValues(declaration.initializer, ast);
}
// One walk per file: declarations, written names and mutated arrays by name,
// and local type aliases. Files are parsed one at a time, so one entry suffices
// (and no earlier syntax tree stays reachable).
let indexed = { ast: null, index: null };
function fileIndex(ast) {
  if (indexed.ast === ast) return indexed.index;
  const index = { declarations: new Map(), written: new Set(), mutated: new Set(), aliases: new Map() };
  const target = node => (ts.isIdentifier(node) ? node.text : null);
  (function scan(node) {
    if (ts.isTypeAliasDeclaration(node)) index.aliases.set(node.name.text, node.type);
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      if (!index.declarations.has(node.name.text)) index.declarations.set(node.name.text, []);
      index.declarations.get(node.name.text).push(node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      if (target(node.left)) index.written.add(node.left.text);
      if (ts.isElementAccessExpression(node.left) && target(node.left.expression))
        index.mutated.add(node.left.expression.text);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && target(node.operand))
      index.written.add(node.operand.text);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      target(node.expression.expression) &&
      ['push', 'unshift', 'splice', 'fill', 'copyWithin'].includes(node.expression.name.text)
    )
      index.mutated.add(node.expression.expression.text);
    ts.forEachChild(node, scan);
  })(ast);
  indexed = { ast, index };
  return index;
}
// The innermost parameter or variable declaring this identifier; null when ambiguous.
function bindingOf(expression, ast) {
  const scope = declaration => {
    let parent = declaration.parent;
    if (ts.isParameter(declaration)) return parent;
    while (
      parent &&
      !ts.isBlock(parent) &&
      !ts.isSourceFile(parent) &&
      !ts.isFunctionLike(parent) &&
      !ts.isForOfStatement(parent) &&
      !ts.isForInStatement(parent) &&
      !ts.isForStatement(parent)
    )
      parent = parent.parent;
    return parent;
  };
  const enclosing = (fileIndex(ast).declarations.get(expression.text) ?? [])
    .map(declaration => ({ declaration, scope: scope(declaration) }))
    .filter(({ scope }) => scope && scope.pos <= expression.pos && expression.end <= scope.end);
  const width = item => item.scope.end - item.scope.pos;
  const innermost = enclosing.filter(item => width(item) === Math.min(...enclosing.map(width)));
  return innermost.length === 1 ? innermost[0].declaration : null;
}
// String values an expression can take, when the file states them literally:
// a parameter or const typed as a union of string literals (directly or through a
// local type alias), or a lookup in an object literal of string values. Any write
// to the name, or any other shape, is unknown (null).
function literalValues(expression, ast) {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression)) return literalValues(expression.expression, ast);
  if (ts.isElementAccessExpression(expression)) return objectValues(expression);
  if (!ts.isIdentifier(expression) || fileIndex(ast).written.has(expression.text)) return null;
  const declaration = bindingOf(expression, ast);
  if (!declaration || ts.isBindingElement(declaration)) return null;
  const aliases = fileIndex(ast).aliases;
  const typeValues = type => {
    if (!type) return null;
    if (ts.isParenthesizedTypeNode(type)) return typeValues(type.type);
    if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return [type.literal.text];
    if (ts.isUnionTypeNode(type)) {
      const values = type.types.map(typeValues);
      return values.every(Boolean) ? values.flat() : null;
    }
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && !type.typeArguments)
      return typeValues(aliases.get(type.typeName.text));
    return null;
  };
  const typed = typeValues(declaration.type);
  if (typed) return [...new Set(typed)];
  if (declaration.type) return null;
  if (ts.isVariableDeclaration(declaration)) {
    // for (const name of ['a', 'b'])
    if (
      ts.isForOfStatement(declaration.parent.parent) &&
      declaration.parent.parent.initializer === declaration.parent
    )
      return arrayValues(declaration.parent.parent.expression, ast);
    return declaration.initializer ? literalValues(declaration.initializer, ast) : null;
  }
  // ['a', 'b'].map(name => ...): the first parameter of an array callback.
  const callback = declaration.parent;
  const call = callback.parent;
  if (
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    callback.parameters[0] === declaration &&
    call &&
    ts.isCallExpression(call) &&
    call.arguments[0] === callback &&
    ts.isPropertyAccessExpression(call.expression) &&
    ['map', 'flatMap', 'forEach', 'filter', 'some', 'every', 'find'].includes(call.expression.name.text)
  )
    return arrayValues(call.expression.expression, ast);
  return null;
}
function objectValues(access) {
  let target = access.expression;
  while (ts.isParenthesizedExpression(target) || ts.isAsExpression(target)) target = target.expression;
  if (!ts.isObjectLiteralExpression(target)) return null;
  const values = target.properties.map(property =>
    ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
      ? property.initializer.text
      : null,
  );
  return values.includes(null) ? null : values;
}
// The name argument of a Convex client or ctx call: query/mutation/action and
// runQuery/runMutation/runAction take it first, scheduler.runAfter/runAt second.
export const functionNameArgument = node => {
  const call = node.parent;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  if (['runAfter', 'runAt'].includes(method)) return call.arguments[1] === node;
  return (
    call.arguments[0] === node &&
    ['query', 'mutation', 'action', 'runQuery', 'runMutation', 'runAction'].includes(method)
  );
};
// The literal or template passed straight to makeFunctionReference(...).
export const makeReferenceArgument = node =>
  ts.isCallExpression(node.parent) &&
  node.parent.arguments[0] === node &&
  ((ts.isIdentifier(node.parent.expression) && node.parent.expression.text === 'makeFunctionReference') ||
    (ts.isPropertyAccessExpression(node.parent.expression) &&
      node.parent.expression.name.text === 'makeFunctionReference'));
