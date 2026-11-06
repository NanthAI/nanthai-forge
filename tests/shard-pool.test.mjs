// SPDX-License-Identifier: Apache-2.0
// Shard pool (work stealing, Issue 0ea17a29): planning, executor parts and the claim protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planPool,
  poolUnits,
  keptFiles,
  validPool,
  poolArm,
  maxPoolUnits,
  poolUnitMs,
} from '../scripts/shard-pool.mjs';
import { partitionTests, shardDuration } from '../scripts/test-shards.mjs';
import { runActionsCheck } from '../scripts/github-actions-check.mjs';
import {
  runShardPool,
  mergeShardReports,
  settlePoolPending,
  poolClaimKey,
  describePoolOutcome,
} from '../dist/hosted-actions-pool.js';
import { hostedActionsRecipeSchema } from '../dist/hosted-actions.js';

const files = count =>
  Array.from({ length: count }, (_, i) => `tests/p-${String(i).padStart(3, '0')}.test.mjs`);
const durations = list => Object.fromEntries(list.map((file, i) => [file, 2000 + ((i * 7919) % 40) * 1000]));

test('the pool offers each shard tail as units and partitions every grouped file exactly once', () => {
  const list = files(300),
    timing = durations(list);
  const groups = partitionTests(list, 11, timing);
  const pool = planPool(groups, timing);
  assert(pool && validPool(groups, pool));
  const units = poolUnits(groups, pool);
  const all = [...groups.flatMap((_, i) => keptFiles(groups, pool, i)), ...units.flatMap(unit => unit.files)];
  assert.deepEqual(all.slice().sort(), list.slice().sort());
  assert.equal(new Set(all).size, all.length);
  for (const [index, group] of groups.entries()) {
    const planned = shardDuration(group, timing);
    const tail = units.filter(unit => unit.home === index).flatMap(unit => unit.files);
    // About a fifth of the shard is offered, never its whole group.
    assert(keptFiles(groups, pool, index).length >= 1);
    assert(shardDuration(tail, timing) >= planned * 0.2);
    assert(shardDuration(tail, timing) <= planned * 0.2 + Math.max(...tail.map(file => timing[file])));
    // Units are large enough to be worth a claim, except a tail shorter than one unit.
    const own = units.filter(unit => unit.home === index);
    if (own.length > 1) assert(own.every(unit => shardDuration(unit.files, timing) >= poolUnitMs));
  }
  assert(units.length <= maxPoolUnits);
});

test('no pool for single files, short shards, unmeasured plans or too many units', () => {
  assert.equal(planPool([['tests/a.test.mjs']], { 'tests/a.test.mjs': 600_000 }), undefined);
  assert.equal(planPool(partitionTests(files(20), 2, {}), {}), undefined);
  const list = files(40),
    short = Object.fromEntries(list.map(file => [file, 1000]));
  assert.equal(planPool(partitionTests(list, 4, short), short), undefined);
  const timing = durations(files(300));
  assert.equal(planPool(partitionTests(files(300), 11, timing), timing, { maxUnits: 3 }), undefined);
});

test('the recipe schema refuses pools that leave a group, empty a kept front or exceed the bound', () => {
  const groups = [
    ['tests/a.test.mjs', 'tests/b.test.mjs'],
    ['tests/c.test.mjs', 'tests/d.test.mjs'],
  ];
  const recipe = pool => ({
    pin: 'a'.repeat(64),
    head: 'b'.repeat(64),
    definition: 'c'.repeat(64),
    selection: { scope: 'full', reason: 'x', tests: groups.flat() },
    groups,
    ...(pool === undefined ? {} : { pool }),
    standard: true,
    interaction: false,
    command: ['node', 'scripts/forge-check.mjs'],
  });
  assert(hostedActionsRecipeSchema.safeParse(recipe(undefined)).success);
  assert(hostedActionsRecipeSchema.safeParse(recipe([[1], []])).success);
  for (const bad of [[[0], []], [[2], []], [[1]], [[1, 1], []], [[], []], [['1'], []]])
    assert(!hostedActionsRecipeSchema.safeParse(recipe(bad)).success, JSON.stringify(bad));
});

test('pool arm: on by default, off on request, ab splits random run ids about evenly', () => {
  assert.equal(poolArm(undefined, 'x'), true);
  assert.equal(poolArm('on', 'x'), true);
  assert.equal(poolArm('off', 'x'), false);
  assert.equal(poolArm('typo', 'x'), false);
  assert.equal(poolArm('ab', '00000000-0000-4000-8000-000000000001'), true);
  assert.equal(poolArm('ab', '00000000-0000-4000-8000-00000000000a'), false);
  let on = 0;
  for (let i = 0; i < 1000; i++) on += poolArm('ab', crypto.randomUUID()) ? 1 : 0;
  assert(on > 400 && on < 600);
});

test('claim keys are run scoped under one lifecycle prefix', () => {
  assert.equal(poolClaimKey('p1', 'r1', 'e1', 3), 'v1/pool/p1/r1/e1/3');
});

function executorFixture(t, plan) {
  const root = mkdtempSync(join(tmpdir(), 'forge-shard-pool-'));
  const previous = { cwd: process.cwd(), env: { ...process.env } };
  t.after(() => {
    process.chdir(previous.cwd);
    for (const key of ['FORGE_ACTIONS_PLAN', 'FORGE_ACTIONS_SHARD', 'FORGE_ACTIONS_POOL_PART'])
      if (previous.env[key] === undefined) delete process.env[key];
      else process.env[key] = previous.env[key];
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  process.chdir(root);
  process.env.FORGE_ACTIONS_PLAN = join(root, 'plan.json');
  process.env.FORGE_ACTIONS_SHARD = '1';
}
test('executor parts: kept installs, builds and runs the front; a unit runs only its pinned files', t => {
  const groups = [
    ['tests/a.test.mjs', 'tests/b.test.mjs'],
    ['tests/c.test.mjs', 'tests/d.test.mjs', 'tests/e.test.mjs'],
  ];
  executorFixture(t, {
    standard: true,
    pin: 'a',
    head: 'b',
    selection: { scope: 'full', reason: 'x', tests: groups.flat() },
    groups,
    pool: [[1], [1, 2]],
  });
  const runs = part => {
    if (part === undefined) delete process.env.FORGE_ACTIONS_POOL_PART;
    else process.env.FORGE_ACTIONS_POOL_PART = part;
    const calls = [];
    runActionsCheck((command, args, options) =>
      calls.push([
        command === process.execPath ? 'node' : command,
        ...args,
        options.env.FORGE_ACTIONS_POOL_PART ?? '-',
      ]),
    );
    return calls;
  };
  // No part: the whole group, exactly as the static plan.
  assert.deepEqual(runs(undefined).at(-1), ['node', 'scripts/test-files.mjs', ...groups[1], '-']);
  assert.deepEqual(runs('kept'), [
    ['npm', 'ci', '--ignore-scripts', '-'],
    ['npm', 'run', 'build:core', '-'],
    ['npm', 'run', 'build:web', '-'],
    ['node', 'scripts/test-files.mjs', 'tests/c.test.mjs', '-'],
  ]);
  // Units are numbered across shards (home-major): unit 0 is shard 0's, units 1 and 2 shard 1's.
  // Any shard may run any unit; the part never reaches project scripts.
  assert.deepEqual(runs('2'), [['node', 'scripts/test-files.mjs', 'tests/e.test.mjs', '-']]);
  assert.deepEqual(runs('0'), [['node', 'scripts/test-files.mjs', 'tests/b.test.mjs', '-']]);
  assert.throws(() => runs('3'), /Unselected shard pool unit/);
  assert.throws(() => runs('../1'), /Unselected shard pool unit/);
});
test('executor refuses a pool part when the pinned plan has no valid pool', t => {
  executorFixture(t, {
    standard: true,
    pin: 'a',
    head: 'b',
    selection: { scope: 'full', reason: 'x', tests: ['tests/a.test.mjs', 'tests/b.test.mjs'] },
    groups: [['tests/a.test.mjs'], ['tests/b.test.mjs']],
  });
  process.env.FORGE_ACTIONS_POOL_PART = 'kept';
  assert.throws(() => runActionsCheck(() => {}), /without a valid pinned pool/);
});

// Randomized concurrent simulation of N shards against a create-only store.
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function simulate({ seed, shards = 6, unitsPerShard = 3, faults = {} }) {
  const rand = random(seed);
  const units = [];
  for (let home = 0; home < shards; home++)
    for (let k = 0; k < unitsPerShard; k++)
      units.push({ unit: units.length, home, files: [`tests/u-${units.length}.test.mjs`] });
  const store = new Map(faults.forged?.map(unit => [unit, 'forged']) ?? []);
  const claims = units.map(({ unit }) => ({
    put: { url: `https://claims.invalid/${unit}`, headers: {} },
    head: `https://claims.invalid/${unit}`,
  }));
  const request = async (url, init) => {
    await sleep(rand() * 2);
    const unit = Number(String(url).split('/').at(-1));
    if (faults.error && rand() < faults.error) {
      // Ambiguous: the write may have landed before the error.
      if (init.method === 'PUT' && rand() < 0.5 && !store.has(unit)) store.set(unit, 'ambiguous');
      throw new TypeError('fetch failed');
    }
    if (init.method === 'HEAD') return new Response(null, { status: store.has(unit) ? 200 : 404 });
    if (store.has(unit)) return new Response(null, { status: 412 });
    store.set(unit, 'claimed');
    return new Response(null, { status: 200 });
  };
  const runs = new Map(units.map(unit => [unit.unit, 0]));
  const outcomes = await Promise.all(
    Array.from({ length: shards }, async (_, home) => {
      const speed = 0.5 + rand() * 1.5;
      await sleep(10 * speed + rand() * 5);
      return runShardPool({
        units,
        home,
        claims: faults.noTargets ? null : claims,
        request,
        run: async unit => {
          runs.set(unit.unit, runs.get(unit.unit) + 1);
          await sleep(3 * speed);
        },
      });
    }),
  );
  return { units, runs, outcomes };
}

test('claim protocol guard: a healthy store runs every unit exactly once across 80 random interleavings', async () => {
  for (let seed = 1; seed <= 80; seed++) {
    const { runs, outcomes } = await simulate({ seed });
    assert.deepEqual(
      [...runs.values()].filter(count => count !== 1),
      [],
      `seed ${seed}`,
    );
    assert(
      outcomes.every(outcome => !outcome.doubt.length && !outcome.fallback),
      `seed ${seed}`,
    );
  }
});

test('claim protocol guard: failing and ambiguous writes never lose a unit; every second run is a reported doubt run', async () => {
  for (let seed = 1; seed <= 80; seed++) {
    const { units, runs, outcomes } = await simulate({ seed, faults: { error: 0.15 } });
    const doubt = new Set(outcomes.flatMap(outcome => outcome.doubt));
    for (const unit of units) {
      const count = runs.get(unit.unit);
      // Run on doubt: whoever might own a unit runs it, so no unit is ever left unrun.
      assert(count >= 1, `seed ${seed}: unit ${unit.unit} never ran`);
      if (count > 1)
        assert(
          doubt.has(unit.unit),
          `seed ${seed}: unit ${unit.unit} ran ${count} times without a doubt report`,
        );
    }
  }
});

test('claim protocol guard: without claim targets every shard runs exactly its static group', async () => {
  const { units, runs, outcomes } = await simulate({ seed: 7, faults: { noTargets: true } });
  assert.deepEqual(
    [...runs.values()],
    units.map(() => 1),
  );
  assert(
    outcomes.every(
      (outcome, home) =>
        outcome.fallback && !outcome.doubt.length && outcome.ran.every(unit => units[unit].home === home),
    ),
  );
  assert.match(describePoolOutcome(outcomes[0], 0, units), /static fallback: no claim targets/);
});

test('claim protocol guard: forged claims leave units unrun, and the home reports them as yielded', async () => {
  for (let seed = 1; seed <= 30; seed++) {
    const forged = [1, 4];
    const { units, runs, outcomes } = await simulate({ seed, faults: { forged } });
    for (const unit of units)
      assert.equal(runs.get(unit.unit), forged.includes(unit.unit) ? 0 : 1, `seed ${seed}`);
    const yielded = outcomes.flatMap(outcome => outcome.yielded);
    for (const unit of forged) assert(yielded.includes(unit), `seed ${seed}`);
  }
});

test('server merge counts a file run twice once and never lets a pass hide a failure', () => {
  const pass = { failed: false, durationMs: 5 },
    fail = { failed: true, durationMs: 5, firstError: 'boom' };
  assert.deepEqual(mergeShardReports({ 'tests/a.test.mjs': fail }, { 'tests/a.test.mjs': pass }), {
    'tests/a.test.mjs': fail,
  });
  assert.deepEqual(mergeShardReports({ 'tests/a.test.mjs': pass }, { 'tests/a.test.mjs': fail }), {
    'tests/a.test.mjs': fail,
  });
  assert.deepEqual(mergeShardReports({ 'tests/a.test.mjs': pass }, { 'tests/b.test.mjs': pass }), {
    'tests/a.test.mjs': pass,
    'tests/b.test.mjs': pass,
  });
});

test('server pending: yielded files reported later clear; unreported ones fail at completion only', () => {
  const pass = { failed: false, durationMs: 5 };
  let state = settlePoolPending({}, [], ['tests/b.test.mjs', 'tests/a.test.mjs'], false);
  assert.deepEqual(state.pending, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  state = settlePoolPending({ 'tests/a.test.mjs': pass }, state.pending, [], false);
  assert.deepEqual(state.pending, ['tests/b.test.mjs']);
  state = settlePoolPending({ 'tests/a.test.mjs': pass }, state.pending, [], true);
  assert.deepEqual(state.pending, []);
  assert.equal(state.reports['tests/b.test.mjs'].failed, true);
  assert.match(state.reports['tests/b.test.mjs'].firstError, /^POOL_UNIT_UNREPORTED/);
  assert.equal(state.reports['tests/a.test.mjs'], pass);
});
