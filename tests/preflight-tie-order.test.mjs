// SPDX-License-Identifier: Apache-2.0
// Issue 964e2d2b: tests that rank equally close to a change order by relevance and a stable hash,
// never by file name, so adding a test file cannot move a relevant test out of the time budget.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fitPreflightBudget, selectPreflightTests } from '../scripts/test-impact.mjs';
import { changeSalt, compareRelevance, relevanceFor, stableKey } from '../scripts/test-tiebreak.mjs';
import { orderRunnerTests } from '../dist/project-test-runner.js';
import { orderByHistory } from '../dist/agent-preflight.js';

const budget = { seconds: 180, secondsFor: () => 4 };
const tier = (plan, name) => plan.tiers.find(item => item.tier === name).tests;
const importer = "import '../dist/job-queue.js';";
/** A hub every test loads, and three tests that are about it by name and by use. */
const inventory = (extra = []) => {
  const files = new Map([
    ['package.json', '{"scripts":{}}'],
    ['src/job-queue.ts', 'export const queue = [];'],
    ['tests/job-queue.test.mjs', `${importer} // queue`],
    ['tests/job-queue-retry.test.mjs', `${importer} // job-queue`],
    ['tests/queue.test.mjs', importer],
  ]);
  for (let i = 0; i < 120; i++) files.set(`tests/consumer-${i}.test.mjs`, importer);
  for (const name of extra) files.set(name, importer);
  return files;
};
const plan = files => selectPreflightTests({ files, paths: ['src/job-queue.ts'], hubBudget: budget });
const fit = p => fitPreflightBudget({ tiers: p.tiers, budgetSeconds: 180, secondsPerFile: 4 }).tests;
const relevant = ['tests/job-queue.test.mjs', 'tests/job-queue-retry.test.mjs', 'tests/queue.test.mjs'];

test('relevant tests fit the budget whatever the file names sort like; an extra test never moves them', () => {
  const base = plan(inventory());
  assert.ok(tier(base, 'wide').length >= 100, 'the hub is ranked, not protected');
  const kept = new Set(fit(base));
  for (const name of relevant) assert.ok(kept.has(name), `${name} fits`);
  // New tests that sort before and after every existing name, equally close, and one nothing loads.
  const grown = plan(inventory(['tests/aaa.test.mjs', 'tests/zzz.test.mjs', 'tests/!-first.test.mjs']));
  const unrelated = plan(new Map([...inventory(), ['tests/unrelated.test.mjs', "import 'node:test';"]]));
  for (const next of [grown, unrelated]) {
    const after = new Set(fit(next));
    for (const name of relevant) assert.ok(after.has(name), `${name} still fits`);
  }
  // A test nothing in the change reaches does not change the plan at all.
  assert.deepEqual(unrelated.tests, base.tests);
  assert.deepEqual(fit(unrelated), fit(base));
});

test('order is deterministic, independent of inventory insertion order and of name order', () => {
  const files = inventory();
  const reversed = new Map([...files].reverse());
  assert.deepEqual(plan(reversed).tests, plan(files).tests);
  const wide = tier(plan(files), 'wide');
  const byName = [...wide].sort();
  assert.notDeepEqual(wide, byName, 'the tied consumers are not in name order');
});

test('a recent landing failure leads its equally close peers; a closer test still leads a recent one', () => {
  const files = inventory();
  const failed = 'tests/consumer-77.test.mjs';
  const recent = selectPreflightTests({
    files,
    paths: ['src/job-queue.ts'],
    hubBudget: budget,
    recent: [failed],
  });
  assert.equal(tier(recent, 'wide')[0], failed);
  assert.equal(recent.relevance[failed][0], 1);
});

test('relevance counts name affinity and mentions of a changed module, not the alphabet', () => {
  const files = new Map([
    ['src/projectHostedComposeJobs.ts', ''],
    ['tests/hosted-compose.test.mjs', "x('projectHostedComposeJobs:run')"],
    ['tests/hosted-agent-cache.test.mjs', ''],
    ['tests/aaa.test.mjs', ''],
  ]);
  const score = relevanceFor({ files, changed: ['src/projectHostedComposeJobs.ts'] });
  assert.deepEqual(score('tests/hosted-compose.test.mjs'), [0, 100, 1]);
  assert.ok(
    compareRelevance(score('tests/hosted-compose.test.mjs'), score('tests/hosted-agent-cache.test.mjs')) < 0,
  );
  assert.ok(compareRelevance(score('tests/hosted-agent-cache.test.mjs'), score('tests/aaa.test.mjs')) < 0);
  assert.equal(compareRelevance(score('tests/aaa.test.mjs'), score('tests/aaa.test.mjs')), 0);
  // A plural never separates a test from its module.
  const plural = relevanceFor({ files: new Map(), changed: ['convex/projectHostedSaveJobs.ts'] });
  assert.equal(plural('tests/hosted-saves.test.mjs')[1], 100);
});

test('the stable key depends on the change and the test only', () => {
  const salt = changeSalt(['b.ts', 'a.ts', 'a.ts']);
  assert.equal(salt, changeSalt(['a.ts', 'b.ts']));
  assert.equal(stableKey(salt, 'tests/x.test.mjs'), stableKey(salt, 'tests/x.test.mjs'));
  assert.notEqual(stableKey(salt, 'tests/x.test.mjs'), stableKey(changeSalt(['c.ts']), 'tests/x.test.mjs'));
});

test('history ordering keeps relevance ahead of cost and the selector hash order behind both', () => {
  const tiers = [{ tier: 'wide', tests: ['p', 'q', 'r', 's'] }];
  const ranks = { p: [0, 1, 0], q: [0, 1, 0], r: [0, 1, 0], s: [0, 1, 0] };
  const relevance = { p: [0, 0, 0], q: [1, 0, 0], r: [0, 100, 0], s: [0, 0, 0] };
  // No cost history: q (recent), r (name), then p, s in the selector's stable order.
  assert.deepEqual(orderByHistory(tiers, {}, 1000, ranks, relevance)[0].tests, ['q', 'r', 'p', 's']);
  // A cheaper known cost reorders only within equal relevance.
  const stats = {
    p: { ms: 5000, failed: false },
    s: { ms: 10, failed: false },
    r: { ms: 9000, failed: false },
  };
  assert.deepEqual(orderByHistory(tiers, stats, 1000, ranks, relevance)[0].tests, ['q', 'r', 's', 'p']);
});

test('a path-selecting runner orders its tiers by folder then stable hash, not by name', () => {
  const changed = ['pkg/a/src/engine.py'];
  const tests = ['pkg/b/tests/test_one.py', 'pkg/a/tests/test_two.py', 'pkg/b/tests/test_three.py'];
  const ordered = orderRunnerTests(tests, changed);
  assert.equal(ordered[0], 'pkg/a/tests/test_two.py');
  assert.deepEqual(ordered, orderRunnerTests([...tests].reverse(), changed));
  // Adding unrelated tests to the inventory leaves the relative order of the others unchanged.
  const grown = orderRunnerTests([...tests, 'zz/tests/test_late.py', 'aa/tests/test_early.py'], changed);
  assert.deepEqual(
    grown.filter(test => tests.includes(test)),
    ordered,
  );
});
