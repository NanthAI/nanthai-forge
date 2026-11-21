// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  globSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, posix } from 'node:path';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import ts from 'typescript';

function packagedFiles(entries) {
  const files = new Set(['package.json']);
  function walk(path) {
    const info = lstatSync(path);
    // npm never includes symbolic links, including dangling links and directory aliases.
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
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

function readPackagedImports(files) {
  const imports = new Map();
  for (const path of files) {
    if (
      !(
        (path.startsWith('scripts/') && path.endsWith('.mjs')) ||
        (path.startsWith('dist/') && path.endsWith('.js'))
      )
    )
      continue;
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false);
    assert.equal(ast.parseDiagnostics.length, 0, `Cannot parse ${path}`);
    const specifiers = [];
    function visit(node) {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
            ? node.arguments[0]
            : undefined;
      if (specifier && ts.isStringLiteralLike(specifier)) specifiers.push(specifier.text);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    if (specifiers.length) imports.set(path, specifiers);
  }
  return imports;
}

function missingImports(imports, files, unbuilt = unbuiltEntries(manifest.files)) {
  const missing = [];
  for (const [path, specifiers] of imports) {
    if (!files.has(path)) continue;
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        if (!path.startsWith('scripts/')) continue;
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!files.has(target) && !unbuilt.some(entry => target.startsWith(`${entry}/`)))
          missing.push(`${path} imports unpackaged ${target}`);
      } else if (!isBuiltin(specifier)) {
        const dependency = specifier
          .split('/')
          .slice(0, specifier.startsWith('@') ? 2 : 1)
          .join('/');
        if (!Object.hasOwn(manifest.dependencies, dependency))
          missing.push(`${path} imports non-runtime dependency ${dependency}`);
      }
    }
  }
  return missing;
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// The controls vary package membership, so all of them can use the same parsed source.
const packaged = packagedFiles(manifest.files);
const imports = readPackagedImports(packaged);

test('packaged file enumeration excludes dangling, external and cyclic symlinks as npm does', () => {
  const root = mkdtempSync(join(tmpdir(), 'packaged-links-'));
  try {
    const dir = join(root, 'dist'),
      outside = join(root, 'outside');
    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(join(dir, 'main.js'), 'export {};');
    writeFileSync(join(outside, 'escape.js'), 'synthetic outside content');
    symlinkSync(join(root, 'missing.js'), join(dir, 'dangling'), 'file');
    symlinkSync(outside, join(dir, 'external'), 'dir');
    symlinkSync(dir, join(dir, 'cycle'), 'dir');
    const files = packagedFiles([dir]);
    assert.deepEqual(
      [...files].filter(path => path !== 'package.json').map(path => path.split(/[\\/]/).at(-1)),
      ['main.js'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packaged scripts retain relative helpers and every emitted runtime import belongs to production dependencies', () => {
  assert.ok(packaged.has('scripts/script-impact.mjs'));
  assert.deepEqual(missingImports(imports, packaged), []);
});

test('packaged import guard detects the missing transitive impact helper', () => {
  const files = new Set(packaged);
  files.delete('scripts/script-impact.mjs');
  assert.ok(
    missingImports(imports, files).includes(
      'scripts/test-impact.mjs imports unpackaged scripts/script-impact.mjs',
    ),
  );
});

test('an unbuilt checkout (no dist/) packages dist imports by entry, a built one is still exact', () => {
  const unbuiltFiles = new Set([...packaged].filter(path => !path.startsWith('dist/')));
  assert.deepEqual(
    unbuiltEntries(['dist', 'docs', 'scripts/*.mjs', 'LICENSE.md']),
    existsSync('dist') ? [] : ['dist'],
  );
  assert.deepEqual(missingImports(imports, unbuiltFiles, ['dist']), []);
  const importsDist = missingImports(imports, unbuiltFiles, []);
  assert.ok(
    importsDist.some(line => line.includes('imports unpackaged dist/')),
    'without the unbuilt exemption the same inputs fail on dist/*',
  );
  // An import outside every packaged entry still fails when dist is exempt.
  assert.ok(
    missingImports(imports, new Set([...unbuiltFiles].filter(path => path !== 'scripts/script-impact.mjs')), [
      'dist',
    ]).length > 0,
  );
});
