// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';

// Follow directory-valued expressions without executing them. Building a path
// used only for string comparison is not a read of every module in that folder.
// Escaping values and unsupported uses remain directory dependencies. An optional
// reader set follows aliases to those directory APIs instead of treating metadata
// and unrelated calls as directory reads. Exported path values still escape.
export function directoryDependency(literal, ast, requireComparison = false, readers, rootListings) {
  const { identifiers, functions, initializers, pathFunctions, declarations } = directoryBindings(ast);
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
  const initializer = name => {
    const declared = ts.isIdentifier(name) && binding(name);
    return declared && ts.isVariableDeclaration(declared.parent) ? declared.parent.initializer : undefined;
  };
  const readerCall = (expression, seen = new Set()) => {
    if (!expression || seen.has(expression)) return false;
    seen.add(expression);
    if (ts.isPropertyAccessExpression(expression)) return readers.has(expression.name.text);
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression))
      return readers.has(expression.argumentExpression.text);
    if (ts.isParenthesizedExpression(expression)) return readerCall(expression.expression, seen);
    if (!ts.isIdentifier(expression)) return false;
    if (readers.has(expression.text)) return true;
    const declared = binding(expression);
    if (declared && ts.isImportSpecifier(declared.parent))
      return readers.has((declared.parent.propertyName ?? declared.parent.name).text);
    return readerCall(initializer(expression), seen);
  };
  const pathFunction = name => {
    const object = ts.isPropertyAccessExpression(name) ? name.expression : name;
    if (!ts.isIdentifier(object)) return false;
    const qualified = ts.isPropertyAccessExpression(name) ? `${object.text}.${name.name.text}` : object.text;
    if (!pathFunctions.has(qualified)) return false;
    const declared = binding(object);
    return (
      declared &&
      (ts.isImportSpecifier(declared.parent) ||
        ts.isNamespaceImport(declared.parent) ||
        ts.isImportClause(declared.parent))
    );
  };
  const computedPath = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (ts.isIdentifier(node)) return computedPath(initializer(node), seen);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
      return computedPath(node.expression, seen);
    // A computed repository root before the folder does not make the filename
    // computed: join(root, 'scripts', 'tool.mjs') names that tool, not all JSON.
    const contains = part => part.pos <= literal.pos && part.end >= literal.end;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return (contains(node.left) && !ts.isStringLiteralLike(node.right)) || computedPath(node.left, seen);
    if (ts.isCallExpression(node) && pathFunction(node.expression)) {
      const index = node.arguments.findIndex(contains);
      return (
        index >= 0 && node.arguments.slice(index + 1).some(argument => !ts.isStringLiteralLike(argument))
      );
    }
    return false;
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
  let compared = false;
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
    if (!parent) {
      if (!readers) return true;
      continue;
    }
    if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.initializer === node) {
      if (
        ts.isVariableDeclaration(parent) &&
        ts.isVariableDeclarationList(parent.parent) &&
        ts.isVariableStatement(parent.parent.parent) &&
        parent.parent.parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      )
        return true;
      if (!alias(parent.name) && !readers) return true;
    } else if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      // Recursive root listings already have edges from the actual listing site.
      if (rootListings?.has(parent)) continue;
      const expression = parent.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : '';
      if (readers && readerCall(expression)) return true;
      // A computed filename can name any JSON in the literal folder. Once that
      // assembled path escapes to a call, an unknown loader must retain it too.
      if (
        readers &&
        computedPath(node) &&
        !pathFunction(expression) &&
        !(name === 'RegExp' && binding(expression) === undefined)
      )
        return true;
      const initialized = readers && initializer(expression);
      const local =
        ts.isIdentifier(expression) &&
        (functions.get(name) ||
          (initialized && (ts.isArrowFunction(initialized) || ts.isFunctionExpression(initialized))
            ? initialized
            : null));
      if (local) {
        const index = parent.arguments?.indexOf(node);
        if (index < 0 || !local.parameters[index] || !alias(local.parameters[index].name)) {
          if (!readers) return true;
        }
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
      if (predicates.includes(name)) {
        compared = true;
        continue;
      }
      if (
        pathFunction(expression) ||
        (ts.isNewExpression(parent) && ['URL', 'Set'].includes(name) && binding(expression) === undefined) ||
        (receiver === 'string' &&
          ['replace', 'replaceAll', 'slice', 'substring', 'split', 'concat', 'toString', 'match'].includes(
            name,
          ))
      )
        queue.push(parent);
      else if (!readers) return true;
    } else if (ts.isPropertyAccessExpression(parent)) {
      if (parent.name === node || parent.name.text === 'length') continue;
      queue.push(parent);
    } else if (ts.isBinaryExpression(parent)) {
      if (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
        if (!alias(parent.left) && !readers) return true;
      } else if (parent.operatorToken.kind === ts.SyntaxKind.PlusToken) queue.push(parent);
      else if (
        ![
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(parent.operatorToken.kind)
      ) {
        if (!readers) return true;
      } else compared = true;
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
    else if (!readers) return true;
  }
  return readers ? false : requireComparison && !compared;
}

const bindingMemo = new WeakMap();
function directoryBindings(ast) {
  if (bindingMemo.has(ast)) return bindingMemo.get(ast);
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
      const methods = [
        'resolve',
        'join',
        'normalize',
        'dirname',
        'basename',
        'fileURLToPath',
        'pathToFileURL',
      ];
      for (const specifier of node.importClause?.namedBindings?.elements ?? [])
        if (methods.includes((specifier.propertyName ?? specifier.name).text))
          pathFunctions.add(specifier.name.text);
      const bindings = node.importClause?.namedBindings;
      const namespace =
        node.importClause?.name ?? (bindings && ts.isNamespaceImport(bindings) ? bindings.name : null);
      if (namespace) for (const method of methods) pathFunctions.add(`${namespace.text}.${method}`);
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
  const bindings = { identifiers, functions, initializers, pathFunctions, declarations };
  bindingMemo.set(ast, bindings);
  return bindings;
}

export const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A source module is also addressable by its built name. (No path template here:
// this file's own text would widen like any computed path.)
export const builtNames = path =>
  /^src\/.+\.ts$/.test(path)
    ? [path, path.replace(/^src\/(.+)\.ts$/, 'dist/$1.js'), path.replace(/^src\/(.+)\.ts$/, 'dist/$1.d.ts')]
    : [path];

// Product code resolves a repository-relative path ('convex/schema.ts') in the workspace
// it is given; only module-relative paths ('./worker.js', '../package.json') name its own files.
export const pathKind = (path, value) =>
  /^(?:src|web\/src|convex|netlify)\//.test(path) && !value.startsWith('.')
    ? 'workspace-path'
    : 'runtime-path';

// This package's own name resolves through its exports map (package-smoke loads it so).
export function packageSelf(files) {
  try {
    const manifest = JSON.parse(files.get('package.json'));
    const exports = typeof manifest.exports === 'string' ? { '.': manifest.exports } : manifest.exports;
    if (typeof manifest.name !== 'string' || !exports || typeof exports !== 'object') return null;
    const target = value =>
      typeof value === 'string'
        ? value
        : value && typeof value === 'object'
          ? target(value.default ?? value.import)
          : null;
    return {
      name: manifest.name,
      exports: new Map(
        Object.entries(exports)
          .map(([key, value]) => [key, target(value)])
          .filter(([key, value]) => key.startsWith('.') && !key.includes('*') && value?.startsWith('./')),
      ),
    };
  } catch {
    return null;
  }
}

// A file's own helper named require (function require(value, message)) loads no module.
// A createRequire binding is a loader, so any such binding keeps require a loader.
export function shadowsRequire(ast) {
  if (!/\b(?:function|const|let|var)\s+require\b|[(,]\s*require\s*[,):]/.test(ast.text)) return false;
  let local = false,
    loader = false;
  const visit = node => {
    const name = node.name && ts.isIdentifier(node.name) ? node.name.text : null;
    if (name === 'require') {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        /\bcreateRequire\b/.test(node.initializer.getText())
      )
        loader = true;
      else if (ts.isFunctionDeclaration(node) || ts.isParameter(node) || ts.isVariableDeclaration(node))
        local = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return local && !loader;
}

// Tests and scripts that make this repository a workspace: they name its root,
// or spawn children in the inherited working directory.
export function repositoryWorkspaceUsers(files) {
  return new Set(
    [...files.keys()].filter(path => {
      if (!/^(?:tests|scripts)\/.+\.[cm]?[jt]sx?$/.test(path)) return false;
      const text = files.get(path);
      return (
        /process\.cwd\(\)|new URL\(\s*['"]\.\.?\/?['"]\s*,\s*import\.meta\.url|import\.meta\.dirname\s*,\s*['"]\.\.\/?['"]/.test(
          text,
        ) ||
        (/\b(?:spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\s*\(/.test(text) &&
          !/\bcwd\b/.test(text))
      );
    }),
  );
}
