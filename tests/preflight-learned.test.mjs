// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/portable-hash.js';
import {
  learnFailures,
  learnFromLanding,
  learnedTests,
  recentFailedTests,
  rememberLandingPaths,
} from '../dist/preflight-learned.js';
import { preflightPlan } from '../dist/agent-preflight.js';

const laneId = '22222222-2222-4222-8222-222222222222';
function lane(t, bytes = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-preflight-learned-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const all = {
    'package.json': '{"type":"module","scripts":{}}',
    'src/a.ts': 'export const n = 1;',
    'tests/a.test.mjs': "import '../src/a.ts';",
    'tests/barriers.test.mjs': "import test from 'node:test'; test('watches checkout-* names', () => {});",
    ...bytes,
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = Object.entries(all).map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  return { root, files };
}
const failed = (...files) => ({
  submission: {
    phase: 'terminal-failed',
    error: { code: 'CHECK_FAILED', message: 'The admission check of this change alone failed.' },
    testFiles: { counts: { failed: files.length }, failed: files.map(file => ({ file })) },
  },
});

test('a landing check failure teaches the next preflight for the same paths, even past the import graph', t => {
  const { root, files } = lane(t);
  const plan = () =>
    preflightPlan(root, { paths: ['src/a.ts'], complete: true }, { laneId, files }, { budgetSeconds: 1 });
  const before = plan();
  assert.deepEqual(before.tests, ['tests/a.test.mjs']);
  // The finish gate remembered the landing's paths; the CHECK_FAILED response names the failing file.
  rememberLandingPaths(root, laneId, ['src/a.ts', 'docs/notes.md']);
  learnFromLanding(root, failed('tests/barriers.test.mjs'), laneId.slice(0, 8));
  const after = plan();
  assert.deepEqual(
    after.local.tiers.find(item => item.tier === 'learned'),
    {
      tier: 'learned',
      total: 1,
      local: 1,
    },
  );
  // Protected: a 1 s budget still runs it.
  assert.deepEqual(after.tests, ['tests/barriers.test.mjs', 'tests/a.test.mjs']);
  assert.deepEqual(learnedTests(root, ['docs/notes.md']), [], 'Markdown never carries an association');
  // The record is clone-local: another clone keeps its own.
  assert.deepEqual(learnedTests(`${root}-other`, ['src/a.ts']), []);
  assert.ok(readFileSync(join(`${root}.forge-client`, 'agent', 'preflight-learned.json'), 'utf8'));
});

test('only a CHECK_FAILED with failing test files for a known Lane is learned', t => {
  const { root } = lane(t);
  rememberLandingPaths(root, laneId, ['src/a.ts']);
  learnFromLanding(root, { submission: { error: { code: 'COMPOSITION_CONFLICT' } } }, laneId);
  learnFromLanding(root, failed(), laneId);
  learnFromLanding(root, failed('tests/x.test.mjs'), '33333333-3333-4333-8333-333333333333');
  learnFromLanding(root, failed('tests/x.test.mjs'), undefined);
  learnFromLanding(root, null, laneId);
  assert.deepEqual(learnedTests(root, ['src/a.ts']), []);
  learnFromLanding(root, failed('tests/x.test.mjs', 'not-a-test.txt'), laneId);
  assert.deepEqual(learnedTests(root, ['src/a.ts']), ['tests/x.test.mjs']);
});

test('learned entries expire after 30 days and the record stays bounded', t => {
  const { root } = lane(t);
  const day = 24 * 60 * 60 * 1000,
    now = Date.parse('2026-11-06T00:00:00.000Z');
  learnFailures(root, ['src/a.ts'], ['tests/old.test.mjs'], now - 31 * day);
  learnFailures(root, ['src/a.ts'], ['tests/new.test.mjs'], now - day);
  assert.deepEqual(learnedTests(root, ['src/a.ts'], now), ['tests/new.test.mjs']);
  const many = Array.from({ length: 6000 }, (_, i) => `src/m${i}.ts`);
  learnFailures(root, many, ['tests/a.test.mjs'], now);
  learnFailures(root, ['src/latest.ts'], ['tests/a.test.mjs'], now + 1);
  const store = JSON.parse(
    readFileSync(join(`${root}.forge-client`, 'agent', 'preflight-learned.json'), 'utf8'),
  );
  const pairs = Object.values(store.learned).reduce((sum, tests) => sum + Object.keys(tests).length, 0);
  assert.equal(pairs, 5000);
  assert.deepEqual(learnedTests(root, ['src/latest.ts'], now + 1), ['tests/a.test.mjs'], 'newest kept');
});

test('a corrupt record is ignored, never fatal', t => {
  const { root } = lane(t);
  mkdirSync(join(`${root}.forge-client`, 'agent'), { recursive: true });
  writeFileSync(join(`${root}.forge-client`, 'agent', 'preflight-learned.json'), 'not json');
  assert.deepEqual(learnedTests(root, ['src/a.ts']), []);
  learnFailures(root, ['src/a.ts'], ['tests/a.test.mjs']);
  assert.deepEqual(learnedTests(root, ['src/a.ts']), ['tests/a.test.mjs']);
});

test('a failure under one path is recent for every other path, for 14 days; the plan names each tier', t => {
  const { root, files } = lane(t, {
    'src/b.ts': 'export const m = 1;',
    'tests/b.test.mjs': "import '../src/b.ts';",
    // Two modules between: not a direct consumer of b.ts, but near enough for a recent failure.
    'src/mid.ts': "import './b.ts'; export const k = 1;",
    'src/a.ts': "import './mid.ts'; export const n = 1;",
    'tests/barriers.test.mjs': "import '../src/a.ts';",
  });
  const day = 24 * 60 * 60 * 1000,
    now = Date.now();
  learnFailures(root, ['src/a.ts'], ['tests/barriers.test.mjs'], now - 20 * day);
  assert.deepEqual(recentFailedTests(root, now), [], '20 days is outside the 14-day window');
  learnFailures(root, ['src/a.ts'], ['tests/barriers.test.mjs'], now - 2 * day);
  assert.deepEqual(learnedTests(root, ['src/b.ts']), [], 'not learned for the other path');
  assert.deepEqual(recentFailedTests(root, now), ['tests/barriers.test.mjs']);
  const plan = preflightPlan(root, { paths: ['src/b.ts'], complete: true }, { laneId, files });
  assert.equal(plan.status, 'planned');
  assert.deepEqual(
    plan.local.tiers.find(item => item.tier === 'recent'),
    { tier: 'recent', total: 1, local: 1 },
  );
  assert.deepEqual(plan.local.tierTests.recent, ['tests/barriers.test.mjs']);
  assert.ok(plan.local.tierTests.direct.includes('tests/b.test.mjs'));
  assert.ok(plan.tests.includes('tests/barriers.test.mjs'));
});
