// SPDX-License-Identifier: Apache-2.0
// Syntax facts for the weakened-test detector (Issue 11901a0c): what is a test call, what is an
// assertion and how much each assertion pins down. Parsing only; nothing runs.
import type ts from 'typescript';
import { loadTypescript } from './lazy-typescript.js';

const TEST_FUNCTIONS = new Set(['test', 'it', 'describe', 'suite', 'context', 'specify']);
const SKIP_PREFIXED = new Set(['xit', 'xtest', 'xdescribe', 'xcontext']);
const ONLY_PREFIXED = new Set(['fit', 'ftest', 'fdescribe']);
const MODIFIERS = new Set(
  'skip todo only each for skipIf runIf concurrent sequential serial fails failing'.split(' '),
);
const ASSERT_MODULES = new Set(['assert', 'node:assert', 'assert/strict', 'node:assert/strict']);
const TEST_MODULES = new Set(['node:test', 'vitest', '@jest/globals', 'bun:test', 'mocha']);
/** How much an assertion pins down: 4 exact and strict, 3 exact, 2 partial or pattern, 1 a bound,
 * a truthiness or a negation. Unknown methods of an assert object count as 3. */
const RANKS = new Map(
  (
    [
      [4, 'strictEqual deepStrictEqual toStrictEqual toBe toBeNull toBeUndefined toBeNaN toHaveLength'],
      [4, 'toHaveBeenCalledTimes toMatchSnapshot toMatchInlineSnapshot'],
      [3, 'equal deepEqual toEqual fail ifError assertions'],
      [2, 'match toMatch toMatchObject toContain toContainEqual partialDeepStrictEqual toHaveProperty'],
      [2, 'toHaveBeenCalledWith toBeInstanceOf toSatisfy hasAssertions throws rejects toThrow toThrowError'],
      [1, 'ok toBeTruthy toBeFalsy toBeDefined toBeGreaterThan toBeGreaterThanOrEqual toBeLessThan'],
      [1, 'toBeLessThanOrEqual toBeCloseTo toHaveBeenCalled toBeTypeOf notEqual notStrictEqual notDeepEqual'],
      [1, 'notDeepStrictEqual doesNotThrow doesNotReject doesNotMatch'],
    ] as const
  ).flatMap(([rank, names]) => names.split(' ').map(name => [name, rank] as const)),
);
const TRUTHY = new Set(['ok', 'toBeTruthy']);

export function parse(path: string, text: string) {
  const ts = loadTypescript();
  const kind = /\.[cm]?tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(path)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(path)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  return (source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length ? null : source;
}

const unwrap = (node: ts.Expression): ts.Expression => {
  const ts = loadTypescript();
  while (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node))
    node = node.expression;
  return node;
};

/** Strength of `ok(expression)`: an equality pins a value, a bound or a plain truthiness does not. */
function truthyRank(node: ts.Expression | undefined): number {
  const ts = loadTypescript();
  if (!node) return 1;
  node = unwrap(node);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return 4;
    if (op === ts.SyntaxKind.EqualsEqualsToken) return 3;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken)
      return Math.max(truthyRank(node.left), truthyRank(node.right));
    if (op === ts.SyntaxKind.InstanceOfKeyword || op === ts.SyntaxKind.InKeyword) return 2;
    return 1;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const name = node.expression.name.text;
    if (name === 'is' || name === 'isDeepStrictEqual') return 4;
    if (['includes', 'has', 'test', 'startsWith', 'endsWith', 'some', 'every', 'match'].includes(name))
      return 2;
  }
  return 1;
}

type FileContext = {
  strict: boolean;
  objects: Set<string>;
  functions: Map<string, string>;
  /** File-scope names bound to a test function and its modifiers (`const it = baseIt.skip`). */
  tests: Map<string, string[]>;
};

export function fileContext(source: ts.SourceFile): FileContext {
  const ts = loadTypescript();
  const context: FileContext = {
    strict: false,
    objects: new Set(['assert']),
    functions: new Map(),
    tests: new Map(),
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        let value = declaration.initializer && unwrap(declaration.initializer);
        // `const myTest = test.extend(...)` is the test function with fixtures.
        if (
          value &&
          ts.isCallExpression(value) &&
          ts.isPropertyAccessExpression(value.expression) &&
          value.expression.name.text === 'extend'
        )
          value = value.expression.expression;
        const modifiers = value && calleeModifiers(value, context);
        if (ts.isIdentifier(declaration.name) && modifiers)
          context.tests.set(declaration.name.text, modifiers);
      }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (TEST_MODULES.has(module)) {
      const clause = statement.importClause;
      if (clause?.name && module === 'node:test') context.tests.set(clause.name.text, []);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) {
          const imported = calleeModifiers((element.propertyName ?? element.name) as ts.Identifier, context);
          if (imported && element.propertyName) context.tests.set(element.name.text, imported);
        }
      continue;
    }
    if (!ASSERT_MODULES.has(module)) continue;
    if (module.endsWith('/strict')) context.strict = true;
    const clause = statement.importClause;
    if (clause?.name) context.objects.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) context.objects.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === 'strict') {
          context.strict = true;
          context.objects.add(element.name.text);
        } else context.functions.set(element.name.text, imported);
      }
  }
  return context;
}

function methodRank(name: string, call: ts.CallExpression, context: FileContext, subject?: ts.Expression) {
  if (TRUTHY.has(name)) return truthyRank(subject ?? call.arguments[0]);
  if ((name === 'equal' || name === 'deepEqual') && context.strict) return 4;
  if ((name === 'throws' || name === 'rejects') && call.arguments.length < 2) return 1;
  if ((name === 'toThrow' || name === 'toThrowError') && !call.arguments.length) return 1;
  return RANKS.get(name) ?? 3;
}

/** The strength of an assertion call, or null when the call asserts nothing. */
export function assertionRank(call: ts.CallExpression, context: FileContext): number | null {
  const ts = loadTypescript();
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const name = callee.text;
    if (context.objects.has(name)) return truthyRank(call.arguments[0]);
    const imported = context.functions.get(name);
    if (imported) return methodRank(imported, call, context);
    return /^(?:assert|expect)[A-Z0-9_]/.test(name) ? 3 : null;
  }
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  // expect(subject)[.not|.resolves|.rejects].matcher(...)
  let object: ts.Expression = callee.expression;
  let negated = false;
  while (ts.isPropertyAccessExpression(object) && ['not', 'resolves', 'rejects'].includes(object.name.text)) {
    negated ||= object.name.text === 'not';
    object = object.expression;
  }
  if (ts.isCallExpression(object)) {
    const head = object.expression;
    const expectCall =
      (ts.isIdentifier(head) && head.text === 'expect') ||
      (ts.isPropertyAccessExpression(head) &&
        ts.isIdentifier(head.expression) &&
        head.expression.text === 'expect');
    if (expectCall) return negated ? 1 : methodRank(method, call, context, object.arguments[0]);
  }
  if (ts.isIdentifier(object) && object.text === 'expect') return RANKS.get(method) ?? null;
  // assert.x, t.assert.x, assert.strict.x
  const owner = ts.isPropertyAccessExpression(object)
    ? object.name.text
    : ts.isIdentifier(object)
      ? object.text
      : '';
  // `assert.strict.x` only: `schema.strict.parse()` asserts nothing.
  const strict =
    owner === 'strict' &&
    ts.isPropertyAccessExpression(object) &&
    ts.isIdentifier(object.expression) &&
    context.objects.has(object.expression.text);
  if (strict || (owner !== 'strict' && (owner === 'assert' || context.objects.has(owner))))
    return methodRank(method, call, strict ? { ...context, strict: true } : context);
  return null;
}

type TestCall = {
  name: string;
  skips: number;
  conditional: number;
  only: boolean;
  fn?: ts.FunctionLikeDeclaration;
  /** A test body passed by reference (`test('t', runCase)` or a factory call). */
  ref?: ts.Expression;
};

/** Modifiers of a test callee (`test`, `it.skip`, `describe.each(table)`, `t.test`, a file-scope
 * alias), or null. */
function calleeModifiers(node: ts.Expression, context: FileContext): string[] | null {
  const ts = loadTypescript();
  if (ts.isIdentifier(node)) {
    const alias = context.tests.get(node.text);
    if (alias) return alias;
    if (TEST_FUNCTIONS.has(node.text)) return [];
    if (SKIP_PREFIXED.has(node.text)) return ['skip'];
    if (ONLY_PREFIXED.has(node.text)) return ['only'];
    return null;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const name = node.name.text;
    if (MODIFIERS.has(name)) {
      const inner = calleeModifiers(node.expression, context);
      return inner && [...inner, name];
    }
    // node:test subtests: t.test(...), t.describe(...)
    if ((name === 'test' || name === 'describe' || name === 'it') && ts.isIdentifier(node.expression))
      return [];
    return null;
  }
  if (ts.isCallExpression(node)) {
    const inner = calleeModifiers(node.expression, context);
    const last = inner?.at(-1);
    return inner && last && ['each', 'for', 'skipIf', 'runIf'].includes(last) ? inner : null;
  }
  return null;
}

export function testCall(
  call: ts.CallExpression,
  source: ts.SourceFile,
  context: FileContext,
): TestCall | null {
  const ts = loadTypescript();
  const modifiers = calleeModifiers(call.expression, context);
  if (!modifiers) return null;
  const fn = call.arguments.find(
    (arg): arg is ts.ArrowFunction | ts.FunctionExpression =>
      ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
  );
  const first = call.arguments[0];
  const literal = (node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
    !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
  // A named test whose body is passed by reference; never `pattern.test(value)`.
  const last = call.arguments.at(-1);
  const ref =
    !fn &&
    (literal(first) || (first && ts.isTemplateExpression(first))) &&
    last !== first &&
    !(ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'test') &&
    last &&
    (ts.isIdentifier(last) || ts.isCallExpression(last) || ts.isPropertyAccessExpression(last))
      ? last
      : undefined;
  if (!fn && !ref && !modifiers.includes('todo')) return null;
  const name =
    !first || first === fn || ts.isObjectLiteralExpression(first)
      ? '<anonymous>'
      : literal(first)
        ? first.text
        : first.getText(source).slice(0, 120);
  const result: TestCall = {
    name,
    ...(ref ? { ref } : {}),
    skips: modifiers.filter(m => m === 'skip' || m === 'todo').length,
    conditional: modifiers.filter(m => m === 'skipIf' || m === 'runIf').length,
    only: modifiers.includes('only'),
    ...(fn ? { fn } : {}),
  };
  for (const arg of call.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const property of arg.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
      const option = property.name.text;
      if (option !== 'skip' && option !== 'todo' && option !== 'only') continue;
      const value = property.initializer;
      if (value.kind === ts.SyntaxKind.FalseKeyword) continue;
      const literal = value.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteralLike(value);
      if (option === 'only') result.only = true;
      else if (literal) result.skips++;
      else result.conditional++;
    }
  }
  return result;
}
