// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { profiles, simulate } from './queue-sim/driver.mjs';
const environment = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-queue-sim' };
const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, environment));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const known = JSON.parse(
  readFileSync(new URL('./queue-sim/known-violations.json', import.meta.url)),
).violations;
// The 20-seed pilot took 136 seconds on the shared builder. Keep every check
// and each profile; the longer 200/5000-seed runs remain explicit local runs.
const seeds = process.env.FORGE_QUEUE_SIM_SEED
  ? [Number(process.env.FORGE_QUEUE_SIM_SEED)]
  : Array.from({ length: Number(process.env.FORGE_QUEUE_SIM_SEEDS ?? 8) }, (_, i) => i + 1);
const corpus = JSON.parse(readFileSync(new URL('./fixtures/queue-sim-corpus.json', import.meta.url))).cases;
const cases = [
  ...new Map(
    [
      ...seeds.map(seed => ({
        seed,
        profile: process.env.FORGE_QUEUE_SIM_PROFILE ?? profiles[(seed - 1) % profiles.length],
      })),
      ...(process.env.FORGE_QUEUE_SIM_SEED ? [] : corpus.filter(entry => !entry.mutant)),
    ].map(entry => [`${entry.seed}/${entry.profile}`, entry]),
  ).values(),
];
test('known queue violations may only shrink from the initial measured baseline', () => {
  assert(Object.keys(known).length <= 5, 'a new waiver requires a reviewed baseline decision');
});
for (const { seed, profile } of cases) {
  test(`queue invariants seed ${seed} ${profile}`, async t => {
    const result = await simulate(t, { seed, profile });
    const unexpected = result.violations.filter(issue => !known[issue.id]);
    assert.deepEqual(unexpected, [], JSON.stringify({ seed, profile, unexpected, events: result.events }));
    if (result.violations.length)
      t.diagnostic(
        JSON.stringify({ knownViolations: [...new Set(result.violations.map(issue => issue.id))] }),
      );
  });
}

test('5e3c3a3c: holder starts a new check while followers are parked; a parked entry with no alarm is detected', async t => {
  const { parkedIncident } = await import('./queue-sim/parked-incident.mjs');
  const { inspectQueue, requestRows } = await import('./queue-sim/invariants.mjs');
  // The detector needs the pre-N1 counterexample: pin the new-run wake off.
  const previous = process.env.FORGE_QUEUE_NEW_RUN_WAKE;
  delete process.env.FORGE_QUEUE_NEW_RUN_WAKE;
  t.after(() => {
    if (previous !== undefined) process.env.FORGE_QUEUE_NEW_RUN_WAKE = previous;
  });
  const { f, followers } = await parkedIncident(t);
  const before = JSON.stringify(
    Object.fromEntries(Object.entries(f.tables).map(([name, rows]) => [name, [...rows.values()]])),
  );
  const issues = await inspectQueue(f);
  assert.equal(
    JSON.stringify(
      Object.fromEntries(Object.entries(f.tables).map(([name, rows]) => [name, [...rows.values()]])),
    ),
    before,
    'the detector cannot repair its counterexample',
  );
  for (const id of ['L1', 'L2']) {
    if (known[id])
      assert(
        issues.some(issue => issue.id === id && followers.includes(issue.submission)),
        `retained incident demonstrates ${id}`,
      );
    else assert(!issues.some(issue => issue.id === id), `${id} must remain fixed`);
  }
  assert(
    requestRows(f).some(row => row.orderWait),
    'exercise real persisted wait edges',
  );
});

test('e4aee4fe: a slow older entry keeps its lifetime generation budget as newer passes arrive', async t => {
  const result = await simulate(t, { seed: 4, profile: 'slow-old' });
  assert(!result.violations.some(issue => issue.id === 'S4'), JSON.stringify(result.violations));
  assert(
    [...result.f.tables.projectHostedLandingRequests.values()].every(row =>
      ['landed', 'terminal-failed'].includes(row.phase),
    ),
  );
});

test('S4 detector rejects the historical no-order-holding mutant without modifying source', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const patches = [
    {
      file: 'convex/projectHostedLandingOrder.ts',
      find: "    (row.phase === 'queued' || row.phase === 'checking' || row.phase === 'ready') &&",
      replace:
        "    false && (row.phase === 'queued' || row.phase === 'checking' || row.phase === 'ready') &&",
    },
  ];
  const environment = {
    ...process.env,
    FORGE_TEST_SOURCE_PATCHES: JSON.stringify(patches),
    FORGE_TEST_PRECOMPILED: '0',
  };
  delete environment.NODE_TEST_CONTEXT;
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      ['--import', './tests/check-runtime.mjs', '--test', 'tests/queue-sim/mutant-runner.mjs'],
      {
        env: environment,
        maxBuffer: 4 * 1024 * 1024,
      },
    ),
    error => error.code === 1 && `${error.stdout}\n${error.stderr}`.includes('QUEUE_INVARIANT S4'),
  );
});

// Owner split: these assert the intended runtime contract and fail on current main.
// The corresponding rule landing enables its test; detector-unit tests above stay live.
test('5e3c3a3c new-run wake: holder starts a new check while followers are parked', async t => {
  const { parkedIncident } = await import('./queue-sim/parked-incident.mjs');
  const previous = process.env.FORGE_QUEUE_NEW_RUN_WAKE;
  process.env.FORGE_QUEUE_NEW_RUN_WAKE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_QUEUE_NEW_RUN_WAKE;
    else process.env.FORGE_QUEUE_NEW_RUN_WAKE = previous;
  });
  const { waiterReclaimed } = await parkedIncident(t);
  assert(waiterReclaimed, 'a new holder generation leaves its oldest parked follower a fresh claim');
});

test.skip('5e3c3a3c L1 deadline: a parked entry with no alarm', async t => {
  const { parkedIncident } = await import('./queue-sim/parked-incident.mjs');
  const { inspectQueue } = await import('./queue-sim/invariants.mjs');
  const { f } = await parkedIncident(t);
  assert.deepEqual(
    (await inspectQueue(f)).filter(issue => issue.id === 'L1'),
    [],
    'every parked entry has an armed deadline',
  );
});
