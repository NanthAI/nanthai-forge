// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { nameLiterals, watchRanking, distinctiveShare } from '../scripts/test-name-watchers.mjs';
import { fitPreflightBudget, selectTests, selectPreflightTests } from '../scripts/test-impact.mjs';

// The 2026-11-05 miss: a module names its private stage folders with mkdtemp prefixes and a test
// hooks fs.open on paths matching them. Four import edges separate them, so the graph ranks the test
// behind everything nearer, yet it is the test that fails when the prefix changes.
const inventory = () =>
  new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'src/stage.ts':
        "import { mkdtempSync } from 'node:fs'; import { join } from 'node:path';\n" +
        "export const stage = (root: string, delta: boolean) => mkdtempSync(join(root, delta ? 'delta-' : 'checkout-'));",
      'src/actions.ts': "import { stage } from './stage.js'; export const run = stage;",
      'src/transport.ts': "import { run } from './actions.js'; export const t = run;",
      'tests/fixture.mjs': "import { t } from '../dist/transport.js'; export const f = t;",
      'tests/barriers.test.mjs':
        "import { f } from './fixture.mjs';\nconst hooked = /\\/(checkout|delta)-/;\nexport { f, hooked };",
      'tests/direct.test.mjs': "import '../dist/stage.js';",
      'tests/unrelated.test.mjs': "const file = 'result.json'; export { file };",
    }),
  );

test('name literals keep path-like names, drop import specifiers and read regex literals', () => {
  const { names, patterns } = nameLiterals(
    'src/x.ts',
    "import a from './not-a-name.js';\nconst p = join(root, 'stage');\nconst q = 'delta-' + `${x}-suffix`;\nconst w = 'plain';\nconst r = /(a|b)-/;",
  );
  assert.deepEqual([...names].sort(), ['delta-', 'stage']);
  assert.equal(patterns.length, 1);
  assert.ok(patterns[0].test('/b-x'));
});

test('a test whose path regex matches a name a changed source creates is promoted at any import distance', () => {
  const files = inventory();
  const paths = ['src/stage.ts'];
  const complete = selectTests({ files, paths });
  const barrier = complete.reasons['tests/barriers.test.mjs'];
  assert.equal(barrier.edges.length, 4, 'four import edges: the graph alone ranks it last');
  const plan = selectPreflightTests({ files, paths });
  const tier = name => plan.tiers.find(item => item.tier === name).tests;
  assert.deepEqual(tier('direct'), ['tests/direct.test.mjs']);
  assert.deepEqual(tier('watch'), ['tests/barriers.test.mjs']);
  assert.deepEqual(plan.watchedNames['tests/barriers.test.mjs'].sort(), ['checkout-', 'delta-']);
  // Promotion changes the order and the local/deferred split only: landing coverage is untouched.
  assert.deepEqual([...plan.tests, ...plan.deferredTests].sort(), complete.tests);
  assert.ok(!plan.deferredTests.includes('tests/barriers.test.mjs'));
  assert.ok(!plan.tests.includes('tests/unrelated.test.mjs'));
  // A budget that fits two files keeps the direct consumer and the watcher; nothing nearer waits behind them.
  const fit = fitPreflightBudget({ tiers: plan.tiers, budgetSeconds: 8, secondsPerFile: 4 });
  assert.deepEqual(fit.tests, ['tests/direct.test.mjs', 'tests/barriers.test.mjs']);
});

test('a name most tests touch is not evidence, and rarity is a share of the whole suite, not a count', () => {
  const files = inventory();
  for (let i = 0; i < 300; i++)
    files.set(`tests/common-${i}.test.mjs`, `const x = 'delta-'; export { x }; // ${i}`);
  const tests = [...files.keys()].filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path));
  const selected = selectTests({ files, paths: ['src/stage.ts'] }).tests;
  const ranking = watchRanking({ files, tests, candidates: selected, changed: ['src/stage.ts'] });
  // 'delta-' now matches 300+ of ~300 tests (over the share); 'checkout-' still singles out the barrier test.
  assert.ok(300 > tests.length * distinctiveShare);
  assert.deepEqual([...ranking.keys()], ['tests/barriers.test.mjs']);
  assert.deepEqual(ranking.get('tests/barriers.test.mjs').names, ['checkout-']);
});

test('changed test files and non-source paths contribute no names; deleted sources are skipped', () => {
  const files = inventory();
  const tests = [...files.keys()].filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path));
  const ranking = watchRanking({
    files,
    tests,
    candidates: tests,
    changed: ['tests/barriers.test.mjs', 'docs/readme.md', 'src/deleted.ts'],
  });
  assert.equal(ranking.size, 0);
});
