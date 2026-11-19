// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  browserTests,
  browserFiles,
  isBrowserTest,
  browserChange,
  browserSelection,
  browserGroups,
  browserShard,
} from '../scripts/browser-test-policy.mjs';
import { partitionTests, shardDuration } from '../scripts/test-shards.mjs';
import { planPool, validPool } from '../scripts/shard-pool.mjs';
import { benchmarkPlan } from '../scripts/bench-landing-shard.mjs';
import { standardSelection } from '../scripts/test-impact.mjs';

// Named fixtures need no registry entry; the inventory mixes both kinds.
const allBrowser = [...browserTests, 'tests/app-plan-browser.test.mjs', 'tests/needs-me-browser.test.mjs'];
const inventory = new Map([...allBrowser, 'tests/server.test.mjs'].map(path => [path, '']));

test('1dd4e095: projects without browser files retain their ordinary selection and recipe metadata', () => {
  const selection = { scope: 'full', tests: ['tests/server.test.mjs'], reason: 'ordinary check' };
  const files = new Map([['tests/server.test.mjs', '']]);
  for (const paths of [undefined, ['web/src/view.ts'], ['src/server.ts'], ['package-lock.json']])
    assert.deepEqual(browserSelection(selection, paths, files), selection);
});

function sharedWebSource() {
  return new Map([
    ['src/shared.ts', 'export const value = 1;'],
    ['web/src/view.ts', `import {value} from '../../src/shared'; export {value};`],
    [browserTests[0], `import '../web/src/view';`],
    ['tests/ordinary.test.mjs', `import '../src/shared';`],
  ]);
}
test('1dd4e095: a scoped planner builds the import graph once when it already selected a browser test', t => {
  const before = process.env.FORGE_CHECK_SCOPED;
  process.env.FORGE_CHECK_SCOPED = '1';
  t.after(() => {
    if (before === undefined) delete process.env.FORGE_CHECK_SCOPED;
    else process.env.FORGE_CHECK_SCOPED = before;
  });
  const files = sharedWebSource();
  const get = files.get.bind(files);
  let graphReads = 0;
  files.get = path => {
    if (path === 'web/src/view.ts') graphReads++;
    return get(path);
  };
  const plan = benchmarkPlan(2, { paths: ['src/shared.ts'] }, files, {});
  assert.equal(plan.selection.scope, 'scoped');
  assert.equal(plan.selection.browser, true);
  assert.equal(graphReads, 1, 'the graph parser reads this module once; a second graph would read it again');
});
test('1dd4e095: browser selection reuses the existing graph when the selected tests contain no browser', () => {
  const files = sharedWebSource(),
    graphCache = {};
  const paths = ['src/shared.ts'];
  const selected = standardSelection({ files, paths, graphCache, env: { FORGE_CHECK_SCOPED: '1' } });
  assert(graphCache.graph, 'ordinary selection produced the graph');
  files.get = () => assert.fail('browser selection must not parse any source a second time');
  const browser = browserSelection(
    { ...selected, tests: ['tests/ordinary.test.mjs'] },
    paths,
    files,
    graphCache,
  );
  assert.equal(browser.browser, true);
});
test('1dd4e095: non-web checks omit browser files while preserving static docs contracts', () => {
  const selected = browserSelection(
    { scope: 'full', tests: [...inventory.keys()] },
    ['src/server.ts'],
    inventory,
  );
  assert.equal(selected.browser, false);
  assert.deepEqual(selected.tests, ['tests/docs-site.test.mjs', 'tests/server.test.mjs']);
});
test('1dd4e095: a web or design-system change selects every present browser fixture', () => {
  for (const path of ['web/src/app.tsx', 'web/src/ds/tokens.css', 'tests/ds-reference.test.mjs']) {
    const selected = browserSelection({ tests: ['tests/server.test.mjs'] }, [path], inventory);
    assert.equal(selected.browser, true);
    for (const browser of allBrowser) assert(selected.tests.includes(browser));
  }
});
test('1dd4e095: one existing job owns browser tests without increasing the job count', () => {
  const groups = [
    [browserTests[0], 'tests/a.test.mjs'],
    [allBrowser.at(-1), 'tests/b.test.mjs'],
    ['tests/c.test.mjs'],
  ];
  const pinned = browserGroups(groups, true);
  assert.equal(pinned.length, groups.length);
  assert.deepEqual(pinned.flat().sort(), groups.flat().sort());
  assert.equal(pinned.filter(g => g.some(isBrowserTest)).length, 1);
  assert.equal(browserShard(pinned, true), 2);
  assert.equal(browserShard(pinned, false), -1);
  const pool = planPool(pinned, {}, { minShardMs: 0, unitMs: 1 });
  if (pool) {
    pool[2] = [];
    if (pool.some(c => c.length)) assert(validPool(pinned, pool));
  }
});
test('1dd4e095: every browser-launching file is a browser fixture by name or registry, and nothing else is', () => {
  const names = readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.test.mjs'));
  const actual = names
    .filter(name => {
      const source = readFileSync(new URL(name, import.meta.url), 'utf8');
      return source.includes('chromium' + '.launch(') || source.includes('billing' + 'Fixture(');
    })
    .map(name => `tests/${name}`)
    .sort();
  assert.deepEqual(browserFiles(names.map(name => `tests/${name}`)), actual);
  // The registry holds only fixtures the name rule misses; named ones never need an entry.
  for (const file of browserTests) assert.doesNotMatch(file, /-browser\.test\.mjs$/, file);
});
test('1dd4e095: a Candidate adding a -browser fixture gets browser coverage and the browser job without a registry edit', () => {
  const added = 'tests/zz-new-screen-browser.test.mjs';
  assert.equal(browserTests.includes(added), false);
  const files = new Map([...inventory, [added, '']]);
  const selected = browserSelection({ tests: ['tests/server.test.mjs'] }, [added], files);
  assert.equal(selected.browser, true);
  assert(selected.tests.includes(added));
  const groups = browserGroups(
    [[added, 'tests/a.test.mjs'], ['tests/b.test.mjs'], ['tests/c.test.mjs']],
    true,
  );
  assert(groups[browserShard(groups, true)].includes(added));
  // Non-web changes leave the new named fixture out, like every registered one.
  const ordinary = browserSelection({ scope: 'full', tests: [...files.keys()] }, ['src/server.ts'], files);
  assert.equal(ordinary.tests.includes(added), false);
  assert.equal(isBrowserTest('tests/browser-runtime.test.mjs'), false);
  assert.equal(isBrowserTest('tests/sub/x-browser.test.mjs'), false);
});

for (const path of [
  ...allBrowser,
  'tests/billing-fixture.mjs',
  'tests/fixtures/owner-decisions-preview.tsx',
  'tests/browser/lanes-yard.tsx',
  'tests/browser-runtime.mjs',
  'scripts/check-browser-runtime.mjs',
  'package.json',
  'package-lock.json',
  'scripts/browser-test-policy.mjs',
  'web/vite.config.ts',
])
  test(`1dd4e095: browser coverage follows changed browser input ${path}`, () => {
    assert.equal(browserSelection({ tests: [] }, [path], inventory).browser, true);
  });

test('1dd4e095: runtime and type web imports reach shared src and Convex contracts, without selecting unrelated backend code', () => {
  const files = new Map([
    ...inventory,
    [
      'web/src/App.tsx',
      `import {model} from '../../src/planning-model'; import type {Work} from '../../src/work-types'; import type {Data} from '../../convex/_generated/dataModel';`,
    ],
    ['src/planning-model.ts', 'export const model = 1;'],
    ['src/work-types.ts', 'export type Work = {};'],
    [
      'convex/_generated/dataModel.d.ts',
      `import type schema from '../schema'; export type Data = typeof schema;`,
    ],
    ['convex/schema.ts', 'export default {};'],
    ['src/unrelated.ts', 'export const server = 1;'],
    ['convex/server.ts', 'export const server = 1;'],
    // A test which imports both domains must not turn a test edge into a web import.
    ['tests/shared.test.mjs', `import '../src/unrelated'; import '../web/src/App';`],
  ]);
  for (const path of ['src/planning-model.ts', 'src/work-types.ts', 'convex/schema.ts'])
    assert.equal(browserChange([path], files), true, path);
  for (const path of ['src/unrelated.ts', 'convex/server.ts'])
    assert.equal(browserChange([path], files), false, path);
});

test('1dd4e095: the browser job fills with ordinary work instead of consuming an ordinary shard', () => {
  const ordinary = Array.from({ length: 100 }, (_, i) => `tests/ordinary-${i}.test.mjs`);
  const files = [...ordinary, ...allBrowser];
  const durations = Object.fromEntries(files.map(file => [file, isBrowserTest(file) ? 1000 : 10000]));
  const before = partitionTests(files, 11, durations);
  const after = browserGroups(before, true, durations);
  assert.equal(after.length, before.length);
  assert(after[browserShard(after, true)].some(file => ordinary.includes(file)));
  assert.equal(
    Math.max(...after.map(group => shardDuration(group, durations))),
    Math.max(...before.map(group => shardDuration(group, durations))),
  );
  assert.deepEqual(browserGroups(before, false, durations), before);
});
