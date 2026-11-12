// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';
import { resolve } from 'node:path';

function nodes(root, predicate) {
  const result = [];
  const walk = node => {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
  return result;
}
function databaseAdapter(node) {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isNewExpression(parent) && parent.expression.getText() === 'Proxy') return true;
  return false;
}
function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isFunctionLike(parent) && parent.body) return parent;
}
function dominates(proof, sink) {
  let statement = proof;
  while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
  const block = statement.parent;
  for (let parent = sink.parent; parent; parent = parent.parent) if (parent === block) return true;
  return false;
}
const uncast = node => {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node))
  )
    node = node.expression;
  return node;
};

/** Compiler and local value origins for the publication contract guard. */
export function compilerTrace(root, injected) {
  const config = ts.readConfigFile(resolve(root, 'convex/tsconfig.json'), ts.sys.readFile),
    parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(root, 'convex')),
    host = ts.createCompilerHost(parsed.options),
    read = host.readFile,
    extra = new Map(Object.entries(injected).map(([file, body]) => [resolve(root, file), body]));
  host.readFile = file => extra.get(resolve(file)) ?? read(file);
  const program = ts.createProgram([...parsed.fileNames, ...extra.keys()], parsed.options, host),
    checker = program.getTypeChecker();
  const declaration = call => checker.getResolvedSignature(call)?.declaration;
  const symbol = node =>
    node.parent && ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
  const callName = call => {
    const decl = declaration(call);
    return decl?.name?.getText() ?? decl?.parent?.name?.getText();
  };
  const type = node => checker.getTypeAtLocation(node);
  const propertyType = (value, name, at) => {
    const prop = value?.getProperty(name);
    return prop && checker.getTypeOfSymbolAtLocation(prop, at);
  };
  function actual(node, seen = new Set()) {
    node = uncast(node);
    if (node && ts.isIdentifier(node)) {
      const value = symbol(node)?.valueDeclaration;
      if (value?.initializer && !seen.has(value)) {
        seen.add(value);
        return actual(value.initializer, seen);
      }
    }
    return node;
  }
  function fields(node, name) {
    node = actual(node);
    if (!node) return [];
    if (ts.isConditionalExpression(node))
      return [...fields(node.whenTrue, name), ...fields(node.whenFalse, name)];
    if (!ts.isObjectLiteralExpression(node)) return [];
    for (const prop of [...node.properties].reverse()) {
      if (prop.name?.getText() === name)
        return [ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer];
      if (ts.isSpreadAssignment(prop)) {
        const inherited = fields(prop.expression, name);
        if (inherited.length) return inherited;
      }
    }
    return [];
  }
  function keys(node) {
    node = actual(node);
    if (!node) return null;
    if (ts.isConditionalExpression(node)) {
      const a = keys(node.whenTrue),
        b = keys(node.whenFalse);
      return a && b && [...a, ...b];
    }
    if (!ts.isObjectLiteralExpression(node)) return null;
    const result = [];
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const nested = keys(prop.expression);
        if (!nested) return null;
        result.push(...nested);
      } else if (!prop.name || ts.isComputedPropertyName(prop.name)) return null;
      else result.push(prop.name.getText().replace(/^['"]|['"]$/g, ''));
    }
    return result;
  }
  // Resolve const aliases and schema/JSON decoding, retaining the originating
  // parameter or DB call and the exact path through its value.
  function origin(node, path = [], seen = new Set()) {
    node = actual(node, seen);
    if (!node) return null;
    if (ts.isPropertyAccessExpression(node)) return origin(node.expression, [node.name.text, ...path], seen);
    if (path.length && ts.isObjectLiteralExpression(node)) {
      const [next] = fields(node, path[0]);
      if (next) return origin(next, path.slice(1), seen);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'parse' &&
      node.arguments.length === 1
    )
      return origin(node.arguments[0], path, seen);
    return { node, path };
  }
  const same = (a, b) =>
    a &&
    b &&
    a.path.join('.') === b.path.join('.') &&
    (a.node === b.node ||
      (ts.isIdentifier(a.node) && ts.isIdentifier(b.node) && symbol(a.node) === symbol(b.node)));
  const literal = node => {
    node = actual(node);
    return node && ts.isStringLiteralLike(node) ? node.text : null;
  };
  function forwardedParameter(node, target, seen = new Set()) {
    node = uncast(node);
    if (!node || !ts.isIdentifier(node)) return false;
    const decl = symbol(node)?.valueDeclaration;
    if (ts.isParameter(decl)) return true;
    if (!decl?.initializer || seen.has(decl)) return false;
    seen.add(decl);
    const writes = nodes(
      decl.getSourceFile(),
      item =>
        ts.isBinaryExpression(item) &&
        item.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(item.left) &&
        symbol(item.left) === symbol(node),
    );
    for (const write of writes) {
      let guarded = false;
      for (let parent = write.parent; parent; parent = parent.parent) {
        if (!ts.isIfStatement(parent)) continue;
        const condition = uncast(parent.expression);
        if (
          !ts.isBinaryExpression(condition) ||
          condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
          !literal(condition.right) ||
          ['projectHostedChannels', 'projectHostedRecords', 'projectHostedRecordHeads'].includes(
            literal(condition.right),
          )
        )
          continue;
        const kind = origin(condition.left);
        if (!kind || !ts.isCallExpression(kind.node) || !same(origin(kind.node.arguments[0]), origin(target)))
          continue;
        const selector = declaration(kind.node);
        if (
          selector?.body &&
          nodes(
            selector.body,
            check =>
              ts.isCallExpression(check) &&
              ts.isPropertyAccessExpression(check.expression) &&
              check.expression.name.text === 'normalizeId' &&
              ts.isIdentifier(check.arguments[1]) &&
              symbol(check.arguments[1]) === symbol(selector.parameters[0].name),
          ).length
        )
          guarded = true;
      }
      if (!guarded) return false;
    }
    return forwardedParameter(decl.initializer, target, seen);
  }
  const sourceFiles = program
    .getSourceFiles()
    .filter(file =>
      file.fileName.replaceAll('\\', '/').startsWith(resolve(root, 'convex').replaceAll('\\', '/') + '/'),
    );
  const calls = sourceFiles.flatMap(file => nodes(file, ts.isCallExpression));
  return {
    checker,
    declaration,
    callName,
    symbol,
    type,
    propertyType,
    actual,
    fields,
    keys,
    origin,
    same,
    literal,
    forwardedParameter,
    sourceFiles,
    calls,
    nodes,
    enclosingFunction,
    databaseAdapter,
    dominates,
    uncast,
  };
}
