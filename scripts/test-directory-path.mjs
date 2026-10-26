// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';

// Follow directory-valued expressions without executing them. Building a path
// used only for string comparison is not a read of every module in that folder.
// Escaping values and unsupported uses remain directory dependencies.
export function directoryDependency(literal, ast) {
  const identifiers = new Map(),
    functions = new Map(),
    initializers = new Map(),
    pathFunctions = new Set(),
    declarations = [],
    writes = new Set();
  const declare = (name, initializer) => {
    if (!ts.isIdentifier(name)) return;
    declarations.push(name);
    initializers.set(name.text, initializers.has(name.text) ? null : initializer);
  };
  function scan(node) {
    if (ts.isImportClause(node) && node.name) declarations.push(node.name);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) declarations.push(node.name);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isIdentifier(node.left)) writes.add(node.left.text);
      if (ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression))
        writes.add(node.left.expression.text);
    }
    if (ts.isImportDeclaration(node) && ['node:path', 'node:url'].includes(node.moduleSpecifier.text)) {
      for (const specifier of node.importClause?.namedBindings?.elements ?? []) {
        if (
          ['resolve', 'join', 'normalize', 'dirname', 'basename', 'fileURLToPath', 'pathToFileURL'].includes(
            (specifier.propertyName ?? specifier.name).text,
          )
        )
          pathFunctions.add(specifier.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) declare(node.name, node.initializer);
    if ((ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name)
      declarations.push(node.name);
    if (ts.isIdentifier(node)) {
      if (!identifiers.has(node.text)) identifiers.set(node.text, []);
      identifiers.get(node.text).push(node);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (functions.has(node.name.text)) functions.set(node.name.text, null);
      else functions.set(node.name.text, node);
    }
    ts.forEachChild(node, scan);
  }
  scan(ast);
  for (const name of writes) initializers.delete(name);
  const scope = name => {
    let parent = name.parent;
    if (ts.isFunctionDeclaration(parent)) parent = parent.parent;
    while (parent && !ts.isSourceFile(parent) && !ts.isBlock(parent) && !ts.isFunctionLike(parent))
      parent = parent.parent;
    return parent;
  };
  const binding = name => {
    for (let parent = name.parent; parent; parent = parent.parent) {
      const matches = declarations.filter(item => item.text === name.text && scope(item) === parent);
      if (matches.length) return matches.length === 1 ? matches[0] : null;
    }
    return undefined;
  };
  const pathFunction = name => {
    if (!ts.isIdentifier(name) || !pathFunctions.has(name.text)) return false;
    const declared = binding(name);
    return declared && ts.isImportSpecifier(declared.parent);
  };
  function value(node, active = new Set()) {
    if (!node || active.has(node)) return '';
    active = new Set([...active, node]);
    if (ts.isIdentifier(node)) return value(initializers.get(node.text), active);
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return 'string';
    if (ts.isArrayLiteralExpression(node)) return 'array';
    if (ts.isRegularExpressionLiteral(node)) return 'regexp';
    if (ts.isParenthesizedExpression(node)) return value(node.expression, active);
    if (ts.isElementAccessExpression(node) && value(node.expression, active) === 'match') return 'string';
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        if (pathFunction(node.expression)) return 'string';
        if (node.expression.text === 'Set' && binding(node.expression) === undefined) return 'set';
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = value(node.expression.expression, active),
          name = node.expression.name.text;
        if ((receiver === 'regexp' && name === 'exec') || (receiver === 'string' && name === 'match'))
          return 'match';
        if (
          receiver === 'string' &&
          ['replace', 'replaceAll', 'slice', 'substring', 'concat', 'toString'].includes(name)
        )
          return 'string';
      }
    }
    return '';
  }
  const queue = [literal],
    seen = new Set();
  const alias = name => {
    if (!ts.isIdentifier(name)) return false;
    queue.push(...(identifiers.get(name.text) ?? []).filter(node => node !== name));
    return true;
  };
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (seen.has(node)) continue;
    seen.add(node);
    const parent = node.parent;
    if (!parent) return true;
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.initializer === node) {
      if (
        ts.isVariableDeclaration(parent) &&
        ts.isVariableDeclarationList(parent.parent) &&
        ts.isVariableStatement(parent.parent.parent) &&
        parent.parent.parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
        return true;
      if (!alias(parent.name)) return true;
    } else if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const expression = parent.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : '';
      const local = ts.isIdentifier(expression) && functions.get(name);
      if (local) {
        const index = parent.arguments?.indexOf(node);
        if (index < 0 || !local.parameters[index] || !alias(local.parameters[index].name)) return true;
        continue;
      }
      const method = ts.isPropertyAccessExpression(expression);
      const receiver = method ? value(expression.expression) : '';
      const predicates =
        receiver === 'set'
          ? ['has']
          : receiver === 'array'
            ? ['includes', 'indexOf', 'lastIndexOf']
            : receiver === 'regexp'
              ? ['test']
              : receiver === 'string'
                ? ['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf']
                : [];
      if (predicates.includes(name)) continue;
      if (
        pathFunction(expression) ||
        (ts.isNewExpression(parent) && ['URL', 'Set'].includes(name) && binding(expression) === undefined) ||
        (receiver === 'string' &&
          ['replace', 'replaceAll', 'slice', 'substring', 'split', 'concat', 'toString', 'match'].includes(
            name,
          ))
      )
        queue.push(parent);
      else return true;
    } else if (ts.isPropertyAccessExpression(parent)) {
      if (parent.name === node || parent.name.text === 'length') continue;
      queue.push(parent);
    } else if (ts.isBinaryExpression(parent)) {
      if (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
        if (!alias(parent.left)) return true;
      } else if (parent.operatorToken.kind === ts.SyntaxKind.PlusToken) queue.push(parent);
      else if (
        ![
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(parent.operatorToken.kind)
      )
        return true;
    } else if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) {
      // Declaration names aren't reads. Other aliases with the same spelling
      // were included above, conservatively across lexical scopes.
      continue;
    } else if (
      ts.isArrayLiteralExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isTemplateExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    )
      queue.push(parent);
    else return true;
  }
  return false;
}
