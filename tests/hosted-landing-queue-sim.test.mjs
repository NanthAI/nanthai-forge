// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
  assert(Object.keys(known).length <= 4, 'a new waiver requires a reviewed baseline decision');
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

// The detector needs the pre-N1 counterexample: the parked incident runs in a child process on the
// historical no-new-run-wake mutant (source patched for that compile only, as for S4 below).
const PRE_N1 = [
  {
    file: 'convex/projectHostedFinishWake.ts',
    find: '    row.orderWaited &&',
    replace: '    false &&\n    row.orderWaited &&',
  },
];
/** One pre-N1 mutant child runs both mutant tests (one uncompiled build). Each caller asserts its own
 * test passed by name: a renamed or missing test must not pass as a proof (review 3c9fed74). */
let mutant;
function mutantChild() {
  mutant ??= (async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const environment = {
      ...process.env,
      FORGE_TEST_SOURCE_PATCHES: JSON.stringify(PRE_N1),
      FORGE_TEST_PRECOMPILED: '0',
    };
    delete environment.NODE_TEST_CONTEXT;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        './tests/check-runtime.mjs',
        '--test',
        '--test-reporter=tap',
        'tests/queue-sim/parked-mutant-runner.mjs',
      ],
      { env: environment, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout;
  })();
  return mutant;
}
test('5e3c3a3c: holder starts a new check while followers are parked; the pre-N1 stale chain is detected', async t => {
  const { parkedIncident } = await import('./queue-sim/parked-incident.mjs');
  const { inspectQueue } = await import('./queue-sim/invariants.mjs');
  // The mutant child asserts the stale edge (L2) on the stored chain, that L1 stays silent (a
  // parked follower holds no timer of its own; the holder's live re-check drives the chain end),
  // and that the detector left the chain unchanged.
  assert.match(
    await mutantChild(),
    /^ok \d+ - pre-N1 parked incident: the detector exposes the stale chain$/m,
  );
  // Current code: the new-run wake gives the oldest parked follower a fresh claim, so this
  // incident leaves no stale edge (L2) on its followers.
  const { f, followers } = await parkedIncident(t);
  const issues = await inspectQueue(f);
  assert(
    !issues.some(issue => issue.id === 'L2' && followers.includes(issue.submission)),
    JSON.stringify(issues.filter(issue => issue.id === 'L2')),
  );
});

// Guard 2 (2873b486): the incident is a permanent gate on pass-to-land. The holder's re-check takes
// 30 simulated minutes; each passed follower must land within the ceiling meanwhile. The pre-N1
// mutant (child process, as above) must break the ceiling for every follower, so the gate is known
// to catch the regression it exists for.
test('incident 5e3c3a3c: passed followers land within the pass-to-land ceiling while the holder re-checks', async t => {
  const { followerPassToLand, overCeiling } = await import('./queue-sim/parked-incident.mjs');
  assert.match(
    await mutantChild(),
    /^ok \d+ - pre-N1 parked incident: every passed follower waits out the holder re-check, over the ceiling$/m,
  );
  const result = await followerPassToLand(t);
  assert.deepEqual(overCeiling(result), [], JSON.stringify(result.passToLand));
  assert(result.holderLanded, 'the holder lands after its re-check');
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
  const { waiterReclaimed } = await parkedIncident(t);
  assert(waiterReclaimed, 'a new holder generation leaves its oldest parked follower a fresh claim');
});

// L1 (Item 687d1eda, lead decision b5ad7376, option B): a parked waiter holds no timer, so idle
// costs nothing; every parked chain must end at an entry that owns progress (an armed alarm, a
// wake or a live check). After the 5e3c3a3c incident's new-run wake, the three followers still
// parked wait on the reclaimed oldest follower, the head of their chain, and its alarm covers them.
test('5e3c3a3c L1: every parked chain ends at a live entry; the chain head covers its parked followers', async t => {
  const { parkedIncident } = await import('./queue-sim/parked-incident.mjs');
  const { inspectQueue, requestRows, parkedChainEnd, armed, pendingClaim, liveCheck } =
    await import('./queue-sim/invariants.mjs');
  // While the head checks, every follower is parked behind the holder, itself parked behind the
  // head: each chain ends at the head, which owns its stall alarm.
  let mid = null;
  const {
    f,
    followers,
    head: first,
  } = await parkedIncident(t, {
    seed: async (f, { head }) => {
      const rows = requestRows(f),
        byId = new Map(rows.map(row => [row.submissionId, row]));
      mid = {
        ends: rows.filter(row => row.orderWait).map(row => parkedChainEnd(f, row, byId, null)),
        parkedTimers: rows.filter(row => row.orderWait && armed(f, row.alarm?.taskId)).length,
        headAlarm: armed(f, byId.get(head).alarm?.taskId),
        l1: (await inspectQueue(f)).filter(issue => issue.id === 'L1'),
      };
    },
  });
  assert.equal(mid.ends.length, 5, 'the holder and four followers are parked');
  assert(
    mid.ends.every(chain => chain.live && chain.end.submissionId === first),
    JSON.stringify(mid.ends),
  );
  assert.equal(mid.parkedTimers, 0, 'no parked waiter holds a timer');
  assert(mid.headAlarm, "the head's stall alarm is armed");
  assert.deepEqual(mid.l1, []);
  const rows = requestRows(f),
    byId = new Map(rows.map(row => [row.submissionId, row]));
  const parked = rows.filter(row => row.orderWait && !['landed', 'terminal-failed'].includes(row.phase));
  assert.deepEqual(
    parked.map(row => row.submissionId).sort(),
    followers.slice(1).sort(),
    'three followers stay parked',
  );
  const head = byId.get(followers[0]);
  for (const row of parked) {
    assert(!armed(f, row.alarm?.taskId), 'a parked waiter holds no timer (idle costs nothing)');
    assert(!pendingClaim(f, row.submissionId), 'and no wake of its own');
    const chain = parkedChainEnd(f, row, byId, null);
    assert.equal(chain.end.submissionId, head.submissionId, 'the chain ends at the reclaimed follower');
    assert(chain.live, JSON.stringify(chain));
  }
  assert(armed(f, head.alarm?.taskId), "the chain head's stall alarm is armed");
  assert.deepEqual(
    (await inspectQueue(f)).filter(issue => issue.id === 'L1'),
    [],
    'every parked chain ends at an entry with an armed alarm, a wake or a live check',
  );
  // Mutant: the chain head loses its alarm and its wake while its followers wait. With no driver
  // left, L1 names exactly the three parked followers.
  const finish = [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === head.submissionId);
  for (const taskId of [head.alarm.taskId, finish?.wake?.taskId].filter(Boolean))
    f.patch('_scheduled_functions', taskId, { state: { kind: 'canceled' } });
  assert(!pendingClaim(f, head.submissionId) && !liveCheck(f, head), 'no driver is left on the chain head');
  assert.deepEqual(
    (await inspectQueue(f))
      .filter(issue => issue.id === 'L1')
      .map(issue => issue.submission)
      .sort(),
    followers.slice(1).sort(),
  );
});

// L1 source mutants (review e7137e30 finding 4): each reviewed chain hand-off, on current code, ends
// every parked chain at a live entry; on its own pre-fix code (its CHAIN_MUTANTS entry, one
// uncompiled child per scenario) L1 names the stranded follower. Each must pass by name in its child.
test('687d1eda L1 source mutants: each finding-4 regression strands a follower that L1 names', async t => {
  const { CHAIN_MUTANTS, scenarios, allL1 } = await import('./queue-sim/chain-scenarios.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  assert.deepEqual(Object.keys(CHAIN_MUTANTS).sort(), Object.keys(scenarios).sort());
  for (const [name, scenario] of Object.entries(scenarios)) {
    const { f } = await scenario(t);
    assert.deepEqual(await allL1(f), [], `${name}: current code leaves no row without a live end`);
    const environment = {
      ...process.env,
      FORGE_TEST_SOURCE_PATCHES: JSON.stringify(CHAIN_MUTANTS[name]),
      FORGE_TEST_PRECOMPILED: '0',
      FORGE_CHAIN_SCENARIO: name,
    };
    delete environment.NODE_TEST_CONTEXT;
    const { code, stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        './tests/check-runtime.mjs',
        '--test',
        '--test-reporter=tap',
        'tests/queue-sim/chain-mutant-runner.mjs',
      ],
      { env: environment, maxBuffer: 4 * 1024 * 1024 },
    ).then(
      result => ({ code: 0, stdout: result.stdout }),
      error => ({ code: error.code, stdout: `${error.stdout}\n${error.stderr}` }),
    );
    assert.match(
      stdout,
      new RegExp(`^ok \\d+ - chain mutant ${name}: L1 names the stranded follower$`, 'm'),
      stdout.slice(-4000),
    );
    assert.equal(code, 0, `${name}: the mutant child exits cleanly\n${stdout.slice(-4000)}`);
  }
});

// Incident 43b51a5e case 3 (Guard 2): a reservation holder, an older Ready waiter on its reservation
// and an entry between them that waits for that waiter. No stored order-wait cycle (S6) at any step,
// and no landing waits for the reservation's time bound.
for (const variant of ['live', 'spent', 'overlap', 'budget', 'handed'])
  test(`43b51a5e reservation cycle (${variant}): no stored wait cycle, no wait for the time bound`, async t => {
    const shapes = await import('./queue-sim/reservation-cycle.mjs');
    const { inspectQueue } = await import('./queue-sim/invariants.mjs');
    const cycles = new Set();
    const run =
      variant === 'budget'
        ? shapes.reservationBudget
        : variant === 'handed'
          ? shapes.reservationHanded
          : shapes.reservationCycle;
    const r = await run(t, {
      variant,
      afterStep: async f => {
        for (const issue of await inspectQueue(f))
          if (issue.id === 'S6' && issue.detail.startsWith('cycle')) cycles.add(issue.submission);
      },
    });
    assert.deepEqual([...cycles], [], 'no stored order-wait cycle');
    assert(!r.expired, 'no landing waited for the reservation to end');
  });
