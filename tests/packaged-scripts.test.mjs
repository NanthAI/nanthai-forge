// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';

function packagedFiles(entries) {
  const files = new Set(['package.json']);
  function walk(path) {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) walk(posix.join(path, name));
    } else files.add(path);
  }
  for (const entry of entries) for (const path of globSync(entry)) walk(path);
  return files;
}

function missingImports(files) {
  const missing = [];
  for (const path of files) {
    if (!path.startsWith('scripts/') || !path.endsWith('.mjs')) continue;
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    assert.equal(ast.parseDiagnostics.length, 0, `Cannot parse ${path}`);
    function visit(node) {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
            ? node.arguments[0]
            : undefined;
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier.text));
        if (!files.has(target)) missing.push(`${path} imports unpackaged ${target}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return missing;
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
test('every relative import of every packaged script is packaged, including Actions helpers', () => {
  const files = packagedFiles(manifest.files);
  assert.ok(files.has('scripts/script-impact.mjs'));
  assert.deepEqual(missingImports(files), []);
});

test('packaged import guard detects the missing transitive impact helper', () => {
  const files = packagedFiles(manifest.files);
  files.delete('scripts/script-impact.mjs');
  assert.ok(
    missingImports(files).includes('scripts/test-impact.mjs imports unpackaged scripts/script-impact.mjs'),
  );
});
