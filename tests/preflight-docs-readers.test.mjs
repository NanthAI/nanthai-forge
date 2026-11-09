// SPDX-License-Identifier: Apache-2.0
// Docs-only preflight (Issue c14f4065, receipt 0f3d44e1): a Markdown change runs only the tests that
// read it; a file the save ignores never widens the plan; the plan is printed before anything runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docsReaders } from '../scripts/docs-readers.mjs';
import { selectPreflightTests, selectTests } from '../scripts/test-impact.mjs';
import { planLine, preflightPlan, preflightRuntime, runPreflight } from '../dist/agent-preflight.js';
import { digest } from '../dist/portable-hash.js';

test.beforeEach(t =>
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({
    ok: true,
    latencyMs: 1,
    fseventsdRssMb: null,
    fseventsdCpuPercent: null,
    reason: null,
    attempts: [],
  })),
);

// Synthetic documents only: no file here names a real repository document.
const fixture = () =>
  new Map(
    Object.entries({
      'package.json': '{"type":"module","scripts":{}}',
      'scripts/forge-check.mjs': '',
      'src/a.ts': 'export const n = 1;',
      'tests/a.test.mjs': "import '../dist/a.js';",
      'tests/reads-guide.test.mjs': "readFileSync(new URL('../docs/x/guide.md', import.meta.url));",
      'tests/other-guide.test.mjs':
        "readFileSync('vendor/docs/x/guide.md'); readFileSync('docs/x/guide.mdx');",
      'tests/root.test.mjs': "readFileSync(new URL('../GUIDE.md', import.meta.url));",
      'tests/listed.test.mjs':
        "for (const p of ['GUIDE.md']) readFileSync(new URL(`../${p}`, import.meta.url));",
      'tests/fixture-guide.test.mjs': "writeFileSync(join(dir, 'GUIDE.md'), 'own');",
      'tests/segments.test.mjs': "readFileSync(join(root, 'docs', 'x', 'guide.md'));",
      'tests/helper.mjs': "export const text = () => readFileSync('docs/x/guide.md');",
      'tests/via-helper.test.mjs': "import { text } from './helper.mjs';",
      'scripts/lister.mjs': "export const docs = ['docs/x/guide.md'];",
      'tests/via-script.test.mjs': "import { docs } from '../scripts/lister.mjs';",
      'src/links.ts': "export const help = 'See docs/x/guide.md';",
      'tests/links.test.mjs': "import '../dist/links.js';",
      'scripts/package-documents.mjs': "export const all = ['docs/x/guide.md'];",
      'tests/packager.test.mjs': "import '../scripts/package-documents.mjs';",
      'tests/unrelated.test.mjs': '',
    }),
  );

test('a document is read where its path is named, directly or through a test helper or script', () => {
  const files = fixture();
  assert.deepEqual([...docsReaders(files, ['docs/x/guide.md'])].sort(), [
    ['tests/reads-guide.test.mjs', { doc: 'docs/x/guide.md', via: 'tests/reads-guide.test.mjs' }],
    ['tests/via-helper.test.mjs', { doc: 'docs/x/guide.md', via: 'tests/helper.mjs' }],
    ['tests/via-script.test.mjs', { doc: 'docs/x/guide.md', via: 'scripts/lister.mjs' }],
  ]);
  // A root document: a relative path, or a quoted name resolved against the root; never a fixture's own.
  assert.deepEqual([...docsReaders(files, ['GUIDE.md']).keys()].sort(), [
    'tests/listed.test.mjs',
    'tests/root.test.mjs',
  ]);
  assert.equal(docsReaders(files, []).size, 0);
});

test('a docs-only change plans only its readers; beside code they are mandatory', () => {
  const files = fixture();
  const cache = {};
  const plan = selectPreflightTests({ files, paths: ['docs/x/guide.md'] }, cache);
  assert.equal(plan.scope, 'docs');
  assert.equal(cache.graph, undefined);
  assert.deepEqual(plan.tests, [
    'tests/reads-guide.test.mjs',
    'tests/via-helper.test.mjs',
    'tests/via-script.test.mjs',
  ]);
  assert.deepEqual(plan.deferredTests, []);
  assert.match(plan.reason, /the 3 test file\(s\) that read a changed document/);
  assert.deepEqual(selectPreflightTests({ files, paths: ['docs/y.md'] }).tests, []);
  // Beside a code path the readers join landing coverage and the mandatory tier.
  const paths = ['src/a.ts', 'docs/x/guide.md'];
  const mixed = selectPreflightTests({ files, paths }, {});
  const mandatory = mixed.tiers.find(item => item.tier === 'mandatory').tests;
  for (const test of plan.tests) assert.ok(mandatory.includes(test), test);
  assert.ok(mixed.tests.includes('tests/a.test.mjs'));
  assert.deepEqual([...mixed.tests, ...mixed.deferredTests].sort(), selectTests({ files, paths }).tests);
});

test('a file the save ignores never makes the inventory incomplete; the plan prints before the run', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-preflight-docs-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = fixture();
  for (const [path, body] of bytes) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  // A typecheck's generated declarations: present in the checkout, ignored by save.
  mkdirSync(join(root, 'convex', '_generated'), { recursive: true });
  writeFileSync(join(root, 'convex', '_generated', 'api.d.ts'), 'export declare const api: unknown;\n');
  const head = [...bytes].map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  const laneId = '22222222-2222-4222-8222-222222222222';
  const plan = preflightPlan(root, { paths: ['docs/x/guide.md'], complete: true }, { laneId, files: head });
  assert.equal(plan.scope, 'docs', plan.reason);
  assert.doesNotMatch(plan.reason, /Incomplete local source inventory/);
  assert.deepEqual(plan.deferredTests, []);
  assert.equal(plan.tests.length, 3);
  // A saved file that really differs here still widens to full coverage, and says so first.
  writeFileSync(join(root, 'src', 'a.ts'), 'export const n = 2;');
  const stale = preflightPlan(root, { paths: ['src/a.ts'], complete: true }, { laneId, files: head });
  assert.equal(stale.scope, 'full');
  assert.match(stale.reason, /^Incomplete local source inventory/);
  assert.match(planLine(stale), /^preflight plan: scope full, .* Why: Incomplete local source inventory/);
  // The plan line is the first thing a run prints, before static checks, build or tests.
  const lines = [];
  t.mock.method(process.stderr, 'write', chunk => (lines.push(String(chunk)), true));
  runPreflight(root, laneId, 'a'.repeat(64), { ...plan, tests: [], static: undefined });
  t.mock.restoreAll();
  assert.match(
    lines[0],
    /^preflight plan: scope docs, 0 test file\(s\) here, 0 deferred to the pre-queue check; 180 s budget, about \d+ min\. Why: Only Markdown/,
  );
});
