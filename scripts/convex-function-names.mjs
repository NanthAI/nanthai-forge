// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Convex function names in repository source, parsed as data (never executed):
// api.module.fn chains, "module:fn" strings and templates, and by-name loaders.
import { posix } from 'node:path';
import ts from 'typescript';
import { recursiveFolderReader } from './script-impact.mjs';

// Local names for the generated Convex API objects (api, internal, components) and
// convex/server's anyApi. Only these bindings carry function references.
export function convexApiBindings(ast) {
  const bindingsByName = [];
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const from = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) bindingsByName.push([bindings.name.text, from, false]);
    for (const specifier of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
      if (specifier.isTypeOnly) continue;
      const imported = (specifier.propertyName ?? specifier.name).text;
      bindingsByName.push([specifier.name.text, from, from === 'convex/server' && imported === 'anyApi']);
    }
  }
  return bindingsByName;
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
export function byNameDispatch(files, evidence, edge, named, nameLoaders) {
  if (!nameLoaders.size) return;
  // Code a process runs: imports, loaders and names everywhere; literal paths only
  // from test code (spawned children, fixtures). A path string in product code is data.
  // A tooling folder walk reads files as data (script-impact.mjs): it runs none of them.
  const runs = (dependency, importer, { kind, detail }) =>
    !dependency.startsWith('package-script:') &&
    !importer.startsWith('package-script:') &&
    kind !== 'package-command' &&
    kind !== 'workspace-path' &&
    detail !== recursiveFolderReader &&
    (kind !== 'runtime-path' || importer.startsWith('tests/'));
  // Tests can reach the same broad loader closures. Index paths once so their
  // repeated breadth-first walks use a shared queue and visitation stamps.
  const ids = new Map();
  const paths = [];
  const id = path => {
    if (!ids.has(path)) {
      ids.set(path, paths.length);
      paths.push(path);
    }
    return ids.get(path);
  };
  const forward = [];
  for (const [dependency, importers] of evidence) {
    const target = id(dependency);
    for (const [importer, item] of importers)
      if (runs(dependency, importer, item)) {
        const from = id(importer);
        (forward[from] ??= []).push(target);
      }
  }
  const reaching = new Set(nameLoaders),
    queue = [...nameLoaders];
  for (let i = 0; i < queue.length; i++)
    for (const [importer, item] of evidence.get(queue[i]) ?? [])
      if (!reaching.has(importer) && runs(queue[i], importer, item)) {
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
  const tests = [...reaching]
    .filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path))
    .sort()
    .map(id);
  const namedById = [];
  for (const [from, references] of named)
    namedById[id(from)] = [...references].map(([module, item]) => [
      id(module),
      item.kind === 'function-reference',
    ]);
  const seen = new Uint32Array(paths.length);
  const visit = new Uint32Array(paths.length);
  const namedAt = new Uint32Array(paths.length);
  const exactAt = new Uint32Array(paths.length);
  const namedFrom = new Uint32Array(paths.length);
  const namedOrder = new Uint32Array(paths.length);
  let stamp = 0;
  for (const test of tests) {
    stamp++;
    seen[test] = stamp;
    visit[0] = test;
    let end = 1;
    let nameCount = 0;
    for (let i = 0; i < end; i++) {
      const current = visit[i];
      for (const [module, exact] of namedById[current] ?? []) {
        // Keep breadth-first discovery order, replacing only the explanation when an
        // exact reference beats an earlier dynamic one.
        if (namedAt[module] !== stamp) {
          namedAt[module] = stamp;
          namedOrder[nameCount++] = module;
          namedFrom[module] = current;
          if (exact) exactAt[module] = stamp;
        } else if (exact && exactAt[module] !== stamp) {
          namedFrom[module] = current;
          exactAt[module] = stamp;
        }
        if (seen[module] !== stamp) {
          seen[module] = stamp;
          visit[end++] = module;
        }
      }
      for (const dependency of forward[current] ?? [])
        if (seen[dependency] !== stamp) {
          seen[dependency] = stamp;
          visit[end++] = dependency;
        }
    }
    for (let i = 0; i < nameCount; i++) {
      const module = namedOrder[i];
      if (module !== test && files.has(paths[module]))
        edge(
          paths[module],
          paths[test],
          exactAt[module] === stamp ? 'function-reference' : 'dynamic',
          detail(paths[namedFrom[module]]),
          true,
        );
    }
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
  return { pattern: new RegExp(`^${pattern}$`), exact };
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
  const index = {
    declarations: new Map(),
    named: new Set(),
    written: new Set(),
    mutated: new Set(),
    aliases: new Map(),
  };
  const target = node => (ts.isIdentifier(node) ? node.text : null);
  // Every name an assignment target writes: `(a) = x`, `({ a, b: c = 1, ...d } = x)`, `[a, ...b] = x`.
  const writes = node => {
    if (!node) return;
    if (ts.isIdentifier(node)) index.written.add(node.text);
    else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSpreadElement(node) ||
      ts.isSpreadAssignment(node)
    )
      writes(node.expression);
    else if (ts.isObjectLiteralExpression(node))
      for (const property of node.properties)
        writes(
          ts.isShorthandPropertyAssignment(property)
            ? property.name
            : ts.isPropertyAssignment(property)
              ? property.initializer
              : property,
        );
    else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(writes);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      writes(node.left);
  };
  (function scan(node) {
    if (ts.isTypeAliasDeclaration(node)) index.aliases.set(node.name.text, node.type);
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      if (!index.declarations.has(node.name.text)) index.declarations.set(node.name.text, []);
      index.declarations.get(node.name.text).push(node);
    }
    // Hoisted and named function or class bindings shadow too; they are never a literal's binding.
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name
    )
      index.named.add(node.name.text);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      writes(node.left);
      if (ts.isElementAccessExpression(node.left) && target(node.left.expression))
        index.mutated.add(node.left.expression.text);
    }
    // for (name of list) / for (name in object) without a declaration writes name.
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    )
      writes(node.initializer);
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
  // `a ? 'x' : b ? 'y' : 'z'`: the values of every branch (the condition only picks one).
  if (ts.isConditionalExpression(expression)) {
    const values = [expression.whenTrue, expression.whenFalse].map(branch => literalValues(branch, ast));
    return values.every(Boolean) ? [...new Set(values.flat())] : null;
  }
  if (!ts.isIdentifier(expression) || fileIndex(ast).written.has(expression.text)) return null;
  const declaration = bindingOf(expression, ast);
  if (declaration && ts.isBindingElement(declaration)) return validatorValues(declaration, ast);
  if (!declaration) return null;
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
// A Convex handler's destructured argument (`handler: async (ctx, { kind }) => …`) takes the values its
// `args` validator allows: v.literal('a'), v.union of those, v.optional of either (which adds
// 'undefined', the text an absent value gives a template). The definition must be the only argument
// of an imported Convex builder (query, internalMutation, a convex/ wrapper such as cliServer's
// query) with plain, unique `args` and `handler` keys. Unknown (null), so every module: any other
// validator; a spread, computed or duplicate key in the definition or its `args`; a default on the
// element or the whole parameter; a TS `this` parameter; a rest element or nested pattern; any write
// to the name (plain, destructuring, parenthesised, for-in/of) or another declaration of it in the
// handler (a hoisted `var` rebinds it); or a `v` not imported from convex/values or shadowed where
// the validator is built.
// A direct `fn._handler(ctx, args)` call in a test skips the args validator. The narrowing still
// holds for it: a value the validator refuses is a call Convex never makes, so a test passing one
// tests nothing production can reach (5dcfce75 review 02c2111d; decided not to widen for it).
function validatorValues(element, ast) {
  const pattern = element.parent;
  if (!ts.isObjectBindingPattern(pattern) || element.dotDotDotToken || element.initializer) return null;
  const key = element.propertyName ?? element.name;
  if (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return null;
  const parameter = pattern.parent;
  const handler = parameter.parent;
  if (!ts.isParameter(parameter) || parameter.initializer || parameter.dotDotDotToken) return null;
  if (!handler || handler.parameters?.[1] !== parameter) return null;
  const first = handler.parameters[0];
  if (ts.isIdentifier(first.name) && first.name.text === 'this') return null;
  const index = fileIndex(ast);
  const local = element.name.text;
  if (
    index.named.has(local) ||
    (index.declarations.get(local) ?? []).some(
      item => item !== element && item.pos >= handler.pos && item.end <= handler.end,
    )
  )
    return null;
  const keyName = node =>
    node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : null;
  // Plain keys only: a spread or computed key may replace or add any field.
  const plain = object =>
    object.properties.every(
      item => !ts.isSpreadAssignment(item) && item.name && !ts.isComputedPropertyName(item.name),
    );
  const definition = ts.isMethodDeclaration(handler)
    ? handler
    : (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
        ts.isPropertyAssignment(handler.parent) &&
        handler.parent.initializer === handler
      ? handler.parent
      : null;
  if (!definition || keyName(definition) !== 'handler' || !ts.isObjectLiteralExpression(definition.parent))
    return null;
  const object = definition.parent;
  if (!plain(object) || !convexBuilder(object, ast)) return null;
  const entries = name => object.properties.filter(item => keyName(item) === name);
  if (entries('handler').length !== 1) return null;
  const [args, ...more] = entries('args');
  if (
    !args ||
    more.length ||
    !ts.isPropertyAssignment(args) ||
    !ts.isObjectLiteralExpression(args.initializer)
  )
    return null;
  if (!plain(args.initializer)) return null;
  const fields = args.initializer.properties.filter(item => keyName(item) === key.text);
  if (fields.length !== 1 || !ts.isPropertyAssignment(fields[0])) return null;
  const validators = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'convex/values') continue;
    const bindings = statement.importClause?.isTypeOnly ? null : statement.importClause?.namedBindings;
    for (const item of bindings && ts.isNamedImports(bindings) ? bindings.elements : [])
      if (!item.isTypeOnly && (item.propertyName ?? item.name).text === 'v') validators.add(item.name.text);
  }
  const values = node => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      !ts.isIdentifier(node.expression.expression) ||
      !validators.has(node.expression.expression.text) ||
      index.written.has(node.expression.expression.text) ||
      shadowed(node.expression.expression, ast)
    )
      return null;
    const [first] = node.arguments;
    switch (node.expression.name.text) {
      case 'literal':
        return node.arguments.length === 1 && ts.isStringLiteralLike(first) ? [first.text] : null;
      case 'optional': {
        const inner = node.arguments.length === 1 ? values(first) : null;
        return inner && [...inner, 'undefined'];
      }
      case 'union': {
        const all = node.arguments.map(values);
        return all.length && all.every(Boolean) ? [...new Set(all.flat())] : null;
      }
      default:
        return null;
    }
  };
  return values(fields[0].initializer);
}
// The object is the only argument of a call to an imported Convex function builder: one from
// convex/server, the generated server or a convex/ module (custom wrappers keep the args validator).
const builderName = /^(?:(?:internal)?(?:query|mutation|action)|[a-z]\w*(?:Query|Mutation|Action))$/;
function convexBuilder(object, ast) {
  const call = object.parent;
  if (!ts.isCallExpression(call) || call.arguments.length !== 1 || call.arguments[0] !== object) return false;
  if (!ts.isIdentifier(call.expression) || !builderName.test(call.expression.text)) return false;
  const name = call.expression.text;
  if (shadowed(call.expression, ast) || fileIndex(ast).written.has(name)) return false;
  return ast.statements.some(
    statement =>
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      (statement.moduleSpecifier.text === 'convex/server' ||
        (statement.moduleSpecifier.text.startsWith('.') && ast.fileName.startsWith('convex/'))) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(item => !item.isTypeOnly && item.name.text === name),
  );
}
// Any declaration of the name other than an import, anywhere in the file: it may shadow the import at
// this use (scope is not worth proving here, so any such declaration counts).
const shadowed = (identifier, ast) =>
  fileIndex(ast).named.has(identifier.text) || fileIndex(ast).declarations.has(identifier.text);
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
