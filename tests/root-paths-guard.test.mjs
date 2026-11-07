// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function rawSuffixes(text) {
  const file = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const found = [];
  // Parentheses, casts and non-null assertions never change the string a path is built from.
  const unwrap = node =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))
      ? unwrap(node.expression)
      : node;
  const root = node => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return /(?:root|copy)$/i.test(node.text);
    if (ts.isPropertyAccessExpression(node)) return /(?:root|copy)$/i.test(node.name.text);
    if (ts.isElementAccessExpression(node))
      return /(?:root|copy)$/i.test(constant(node.argumentExpression) ?? '');
    if (
      ts.isCallExpression(node) &&
      /^(resolve|realpathSync|canonicalRoot|hostedAgentRoot|basename)$/.test(node.expression.getText(file))
    )
      return node.arguments.some(root);
    return false;
  };
  /** The whole value of a constant string expression (literals joined by +), else null. */
  function constant(node) {
    node = unwrap(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constant(node.left),
        right = left === null ? null : constant(node.right);
      return right === null ? null : left + right;
    }
    return null;
  }
  /** The constant start of a string expression: what any suffix would begin with. */
  function literal(node) {
    node = unwrap(node);
    const whole = constant(node);
    if (whole !== null) return whole;
    if (ts.isTemplateExpression(node)) return node.head.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constant(node.left);
      return left === null ? literal(node.left) : left + (literal(node.right) ?? '');
    }
    return null;
  }
  /** Concatenated arguments read as one suffix: concat(".forge", "-client"). */
  const joined = args => {
    let text = '';
    for (const arg of args) {
      const whole = constant(arg);
      if (whole === null) return text + (literal(arg) ?? '');
      text += whole;
    }
    return text;
  };
  const suffix = (left, text, right) =>
    /^\.forge-(?:client|metrics)/.test(text ?? '') ||
    (root(left) && (text?.startsWith('.') || /suffix/i.test(right)));
  const method = node => {
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee)) return { name: callee.name.text, target: callee.expression };
    if (ts.isElementAccessExpression(callee))
      return { name: constant(callee.argumentExpression), target: callee.expression };
    return null;
  };
  function visit(node) {
    if (ts.isTemplateExpression(node))
      for (const span of node.templateSpans)
        if (
          (root(span.expression) && span.literal.text.startsWith('.')) ||
          /^\.forge-(?:client|metrics)/.test(span.literal.text)
        )
          found.push(node.getText(file));
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      suffix(node.left, literal(node.right), node.right.getText(file))
    )
      found.push(node.getText(file));
    if (ts.isCallExpression(node)) {
      const call = method(node);
      if (
        call?.name === 'concat' &&
        (suffix(call.target, joined(node.arguments), node.arguments.map(arg => arg.getText(file)).join()) ||
          node.arguments.some(arg => suffix(call.target, literal(arg), arg.getText(file))))
      )
        found.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

test('root-derived sibling paths go through normalization before suffixing (including MCP)', () => {
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(path) && path !== 'src/root-paths.ts')
        assert.deepEqual(rawSuffixes(readFileSync(path, 'utf8')), [], path);
    }
  }
  walk('src');
});

test('root suffix guard rejects raw templates and additions, including member roots and other suffixes', () => {
  for (const text of [
    '`${root}.forge-client`',
    '`${transport.root}.cache`',
    'root + ".forge-client"',
    '`${session.root}.preparing`',
    '`${copy}.forge-client`',
    '`${directory}.forge-client`',
    'directory + ".forge-client"',
    '(root) + ".forge-client"',
    '((session.root)) + (".forge-metrics.jsonl")',
    'root.concat(".forge-client")',
    '(directory).concat(".forge-client")',
    'directory.concat(`.forge-metrics.jsonl`)',
    'root.concat(".preparing")',
    'directory + `.forge-client`',
    // Round-2 review repros (118a5539 S1) and straightforward equivalents.
    'root["concat"](".forge-client")',
    'directory["concat"](".forge-client")',
    'directory + (".forge-" + "client")',
    'directory.concat(".forge", "-client")',
    "root['concat']('.forge' + '-client')",
    '(root as string).concat(".forge-client")',
    'root!.concat(".forge-client")',
    'root?.concat(".forge-", "client")',
    'directory + (".forge" + `-client`)',
    'session["root"] + ".preparing"',
    '(directory satisfies string) + ".forge-metrics.jsonl"',
    'directory.concat(".forge-" + "client", suffix)',
  ])
    assert(rawSuffixes(text).length, text);
  assert.deepEqual(rawSuffixes('join(clientCacheRoot(root), "objects")'), []);
  assert.deepEqual(rawSuffixes('"prefix" + ("-" + "name")'), []);
  assert.deepEqual(rawSuffixes('directory.concat("/objects")'), []);
});

test('canonical root resolves missing prefixes and dangling checkout aliases without creating paths', async t => {
  const { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { canonicalRoot, clientCacheRoot, rootSibling } = await import('../dist/root-paths.js');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-root-paths-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'missing checkout'),
    alias = join(directory, 'alias');
  symlinkSync(target, alias);
  assert.equal(canonicalRoot(alias), target);
  assert.equal(clientCacheRoot(alias + '/'), target + '.forge-client');
  assert.equal(rootSibling(join(alias, 'nested'), '.preparing'), join(target, 'nested') + '.preparing');
  assert(!existsSync(target));
  mkdirSync(target);
  assert.equal(canonicalRoot(alias + '/'), target);
});
