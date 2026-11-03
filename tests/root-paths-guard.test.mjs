// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function rawSuffixes(text) {
  const file = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const found = [];
  const unwrap = node => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);
  const root = node => {
    node = unwrap(node);
    if (ts.isIdentifier(node)) return /(?:root|copy)$/i.test(node.text);
    if (ts.isPropertyAccessExpression(node)) return /(?:root|copy)$/i.test(node.name.text);
    if (
      ts.isCallExpression(node) &&
      /^(resolve|realpathSync|canonicalRoot|hostedAgentRoot|basename)$/.test(node.expression.getText(file))
    )
      return node.arguments.some(root);
    return false;
  };
  const literal = node => {
    node = unwrap(node);
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : ts.isTemplateExpression(node)
        ? node.head.text
        : null;
  };
  const suffix = (left, right) =>
    /^\.forge-(?:client|metrics)/.test(literal(right) ?? '') ||
    (root(left) && (literal(right)?.startsWith('.') || /suffix/i.test(right.getText(file))));
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
      suffix(node.left, node.right)
    )
      found.push(node.getText(file));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(unwrap(node.expression))) {
      const method = unwrap(node.expression);
      if (method.name.text === 'concat' && node.arguments.some(arg => suffix(method.expression, arg)))
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
  ])
    assert(rawSuffixes(text).length, text);
  assert.deepEqual(rawSuffixes('join(clientCacheRoot(root), "objects")'), []);
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
