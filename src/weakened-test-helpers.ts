// SPDX-License-Identifier: Apache-2.0
import type ts from 'typescript';
import { loadTypescript } from './lazy-typescript.js';

type Helper = ts.FunctionLikeDeclaration;
type Bindings = { outer: Bindings | undefined; names: Map<string, Helper | null> };

/** Index declarations before visiting the scope, so a call can precede its helper declaration.
 * A non-function binding still shadows any helper with the same name in an outer scope. */
export function helperBindings(
  node: ts.Node,
  outer: Bindings | undefined,
  helpers: WeakMap<ts.Node, Bindings>,
  indexDeclarations: boolean,
) {
  const ts = loadTypescript();
  const names = new Map<string, Helper | null>();
  const bind = (name: ts.BindingName, helper: Helper | null = null) => {
    if (ts.isIdentifier(name)) {
      names.set(name.text, helper);
    } else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  if (ts.isFunctionLike(node)) {
    if (ts.isFunctionExpression(node) && node.name) bind(node.name, helpers.has(node) ? node : null);
    for (const parameter of node.parameters) bind(parameter.name);
  } else if (ts.isSourceFile(node) || ts.isBlock(node)) {
    for (const statement of node.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
        bind(statement.name, indexDeclarations ? statement : null);
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) {
          const value = declaration.initializer;
          bind(
            declaration.name,
            indexDeclarations && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
              ? value
              : null,
          );
        }
    }
  }
  if (!names.size) return outer;
  const scope = { outer, names };
  if (indexDeclarations && (ts.isSourceFile(node) || ts.isBlock(node)))
    for (const helper of names.values()) if (helper) helpers.set(helper, scope);
  return scope;
}

export function findTestHelper(node: ts.Node, scope: Bindings | undefined): Helper | undefined {
  const ts = loadTypescript();
  if (!ts.isIdentifier(node)) return;
  for (let current = scope; current; current = current.outer) {
    const found = current.names.get(node.text);
    if (found !== undefined) return found ?? undefined;
  }
}

export type TestChecks = {
  /** Counts at or above assertion ranks 1 (all assertions), 2, 3 and 4. */
  assertions: [number, number, number, number];
  skips: number;
  conditional: number;
  returns: number;
  patterns: number;
  only: boolean;
  calls: Helper[];
  /** Index of the first helper call after an unconditional bare return, if one was seen. */
  returnBefore?: number;
};

type Assertions = TestChecks['assertions'];

function addAssertions(target: Assertions, source: Assertions) {
  // The static call graph can describe more calls than fit in a number, without executing any.
  for (const level of [0, 1, 2, 3] as const)
    target[level] = Math.min(target[level] + source[level], Number.MAX_SAFE_INTEGER);
}

function addSignals(target: TestChecks, source: TestChecks) {
  target.skips += source.skips;
  target.conditional += source.conditional;
  target.patterns += source.patterns;
  target.only ||= source.only;
}

/** Find the groups of mutually recursive helpers in two iterative graph walks. The first finishing
 * order also visits every non-recursive callee before its caller, for assertion counting. */
function helperOrder(helpers: ReadonlyMap<ts.Node, TestChecks>) {
  const seen = new Set<ts.Node>();
  const order: ts.Node[] = [];
  const callers = new Map<ts.Node, ts.Node[]>();
  for (const root of helpers.keys()) {
    if (seen.has(root)) continue;
    seen.add(root);
    const stack = [{ node: root, next: 0 }];
    while (stack.length) {
      const frame = stack.at(-1)!;
      const callee = helpers.get(frame.node)!.calls[frame.next++];
      if (!callee) {
        order.push(frame.node);
        stack.pop();
      } else if (helpers.has(callee)) {
        const incoming = callers.get(callee);
        if (incoming) incoming.push(frame.node);
        else callers.set(callee, [frame.node]);
        if (!seen.has(callee)) {
          seen.add(callee);
          stack.push({ node: callee, next: 0 });
        }
      }
    }
  }
  const group = new Map<ts.Node, ts.Node>();
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i]!;
    if (group.has(root)) continue;
    group.set(root, root);
    const stack = [root];
    for (let node = stack.pop(); node; node = stack.pop())
      for (const caller of callers.get(node) ?? []) {
        if (group.has(caller)) continue;
        group.set(caller, root);
        stack.push(caller);
      }
  }
  return { order, group };
}

function creditCalls(
  item: TestChecks,
  total: Assertions,
  resolve: (callee: Helper) => Assertions | undefined,
) {
  let earlyReturn = false;
  for (const [index, call] of item.calls.entries()) {
    const assertions = resolve(call);
    if (!assertions) continue;
    addAssertions(total, assertions);
    earlyReturn ||= item.returnBefore !== undefined && index >= item.returnBefore && assertions[0] > 0;
  }
  if (earlyReturn) item.returns++;
}

/** Assertions count for each call site, with recursive edges omitted because their call counts are
 * only known at runtime. Skips and filters count once per reachable helper, even with recursion. */
export function creditTestHelpers(
  tests: Iterable<TestChecks>,
  outside: TestChecks,
  helpers: ReadonlyMap<ts.Node, TestChecks>,
) {
  const { order, group } = helperOrder(helpers);
  const totals = new Map<ts.Node, Assertions>();
  for (const node of order) {
    const item = helpers.get(node)!;
    const total: Assertions = [...item.assertions];
    creditCalls(item, total, callee =>
      group.get(node) === group.get(callee) ? undefined : totals.get(callee),
    );
    totals.set(node, total);
  }
  const reached = new Set<ts.Node>();
  for (const test of tests) {
    if (test === outside || !test.calls.length) continue;
    creditCalls(test, test.assertions, callee => totals.get(callee));
    const seen = new Set<ts.Node>();
    const stack = [...test.calls];
    for (let node = stack.pop(); node; node = stack.pop()) {
      const helper = helpers.get(node);
      if (!helper || seen.has(node)) continue;
      seen.add(node);
      reached.add(node);
      addSignals(test, helper);
      test.returns += helper.returns;
      for (const callee of helper.calls) stack.push(callee);
    }
  }
  // Uncalled helpers keep their own counts at file scope. Their returns only end themselves.
  for (const [node, helper] of helpers)
    if (!reached.has(node)) {
      addAssertions(outside.assertions, helper.assertions);
      addSignals(outside, helper);
    }
}
