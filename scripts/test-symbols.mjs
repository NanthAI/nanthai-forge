// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Symbol-level reach (5dcfce75). An edge reaches a module at a site; where the site sits decides what
// the change can alter there. Inside a function body (or a value only bound to a name) it alters the
// top-level declarations that refer to it, transitively, and an importer that uses none of the
// exports they make is unaffected. Anything evaluated at load in any other way (a call, a callback
// handed to a call, a getter, a spread) alters the whole module, and a static import of a whole module
// is whole too: without base bytes a changed file is whole, so its importers' load is as well. A
// tainted function only runs when tainted code or load-time code calls it, so references are enough.
// Parse-only, like the graph; type positions carry no runtime reference.
import ts from 'typescript';
import { posix } from 'node:path';

const functionLike = node =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);
const isStatic = node => node.modifiers?.some(item => item.kind === ts.SyntaxKind.StaticKeyword) ?? false;
const decorated = node => (ts.canHaveDecorators(node) ? ts.getDecorators(node)?.length : 0) > 0;
const computedName = node => node.name && ts.isComputedPropertyName(node.name);
const hasModifier = (node, kind) => node.modifiers?.some(item => item.kind === kind) ?? false;

/** Code in `child` runs later than `parent`'s own evaluation: a body, a parameter, an instance field.
 * A parameter decorator runs when the class is defined, so a decorated parameter is not deferred. */
function defers(parent, child) {
  if (functionLike(parent))
    return child === parent.body || (parent.parameters.includes(child) && !decorated(child));
  return ts.isPropertyDeclaration(parent) && child === parent.initializer && !isStatic(parent);
}

/** Evaluating `child` inside `parent` at load only produces a value that `parent` binds or stores. */
function forwards(parent, child) {
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isTypeAssertionExpression(parent)
  )
    return child === parent.expression;
  if (ts.isArrayLiteralExpression(parent)) return !ts.isSpreadElement(child);
  if (ts.isObjectLiteralExpression(parent))
    return (
      (ts.isPropertyAssignment(child) ||
        ts.isShorthandPropertyAssignment(child) ||
        ts.isMethodDeclaration(child) ||
        ts.isGetAccessorDeclaration(child) ||
        ts.isSetAccessorDeclaration(child)) &&
      !computedName(child)
    );
  if (ts.isPropertyAssignment(parent)) return child === parent.initializer;
  if (ts.isShorthandPropertyAssignment(parent))
    return child === parent.name && !parent.objectAssignmentInitializer;
  // Only the chosen value passes on. A condition or left operand decides whether other code runs at
  // load (`late && init()`), so it is not forwarded: a tainted one makes the module whole.
  if (ts.isConditionalExpression(parent)) return child !== parent.condition;
  if (ts.isBinaryExpression(parent))
    return (
      child === parent.right &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.CommaToken,
      ].includes(parent.operatorToken.kind)
    );
  // A destructuring initializer reads properties (getters), so only a plain name binds.
  if (ts.isVariableDeclaration(parent)) return child === parent.initializer && ts.isIdentifier(parent.name);
  if (ts.isVariableDeclarationList(parent) || ts.isVariableStatement(parent)) return true;
  if (ts.isExportAssignment(parent)) return child === parent.expression && !parent.isExportEquals;
  // A class decorator runs at load with the class (and can call any member); so do parameter decorators.
  if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))
    return (
      !decorated(parent) &&
      !child.parameters?.some(decorated) &&
      (ts.isMethodDeclaration(child) ||
        ts.isConstructorDeclaration(child) ||
        ts.isGetAccessorDeclaration(child) ||
        ts.isSetAccessorDeclaration(child) ||
        ts.isPropertyDeclaration(child)) &&
      !computedName(child) &&
      !decorated(child)
    );
  if (ts.isPropertyDeclaration(parent)) return child === parent.initializer && isStatic(parent);
  return false;
}

/** The top-level statement holding `node`, and whether reaching `node` at load can run user code. */
export function siteOf(node) {
  let start = node,
    statement = node;
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isSourceFile(parent)) {
      statement = child;
      break;
    }
    if (defers(parent, child)) start = parent;
  }
  if (!statement.parent || !ts.isSourceFile(statement.parent)) return { statement: -1, run: true };
  // A site that is itself a call (`import.meta.glob(...)`, `require(x)`) runs where it stands.
  let run =
    start === node &&
    (ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isAwaitExpression(node));
  for (let child = start; child !== statement && !run; child = child.parent)
    run = !forwards(child.parent, child);
  // A function body at the top: only a declaration binds it (`export default` of an expression too).
  if (start === statement)
    run = !(
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      (ts.isExportAssignment(statement) && !statement.isExportEquals)
    );
  return { statement: statementIndex(statement), run };
}
const indexes = new WeakMap();
const statementIndex = statement => {
  const file = statement.parent;
  if (!indexes.has(file)) indexes.set(file, new Map(file.statements.map((item, index) => [item, index])));
  return indexes.get(file).get(statement);
};

const bindingNames = (name, names = []) => {
  if (ts.isIdentifier(name)) names.push(name.text);
  else
    for (const element of name.elements)
      if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
};
const DEFAULT = '*default*';

/** Unresolved symbol facts. A specifier can resolve to a different module in the next inventory. */
export function moduleSymbols(ast) {
  const statements = [],
    exports = new Map(),
    imports = [];
  let opaque = false;
  for (const statement of ast.statements) {
    const declares = [];
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const from =
        !clause?.isTypeOnly &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text;
      if (typeof from === 'string') {
        const bindings = [];
        if (clause?.name) bindings.push([clause.name.text, 'default']);
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) bindings.push([named.name.text, '*']);
        else if (named)
          for (const item of named.elements)
            if (!item.isTypeOnly) bindings.push([item.name.text, (item.propertyName ?? item.name).text]);
        imports.push({ from, index: statements.length, bindings });
        declares.push(...bindings.map(([local]) => local));
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        const from = statement.moduleSpecifier.text;
        const clause = statement.exportClause;
        const reexports = [];
        if (clause && ts.isNamespaceExport(clause)) reexports.push(['*', clause.name.text]);
        else if (clause)
          for (const item of clause.elements)
            if (!item.isTypeOnly) reexports.push([(item.propertyName ?? item.name).text, item.name.text]);
        imports.push({ from, star: !clause, reexports });
      } else if (!statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause))
        for (const item of statement.exportClause.elements)
          if (!item.isTypeOnly) exports.set(item.name.text, (item.propertyName ?? item.name).text);
    } else if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) opaque = true;
      declares.push(DEFAULT);
      exports.set('default', DEFAULT);
    } else if (ts.isVariableStatement(statement)) {
      if (!hasModifier(statement, ts.SyntaxKind.DeclareKeyword))
        for (const item of statement.declarationList.declarations) declares.push(...bindingNames(item.name));
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      if (!hasModifier(statement, ts.SyntaxKind.DeclareKeyword))
        declares.push(statement.name && ts.isIdentifier(statement.name) ? statement.name.text : DEFAULT);
    } else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly)
      declares.push(statement.name.text);
    if (exported) for (const name of declares) exports.set(isDefault ? 'default' : name, name);
    statements.push(declares);
  }
  const top = new Set(statements.flat());
  const refs = new Map();
  ast.statements.forEach((statement, index) => {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    )
      return;
    // One pass per statement, as siteOf decides bottom-up: `run` is the node's role at load (inside
    // a function body, the function's own role), `inside` whether a body already holds it.
    const visit = (node, run, inside) => {
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
      if (ts.isWithStatement(node)) opaque = true;
      // `(eval)(...)` is still a direct eval: it reads every binding in scope.
      let callee = ts.isCallExpression(node) || ts.isNewExpression(node) ? node.expression : null;
      while (callee && ts.isParenthesizedExpression(callee)) callee = callee.expression;
      if (callee && ts.isIdentifier(callee) && ['eval', 'Function'].includes(callee.text)) opaque = true;
      if (ts.isIdentifier(node) && top.has(node.text) && reference(node)) {
        // A load-time read makes the whole module reachable. Otherwise each
        // statement only needs one entry, even when it reads a binding repeatedly.
        if (run) refs.set(node.text, null);
        else if (!refs.has(node.text)) refs.set(node.text, new Set([index]));
        else refs.get(node.text)?.add(index);
      }
      ts.forEachChild(node, child =>
        inside
          ? visit(child, run, true)
          : defers(node, child)
            ? visit(child, run, true)
            : visit(child, run || !forwards(node, child), false),
      );
    };
    visit(statement, false, false);
  });
  return { statements, refs, exports, imports, opaque };
}

/** Multiple declarations can resolve to the same target. Merge in source order. */
export function resolveSymbols(facts, resolve) {
  const statements = facts.statements.slice(),
    imports = new Map();
  for (const { from, index, bindings, reexports, star } of facts.imports) {
    const target = resolve(from);
    if (index !== undefined) statements[index] = [];
    if (!target) continue;
    if (!imports.has(target)) imports.set(target, { bindings: [], reexports: [], star: false });
    const entry = imports.get(target);
    if (bindings) {
      entry.bindings.push(...bindings);
      statements[index] = entry.bindings.map(([local]) => local);
    } else {
      entry.reexports.push(...reexports);
      entry.star ||= star;
    }
  }
  return { ...facts, statements, imports };
}

/** A name read, not a declaration, property name or export specifier (exports map those). */
function reference(node) {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent))
    return parent.name === node || parent.objectAssignmentInitializer === node;
  if (ts.isExportSpecifier(parent)) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  // `import x = hub.y` reads `hub` (type positions never reach here).
  if (ts.isQualifiedName(parent)) return parent.left === node;
  if ('name' in parent && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  return !(ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent));
}

export const wholeTaint = Object.freeze({ whole: true, names: null });
const emptyNames = Object.freeze(new Set());

/** The module's taint from its entries: whole, or the exported names whose behaviour may differ. */
export function moduleTaint(info, entries) {
  if (
    entries.whole ||
    (info.opaque && (entries.statements.size || entries.locals.size || entries.exports.size))
  )
    return wholeTaint;
  const locals = new Set(),
    done = new Set(),
    queue = [];
  const taintStatement = index => {
    if (done.has(index)) return;
    done.add(index);
    for (const name of info.statements[index] ?? [])
      if (!locals.has(name)) (locals.add(name), queue.push(name));
  };
  for (const index of entries.statements) taintStatement(index);
  for (const name of entries.locals) if (!locals.has(name)) (locals.add(name), queue.push(name));
  while (queue.length) {
    const statements = info.refs.get(queue.pop());
    if (statements === null) return wholeTaint;
    for (const index of statements ?? []) taintStatement(index);
  }
  const names = new Set(entries.exports);
  for (const [name, local] of info.exports) if (locals.has(local)) names.add(name);
  return { whole: false, names: names.size ? names : emptyNames };
}

const kindOf = path =>
  /\.[cm]?tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(path)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
/** Exports of a module with the text of the statement that declares each (whitespace folded). */
function exportBodies(path, text) {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kindOf(path));
  const facts = moduleSymbols(ast);
  const bodies = new Map();
  ast.statements.forEach((statement, index) => {
    const body = statement.getText(ast).replace(/\s+/g, ' ');
    for (const name of facts.statements[index]) bodies.set(name, body);
  });
  return new Map([...facts.exports].map(([name, local]) => [name, bodies.get(local) ?? local]));
}
/** Export names whose declaring statement differs between `before` and `after`, or that one side lacks.
 * An unexported helper an export calls is not compared here: that reach is `moduleTaint`'s. */
export function changedExports(path, before, after) {
  const left = exportBodies(path, before);
  const right = exportBodies(path, after);
  return [...new Set([...left.keys(), ...right.keys()])].filter(name => left.get(name) !== right.get(name));
}
/** Past this many altered exports the module was rewritten, and the whole-module reach already covers it. */
const MOST_ALTERED_EXPORTS = 40;
const segments = path => path.replace(/\.[^./]+$/, '').split('/');
const sameSegments = (a, b) => a.length === b.length && a.every((part, index) => part === b[index]);
/** `specifier`, imported by `test`, names the changed module: the same path, or its build output (the
 * tests import `dist/x.js` for `src/x.ts`). Never a module of the same file name elsewhere. */
function reaches(test, specifier, changedPath) {
  if (!specifier.startsWith('.')) return false;
  const resolved = segments(posix.normalize(posix.join(posix.dirname(test), specifier)));
  const changed = segments(changedPath);
  return (
    sameSegments(resolved, changed) ||
    (changed[0] === 'src' && resolved[0] === 'dist' && sameSegments(resolved.slice(1), changed.slice(1)))
  );
}
/** Tests whose own source imports an altered export of a changed module by name (a default import may
 * come first: `import d, { a }`). `changed`: path -> altered export names. */
export function namedConsumers({ files, tests, changed }) {
  const found = new Set();
  if (!changed?.size) return found;
  const wanted = [...changed]
    .map(([path, altered]) => [path, new Set(altered.filter(name => name !== 'default'))])
    .filter(([, names]) => names.size && names.size <= MOST_ALTERED_EXPORTS);
  if (!wanted.length) return found;
  const importPattern = /import\s*(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const test of tests) {
    const text = files.get(test);
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(importPattern)) {
      const imported = match[1].split(',').map(item =>
        item
          .trim()
          .split(/\s+as\s+/)[0]
          .replace(/^type\s+/, ''),
      );
      for (const [path, names] of wanted)
        if (imported.some(name => names.has(name)) && reaches(test, match[2], path)) found.add(test);
    }
  }
  return found;
}
