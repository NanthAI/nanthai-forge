// SPDX-License-Identifier: Apache-2.0
// Guard (Issue 63d241db, audits 1bb0d8e6 and 875a57cc): no new Forge-only or JS-only fast path in product code. Every hit of a
// literal that hid one before must be listed in docs/forge-only-rules.md with why and what other
// repositories get; a new hit, a changed count or a stale row fails the build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const folder = String.raw`(?:src|web|web\\\/src|convex|netlify|scripts|tests|dist)`;
const listed = String.raw`'(?:src|web|web\/src|convex|netlify|scripts|tests|dist)\/?'`;
const RULES = {
  'check-entry': /scripts\/forge-check\.mjs/,
  'standard-from-args': /\.args\[0\]\s*===|\.args\.length\s*===\s*1\b|executable\s*===\s*['"]node['"]/,
  // A regular expression anchored on `^tests/`, a `startsWith('tests/')` prefix test, or a `.test.mjs` string.
  'tests-folder': /\/\^tests\\\/|startsWith\(['"`]tests\/|\.test\\?\.mjs['"$\/]/,
  // A `docs/` prefix test: Forge's own documentation folder, not every repository's.
  'docs-folder': /\/\^docs\\\/|startsWith\(['"`]docs\//,
  'forge-folders': new RegExp(
    String.raw`\((?:\?:)?${folder}(?:\|[^)]*)?\|${folder}\b|\[\s*${listed},\s*${listed}`,
  ),
  'npm-lockfile': /package-lock\.json/,
  'node-test': /['"`]--test['"`]/,
};
// JS/npm-only assumptions (audit 875a57cc), scanned in src/, convex/ and the shipped scripts.
const buildFolder = String.raw`['"](?:dist|build|coverage)\/?['"]`;
const PRODUCT_RULES = {
  // A folder list or alternation with `dist`, `build` or `coverage`, as used to skip or drop paths.
  'build-folders': new RegExp(
    String.raw`\[[^\]]*(?:,\s*${buildFolder}|${buildFolder}\s*,)|^\s*${buildFolder},?\s*$|\(\?:(?:[\w.\\\/-]+\|)*(?:dist|build|coverage)(?:\|[\w.\\\/-]+)*\)`,
  ),
  // A JavaScript/TypeScript extension pattern such as /\.[cm]?[jt]sx?$/, as used to gate a feature.
  'js-extension': /\[cm\]\?\[jt\]s|\[jt\]sx/,
  // package.json read as a config source.
  'package-json-config': /['"`]package\.json['"`]/,
};

/** Product code: src/, convex/ (not generated) and the scripts the package ships. */
function productFiles() {
  const files = [];
  for (const directory of ['src', 'convex'])
    for (const entry of readdirSync(join(repo, directory), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const path = relative(repo, join(entry.parentPath ?? entry.path, entry.name))
        .split('\\')
        .join('/');
      if (!path.includes('/_generated/')) files.push(path);
    }
  const shipped = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).files;
  for (const path of shipped) if (/^scripts\/[^*]+\.mjs$/.test(path)) files.push(path);
  return files.sort();
}

/** `file rule` → lines that match, one per line. */
function scanHits(files, read) {
  const hits = new Map();
  for (const file of files) {
    const lines = read(file).split('\n');
    const rules = { ...RULES, ...PRODUCT_RULES };
    for (const [rule, pattern] of Object.entries(rules)) {
      const count = lines.filter(line => pattern.test(line)).length;
      if (count) hits.set(`${file} ${rule}`, count);
    }
  }
  return hits;
}

function allowlist() {
  const text = readFileSync(join(repo, 'docs/forge-only-rules.md'), 'utf8');
  const section = text.split('\n## Allowlist\n')[1]?.split('\n## ')[0] ?? '';
  const rows = new Map();
  for (const line of section.split('\n')) {
    const row = /^\| `([^`]+)` \| `([^`]+)` \| (\d+) \| ([^|]+) \| ([^|]+) \|$/.exec(line);
    if (!row) continue;
    const [, file, rule, hits, why, others] = row;
    assert(!rows.has(`${file} ${rule}`), `duplicate allowlist row: ${file} ${rule}`);
    assert(rule in RULES || rule in PRODUCT_RULES, `unknown rule in docs/forge-only-rules.md: ${rule}`);
    assert(why.trim().length >= 10 && others.trim().length >= 1, `explain ${file} ${rule}`);
    rows.set(`${file} ${rule}`, Number(hits));
  }
  return rows;
}

test('each rule finds the literal it names and nothing else', () => {
  const samples = {
    'check-entry': "const entry = 'scripts/forge-check.mjs';",
    'standard-from-args': "const standard = check.args[0] === 'x';",
    'tests-folder': String.raw`const test = path => /^tests\/[^/]+\.test\.mjs$/.test(path);`,
    'docs-folder': "const docs = path.startsWith('docs/');",
    'forge-folders': String.raw`const product = /^(?:src|web\/src|convex|netlify)\//;`,
    'npm-lockfile': "readFileSync('package-lock.json');",
    'node-test': "spawn(node, ['--test', file]);",
    'build-folders': "const skip = new Set(['node_modules', 'dist']);",
    'js-extension': String.raw`if (!/\.[cm]?[jt]sx?$/.test(path)) return;`,
    'package-json-config': "const manifest = files.get('package.json');",
  };
  for (const [rule, line] of Object.entries(samples))
    assert.deepEqual(
      [...scanHits(['src/x.ts'], () => line).keys()],
      [`src/x.ts ${rule}`],
      `${rule}: ${line}`,
    );
  // The other forms of a tests-folder gate: a prefix test and a `.test.mjs` string literal.
  for (const line of [
    "const test = path => path.startsWith('tests/');",
    'const test = path => path.startsWith("tests/");',
    "const test = path => path.endsWith('.test.mjs');",
    "const glob = 'tests/*.test.mjs';",
  ])
    assert.deepEqual([...scanHits(['src/x.ts'], () => line).keys()], ['src/x.ts tests-folder'], line);
  // The list form and a plain folder name in prose are distinct.
  assert.equal(scanHits(['src/x.ts'], () => "const dirs = ['src', 'web', 'convex'];").size, 1);
  // Shipped scripts are product code: every rule applies to them too.
  assert.deepEqual(
    [...scanHits(['scripts/x.mjs'], () => "files.get('package.json');").keys()],
    ['scripts/x.mjs package-json-config'],
  );
  // Other string shapes that name Forge's test layout (M2-08, M2-16).
  for (const line of [
    "if (path.startsWith('tests/')) return;",
    "const spec = 'run.test.mjs';",
    String.raw`const spec = /\.test\.mjs$/;`,
  ])
    assert.deepEqual([...scanHits(['src/x.ts'], () => line).keys()], ['src/x.ts tests-folder'], line);
  for (const line of [
    "if (path.startsWith('src/')) return;",
    "const glob = 'tests/**/*.test.ts';",
    "if (name.endsWith('.test.ts')) return;",
    'const glob = `packages/*/src/**/*.test.ts`;',
    '/^(?:packages|apps)\\//.test(path);',
    "const lock = 'pnpm-lock.yaml';",
    "const entry = join(root, 'dist', 'cli-entry.js');",
    "type Coverage = Records['coverage'];",
    'const ok = /\\.(?:py|go|rs)$/.test(path);',
  ])
    assert.equal(scanHits(['src/x.ts'], () => line).size, 0, line);
});

test('product code has no Forge-only literal that docs/forge-only-rules.md does not list', () => {
  const hits = scanHits(productFiles(), file => readFileSync(join(repo, file), 'utf8'));
  const rows = allowlist();
  const unlisted = [...hits].filter(([key]) => !rows.has(key)).map(([key, n]) => `${key} (${n})`);
  const changed = [...hits]
    .filter(([key, n]) => rows.has(key) && rows.get(key) !== n)
    .map(([key, n]) => `${key}: ${n} hits, listed ${rows.get(key)}`);
  const stale = [...rows.keys()].filter(key => !hits.has(key));
  assert.deepEqual(
    { unlisted, changed, stale },
    { unlisted: [], changed: [], stale: [] },
    'Route a Forge-only branch through isStandardForgeCheck (src/standard-check.ts) or the project ' +
      'test runner (src/project-test-runner.ts). Only Forge’s own recipe is listed in ' +
      'docs/forge-only-rules.md, with why and what other repositories get; update its count or ' +
      'remove a stale row.',
  );
});
