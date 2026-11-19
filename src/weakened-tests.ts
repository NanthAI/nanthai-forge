// SPDX-License-Identifier: Apache-2.0
// Weakened-test detector (Issue 11901a0c): compares a changed test file with its base version and
// names, by file and test only, assertions that were removed or loosened, skips that were added and
// tests whose input changed while their assertions stayed the same. Static: it parses, never runs.
import type ts from 'typescript';
import { loadTypescript } from './lazy-typescript.js';
import { assertionRank, fileContext, parse, testCall } from './weakened-test-syntax.js';

type WeakenedKind =
  | 'assertions-removed'
  | 'assertion-loosened'
  | 'test-removed'
  | 'skip-added'
  | 'name-pattern-narrowed'
  | 'only-added'
  | 'input-changed';
export type WeakenedFlag = {
  file: string;
  test: string;
  kind: WeakenedKind;
  /** Set on `input-changed`: a reason to look, not evidence of a weaker test. */
  hint?: true;
  /** Assertion calls before and after (counts, never values). */
  assertions?: { before: number; after: number };
};
export type TestFileChange = { path: string; before: string | null; after: string | null };

/** The pseudo-test that holds file-scope code (helpers, shared fixtures). */
const OUTSIDE = '(outside tests)';
/** A test runner's name filter written into a test: it can silently select nothing (G2a). */
const NAME_PATTERN =
  /--test-name-pattern|--test-skip-pattern|--test-only|--grep\b|testNamePatterns?|testSkipPatterns?/;
/** Marks a nested test's placeholder token, so its parent's own code can be compared without it. */
const NESTED = '\u0001';
type Case = {
  key: string;
  ranks: number[];
  skips: number;
  /** Skip calls and skip options with a runtime condition. */
  conditional: number;
  /** Early returns under a branch: the rest of the test may never run. */
  returns: number;
  patterns: number;
  only: boolean;
  /** Holds nested tests (a describe block): its removal shows in theirs. */
  container: boolean;
  /** Tokens of the test without comments, layout, quote style, semicolons, trailing commas or local
   * names; each nested test is its name. */
  body: string;
  /** The same without nested tests: what the test itself runs. */
  core: string;
  /** Tokens of its assertion calls alone. */
  asserts: string;
  /** File-local helper functions it calls, whose assertions count as its own. */
  calls: Set<string>;
};

/** Top-level named functions of the file (declarations and `const name = () => …`). */
function helperFunctions(source: ts.SourceFile) {
  const ts = loadTypescript();
  const helpers = new Map<ts.Node, string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) helpers.set(statement, statement.name.text);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          value &&
          (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
        )
          helpers.set(value, declaration.name.text);
      }
  }
  return helpers;
}

/** Names declared inside a test function, so a local rename is not a change. */
function localNames(fn: ts.Node) {
  const ts = loadTypescript();
  const names = new Map<string, string>();
  const bind = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      if (!names.has(name.text)) names.set(name.text, `$${names.size}`);
    } else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) bind(node.name);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) bind(node.name);
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return names;
}

/** Tokens of `node` without comments, layout, trailing commas, semicolons, quote style or the
 * parentheses of a lone arrow parameter (what a formatter changes), local names canonical and each
 * nested test replaced by a marked placeholder with its name. */
function tokens(
  node: ts.Node,
  source: ts.SourceFile,
  nested: Map<ts.Node, string>,
  names: Map<string, string>,
) {
  const ts = loadTypescript();
  const out: string[] = [];
  const emit = (current: ts.Node) => {
    const replaced = nested.get(current);
    if (replaced !== undefined) return void out.push(`${NESTED}«${replaced}»`);
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
      return void out.push(JSON.stringify(current.text));
    const children = current.getChildren(source);
    if (!children.length) {
      if (current.kind === ts.SyntaxKind.EndOfFileToken || current.kind === ts.SyntaxKind.SemicolonToken)
        return;
      const text = current.getText(source);
      out.push(ts.isIdentifier(current) ? (names.get(text) ?? text) : text);
      return;
    }
    const arrow = ts.isArrowFunction(current);
    children.forEach((child, index) => {
      const skipped =
        (child.kind === ts.SyntaxKind.CommaToken &&
          current.kind === ts.SyntaxKind.SyntaxList &&
          index === children.length - 1) ||
        (arrow &&
          (child.kind === ts.SyntaxKind.OpenParenToken || child.kind === ts.SyntaxKind.CloseParenToken));
      if (!skipped) emit(child);
    });
  };
  emit(node);
  return out;
}

function collect(path: string, text: string): Map<string, Case> | null {
  const ts = loadTypescript();
  const source = parse(path, text);
  if (!source) return null;
  const context = fileContext(source);
  const cases = new Map<string, Case>();
  const seen = new Map<string, number>();
  const blank = (key: string): Case => ({
    key,
    ranks: [],
    skips: 0,
    conditional: 0,
    returns: 0,
    patterns: 0,
    only: false,
    container: false,
    body: '',
    core: '',
    asserts: '',
    calls: new Set(),
  });
  const helperNodes = helperFunctions(source);
  const helperNames = new Set(helperNodes.values());
  const helpers = new Map<string, Case>();
  const register = (scope: ts.Node, current: Case) => {
    const nested = new Map<ts.Node, string>();
    const assertNodes: ts.Node[] = [];
    const isHelper = helperNodes.has(scope);
    // Whether a branch asserts (directly or through a helper): `if (x) { assert…; return; }` checks
    // its own case, while `if (x) return;` ends the test before the assertions that follow.
    const asserts = (branch: ts.Node): boolean =>
      (ts.isCallExpression(branch) &&
        (assertionRank(branch, context) !== null ||
          (ts.isIdentifier(branch.expression) && helperNames.has(branch.expression.text)))) ||
      !!ts.forEachChild(branch, child => asserts(child) || undefined);
    const visit = (node: ts.Node, depth: number, branch: ts.Node | null) => {
      const helper = node !== scope ? helperNodes.get(node) : undefined;
      if (helper !== undefined) {
        const item = blank(OUTSIDE);
        helpers.set(helper, item);
        register(node, item);
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        helperNames.has(node.expression.text)
      )
        current.calls.add(node.expression.text);
      else if (ts.isCallExpression(node)) {
        const found = testCall(node, source, context);
        if (found) {
          const base = current.key === OUTSIDE ? found.name : `${current.key} > ${found.name}`;
          const count = (seen.get(base) ?? 0) + 1;
          seen.set(base, count);
          const suffix = count > 1 ? ` #${count}` : '';
          const child: Case = {
            ...blank(base + suffix),
            skips: found.skips,
            conditional: found.conditional,
            only: found.only,
          };
          // The leaf name only: renaming or moving the parent changes neither body.
          nested.set(node, found.name + suffix);
          current.container = true;
          cases.set(child.key, child);
          if (found.fn) register(found.fn, child);
          else if (found.ref) {
            if (ts.isIdentifier(found.ref) && helperNames.has(found.ref.text))
              child.calls.add(found.ref.text);
            register(found.ref, child);
          }
          return;
        }
        const rank = assertionRank(node, context);
        if (rank !== null) {
          current.ranks.push(rank);
          assertNodes.push(node);
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === 'skip' || node.expression.name.text === 'todo') &&
          (ts.isIdentifier(node.expression.expression) ||
            node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) &&
          // t.skip() or t.skip('why'); never cursor.skip(5).
          (!node.arguments.length || ts.isStringLiteralLike(node.arguments[0]!))
        )
          current.conditional++;
      }
      // In a helper only a bare `return;` stops what follows; `return value` computes.
      if (
        ts.isReturnStatement(node) &&
        depth === 0 &&
        branch &&
        !(isHelper && node.expression) &&
        !asserts(branch)
      )
        current.returns++;
      if ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && NAME_PATTERN.test(node.text))
        current.patterns++;
      const inner = ts.isFunctionLike(node) && node !== scope ? depth + 1 : depth;
      // A return under a branch (not its condition) can end the test before its assertions run.
      const guarded = (child: ts.Node) =>
        ts.isIfStatement(node)
          ? child !== node.expression
          : ts.isConditionalExpression(node) || ts.isCaseClause(node) || ts.isCatchClause(node);
      ts.forEachChild(node, child => visit(child, inner, guarded(child) ? child : branch));
    };
    visit(scope, 0, null);
    // File scope and helpers are compared by their counts only: no token work.
    if (current.key === OUTSIDE) return;
    const names = localNames(scope);
    const all = tokens(scope, source, nested, names);
    current.body = all.join(' ');
    // Without nested tests and the `await` before each: adding or reordering one is not new input.
    current.core = all
      .filter(
        (token, i) => !token.startsWith(NESTED) && !(token === 'await' && all[i + 1]?.startsWith(NESTED)),
      )
      .join(' ');
    current.asserts = assertNodes.map(node => tokens(node, source, nested, names).join(' ')).join(' ; ');
  };
  const outside = blank(OUTSIDE);
  cases.set(OUTSIDE, outside);
  register(source, outside);
  // A helper's assertions and name filters count for every test that calls it (directly or through
  // another helper), so extracting a test body into a helper is not a removal. Helpers no test calls
  // stay with the file scope.
  const reached = new Set<string>();
  const credit = (item: Case) => {
    const done = new Set<string>();
    const stack = [...item.calls];
    for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
      const found = helpers.get(name);
      if (done.has(name) || !found) continue;
      done.add(name);
      reached.add(name);
      item.ranks.push(...found.ranks);
      item.patterns += found.patterns;
      item.skips += found.skips;
      item.conditional += found.conditional;
      item.returns += found.returns;
      item.only ||= found.only;
      stack.push(...found.calls);
    }
  };
  for (const item of cases.values()) if (item !== outside) credit(item);
  // A helper no test calls keeps its counts at file scope (its early returns end only itself).
  for (const [name, found] of helpers)
    if (!reached.has(name)) {
      outside.ranks.push(...found.ranks);
      outside.patterns += found.patterns;
      outside.skips += found.skips;
      outside.conditional += found.conditional;
      outside.only ||= found.only;
    }
  return cases;
}

const leaf = (key: string) => {
  const at = key.lastIndexOf(' > ');
  return at < 0 ? key : key.slice(at + 3);
};
/** One name contains the other (a test renamed by shortening or extending it). */
function similarName(a: string, b: string) {
  const [x, y] = [leaf(a), leaf(b)];
  return Math.min(x.length, y.length) >= 12 && (x.includes(y) || y.includes(x));
}

/** True when `after` pins less than `before`: fewer assertions at or above some strength. */
function loosened(before: number[], after: number[]) {
  for (const level of [4, 3, 2])
    if (after.filter(rank => rank >= level).length < before.filter(rank => rank >= level).length) return true;
  return false;
}

function compare(file: string, test: string, before: Case, after: Case): WeakenedFlag[] {
  const flags: WeakenedFlag[] = [];
  const counts = { before: before.ranks.length, after: after.ranks.length };
  if (counts.after < counts.before)
    flags.push({ file, test, kind: 'assertions-removed', assertions: counts });
  else if (loosened(before.ranks, after.ranks))
    flags.push({ file, test, kind: 'assertion-loosened', assertions: counts });
  if (after.skips > before.skips || after.conditional > before.conditional || after.returns > before.returns)
    flags.push({ file, test, kind: 'skip-added' });
  if (after.patterns > before.patterns) flags.push({ file, test, kind: 'name-pattern-narrowed' });
  if (after.only && !before.only) flags.push({ file, test, kind: 'only-added' });
  if (
    !flags.length &&
    test !== OUTSIDE &&
    before.asserts &&
    before.asserts === after.asserts &&
    before.core !== after.core
  )
    flags.push({ file, test, kind: 'input-changed', hint: true });
  return flags;
}

/** Flags for a set of changed test files (`before` null: added; `after` null: deleted). A test
 * renamed in place or moved to another changed file with the same body is not flagged. A file that
 * does not parse on either side is skipped: its own test run reports that. */
export function weakenedTestFlags(changes: readonly TestFileChange[]): WeakenedFlag[] {
  return scanWeakenedTests(changes, Infinity).flags;
}

/** The same within a time bound (a `performance.now()` deadline): files not reached by then are
 * counted in `unchecked` (changed existing files only), never flagged. */
export function scanWeakenedTests(changes: readonly TestFileChange[], deadline: number) {
  const parsed: { path: string; before: Map<string, Case> | null; after: Map<string, Case> | null }[] = [];
  let unchecked = 0;
  for (const change of changes) {
    if (performance.now() > deadline) {
      if (change.before !== null && change.after !== null) unchecked++;
      continue;
    }
    parsed.push({
      path: change.path,
      before: change.before === null ? new Map<string, Case>() : collect(change.path, change.before),
      after: change.after === null ? new Map<string, Case>() : collect(change.path, change.after),
    });
  }
  const headBodies = new Set<string>();
  for (const file of parsed)
    for (const item of file.after?.values() ?? []) if (item.key !== OUTSIDE) headBodies.add(item.body);
  const flags: WeakenedFlag[] = [];
  for (const { path, before, after } of parsed) {
    if (!before || !after) continue;
    const added = [...after.values()].filter(item => !before.has(item.key));
    const gone: Case[] = [];
    // Flags in the base file's test order, however each test was matched.
    const found = new Map<Case, WeakenedFlag[]>();
    for (const old of before.values()) {
      const current = after.get(old.key);
      if (current) found.set(old, compare(path, old.key, old, current));
      else if (old.key !== OUTSIDE) gone.push(old); // a deleted file: its tests are judged one by one
    }
    // Renamed in place, matched across all of them in turn: the same body, then the same assertions
    // over a changed body, then a name that was shortened or extended (then compared as one test).
    const tests: ((old: Case, item: Case) => boolean)[] = [
      (old, item) => item.body === old.body,
      (old, item) => !!old.asserts && item.asserts === old.asserts,
      (old, item) => similarName(item.key, old.key),
    ];
    for (const same of tests)
      for (const old of [...gone]) {
        const renamed = added.find(item => same(old, item));
        if (!renamed) continue;
        added.splice(added.indexOf(renamed), 1);
        gone.splice(gone.indexOf(old), 1);
        found.set(old, compare(path, renamed.key, old, renamed));
      }
    // A removed describe block shows in its tests; a test may have moved to a file not reached.
    for (const old of gone)
      if (!headBodies.has(old.body) && !(old.container && !old.ranks.length) && !unchecked)
        found.set(old, [{ file: path, test: old.key, kind: 'test-removed' }]);
    for (const old of before.values()) flags.push(...(found.get(old) ?? []));
  }
  return { flags, unchecked };
}
