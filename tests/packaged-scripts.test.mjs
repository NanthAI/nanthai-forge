// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

// Build output (dist) is generated, not authored: in a Lane that has not run build:core its files are
// absent although the package.json entry packages them. An entry that names a missing directory still
// packages everything beneath it, so an unbuilt checkout checks the same import rule. A built checkout
// keeps the exact per-file check, and the landing check (npm run build, then the full run) covers it.
function unbuiltEntries(entries) {
  return entries.filter(entry => !/[*?[{]/.test(entry) && !existsSync(entry) && !entry.includes('.'));
}

function missingImports(files, unbuilt = unbuiltEntries(manifest.files)) {
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
        if (!files.has(target) && !unbuilt.some(entry => target.startsWith(`${entry}/`)))
          missing.push(`${path} imports unpackaged ${target}`);
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

test('an unbuilt checkout (no dist/) packages dist imports by entry, a built one is still exact', () => {
  const built = packagedFiles(manifest.files);
  const unbuiltFiles = new Set([...built].filter(path => !path.startsWith('dist/')));
  assert.deepEqual(
    unbuiltEntries(['dist', 'docs', 'scripts/*.mjs', 'LICENSE.md']),
    existsSync('dist') ? [] : ['dist'],
  );
  assert.deepEqual(missingImports(unbuiltFiles, ['dist']), []);
  const importsDist = missingImports(unbuiltFiles, []);
  assert.ok(
    importsDist.some(line => line.includes('imports unpackaged dist/')),
    'without the unbuilt exemption the same inputs fail on dist/*',
  );
  // An import outside every packaged entry still fails when dist is exempt.
  assert.ok(
    missingImports(new Set([...unbuiltFiles].filter(path => path !== 'scripts/script-impact.mjs')), ['dist'])
      .length > 0,
  );
});
