// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { overtakeOlder, overtakeMark, sealedOlder, unsealedBy } = await import(
  moduleUrl('../src/landing-overtake.ts')
);
const { recordOrderWait, HOSTED_ORDER_WAITS } = await import(
  moduleUrl('../convex/projectHostedLandingOrder.ts')
);
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-overtake',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const runOwner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;

test('overtakeOlder: once per entry, never a Ready or urgent one', () => {
  const target = { phase: 'checking', attemptId: 'a1', runId: 'r1', admitted: false };
  assert.equal(overtakeOlder(target), 'spend');
  assert.equal(
    overtakeOlder({ ...target, overtaken: overtakeMark(target) }),
    'free',
    'same stale generation',
  );
  assert.equal(
    overtakeOlder({ ...target, runId: 'r2', overtaken: overtakeMark(target) }),
    'hold',
    'its recheck',
  );
  assert.equal(
    overtakeOlder({ ...target, attemptId: 'a2', overtaken: overtakeMark(target) }),
    'hold',
    'a later attempt',
  );
  assert.equal(overtakeOlder({ ...target, phase: 'ready' }), 'hold', 'a passed entry about to land');
  assert.equal(overtakeOlder({ ...target, priority: 'urgent' }), 'hold');
  assert.equal(overtakeOlder({ ...target, phase: 'queued', runId: null }), 'free', 'no check of its own yet');
  assert.equal(
    overtakeOlder({ ...target, phase: 'queued', admitted: true }),
    'spend',
    'its Lane run goes stale',
  );
});

/** Core-claim incident 7d98c7da (dogfood, 2026-11-08, ~14 builders): passed landings
 * waited 17-40 min behind an older entry's recheck (receipts: order hold p90 21.9 min,
 * 29% of queue time), and when it landed most of them re-checked too. Replay with
 * pre-queue Lane checks and first-check proofs, as on the dogfood project: an older
 * change touching a global-risk file is re-checking in the queue (SLOW ticks) when N
 * newer, non-overlapping changes pass their Lane checks (FAST ticks). They must reach
 * main in about one FAST check plus bounded overhead, not after the older check (and a
 * recheck each). The older entry re-checks at most once more and that recheck holds
 * strict order. */
test('incident replay 7d98c7da: N parallel non-overlapping landings do not wait out an older check', async t => {
  const N = 8,
    LANE = 150,
    SLOW = 1000;
  // The first two add the same file with the same bytes: a clean composition, but not
  // path-disjoint, so whichever main moved under re-checks. The N newer touch other files.
  const memberPaths = [
    'src/shared.ts',
    'src/shared.ts',
    ...Array.from({ length: N }, (_, i) => `src/p${i}.ts`),
  ];
  const f = await batchesFixture(t, {
    batchMaxSize: null,
    admissionCheck: 'default',
    memberPaths,
    memberContents: ['shared', 'shared'],
    fileCount: 2,
    count: N + 2,
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  const ids = f.entries.map(e => e.state.id);
  const pair = ids.slice(0, 2),
    fast = ids.slice(2);
  const rows = () => [...f.tables.projectHostedLandingRequests.values()];
  const owner = run =>
    rows().find(r => r.admission?.runId === run.id || r.runId === run.id)?.submissionId ?? runOwner(f, run);
  const due = new Map(),
    landedAt = new Map(),
    runsOf = new Map(ids.map(id => [id, new Set()]));
  let overtookRecheck = false;
  // Of the first two, one lands on its Lane run at once; the other (whichever main
  // moved under) re-checks in the queue for SLOW ticks. The N
  // newer changes pass their Lane checks meanwhile, after LANE ticks.
  const slowOf = () => pair.find(id => runsOf.get(id).size > 1);
  for (let tick = 0; states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed'); tick++) {
    assert(tick < 20000, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    for (const run of f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit')) {
      const id = owner(run);
      runsOf.get(id)?.add(run.id);
      if (!due.has(run.id))
        due.set(run.id, tick + (fast.includes(id) ? LANE : runsOf.get(id).size > 1 ? SLOW : 0));
      if (due.get(run.id) <= tick) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    const task = f.pending().find(t => !/MainAudit:start|LandingStall/.test(t.name)) ?? null;
    if (!task) {
      if (f.runs().some(run => run.status === 'queued' && run.gate?.mode !== 'audit')) continue;
      break;
    }
    const before = new Set(
      states(f)
        .filter(s => s.phase === 'landed')
        .map(s => s.id),
    );
    await f.execute(task);
    for (const s of states(f))
      if (s.phase === 'landed' && !before.has(s.id)) {
        landedAt.set(s.id, tick);
        const slow = slowOf();
        if (slow && s.id !== slow && runsOf.get(slow).size > 2 && !landedAt.has(slow)) overtookRecheck = true;
      }
  }
  const slow = slowOf();
  assert(slow, 'one of the first two re-checked in the queue');
  const fastLanded = Math.max(...fast.map(id => landedAt.get(id) ?? Infinity));
  t.diagnostic(
    JSON.stringify({
      fastLandedByTick: fastLanded,
      slowLandedAt: landedAt.get(slow),
      slowRuns: runsOf.get(slow)?.size,
      fastRuns: fast.map(id => runsOf.get(id)?.size),
      firstCheck: f.reuseDecisions,
    }),
  );
  assert(
    states(f).every(s => s.phase === 'landed'),
    JSON.stringify(states(f).map(s => [s.sequence, s.phase])),
  );
  // Before the fix every newer landing waited for the older recheck (fastLanded > SLOW).
  assert(
    fastLanded < LANE + SLOW / 4,
    `newer landings reached main by tick ${fastLanded}, not after the older check`,
  );
  assert(fastLanded < landedAt.get(slow), 'the newer landings did not wait for the older one');
  for (const id of fast) assert.equal(runsOf.get(id)?.size, 1, 'each newer landing ran only its Lane check');
  // Lane check + queue recheck, + at most one more because newer landings overtook it
  // (none when its stale pass lands through the first-check proof).
  assert(
    runsOf.get(slow).size <= 3,
    `the older entry re-checks at most once more (${runsOf.get(slow).size} runs)`,
  );
  assert(!overtookRecheck, "the older entry's later recheck holds strict order");
});

test('sealedOlder: an independent older entry never holds, unless its pass cannot carry', () => {
  const target = { phase: 'checking', parked: false, combined: false, proofs: true };
  assert.equal(sealedOlder(target), true, 'checking, any generation');
  assert.equal(sealedOlder({ ...target, phase: 'queued' }), true);
  assert.equal(sealedOlder({ ...target, phase: 'ready', parked: true }), true, 'Ready but parked');
  assert.equal(sealedOlder({ ...target, phase: 'ready' }), false, 'a Ready entry about to land');
  assert.equal(sealedOlder({ ...target, priority: 'urgent' }), false);
  assert.equal(sealedOlder({ ...target, combined: true }), false, 'a combined group never carries');
  assert.equal(sealedOlder({ ...target, proofs: false }), false, 'policy keeps exact rechecks');
  assert.equal(sealedOlder({ ...target, unsealed: 'audit-debt' }), false, 'its pass cannot carry');
});

test('unsealedBy: only refusals no dependent change caused, and scoped re-checks, unseal', () => {
  for (const reason of [
    'path-overlap',
    'global-risk',
    'tested-doc',
    'composition-not-exact',
    'text-conflict',
  ])
    assert.equal(unsealedBy({ reason, scoped: false }), null, reason);
  for (const reason of ['audit-debt', 'checked-not-full', 'reuse-policy', 'source-unavailable', 'main-red'])
    assert.equal(unsealedBy({ reason, scoped: false }), reason, reason);
  assert.equal(unsealedBy({ reason: undefined, scoped: false }), 'not-eligible');
  assert.equal(unsealedBy({ reason: 'path-overlap', scoped: true }), 'scoped-recheck');
});

test('recordOrderWait: one row per new wait, bounded', () => {
  const wait = (id, held = 'dependent') => ({ row: { submissionId: id }, held, footprints: 'overlap' });
  let list = recordOrderWait(undefined, wait('a'));
  assert.deepEqual(list, [{ submissionId: 'a', held: 'dependent', footprints: 'overlap' }]);
  assert.equal(recordOrderWait(list, wait('a')), list, 'a repeat of the latest wait');
  list = recordOrderWait(list, wait('a', 'accepting'));
  assert.equal(list.length, 2);
  for (let i = 0; i < 20; i++) list = recordOrderWait(list, wait(`x${i}`));
  assert.equal(list.length, HOSTED_ORDER_WAITS);
});

const receipts = f =>
  [...f.tables.projectHostedAcceptances.values()]
    .map(r => JSON.parse(r.value))
    .sort((a, b) => a.snapshot.revision - b.snapshot.revision);

/** Drive a wave of pre-queue-checked landings to the end. `duration(index, nth)` is the ticks the
 * nth check of entry `index` takes; `pick` chooses which due task runs next (scheduling order is not
 * fixed in a real deployment). Returns landing ticks, run counts and receipts by entry. */
async function drive(t, { memberPaths, memberContents, duration, pick = tasks => tasks[0] }) {
  const f = await batchesFixture(t, {
    batchMaxSize: null,
    admissionCheck: 'default',
    memberPaths,
    memberContents,
    fileCount: 2,
    count: memberPaths.length,
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  const ids = f.entries.map(e => e.state.id);
  const rows = () => [...f.tables.projectHostedLandingRequests.values()];
  const runOwner = run =>
    [...f.tables.projectHostedLandingAttempts.values()].find(
      row => JSON.parse(row.value).check?.runId === run.id,
    )?.submissionId;
  const owner = run =>
    rows().find(r => r.admission?.runId === run.id || r.runId === run.id)?.submissionId ?? runOwner(run);
  const due = new Map(),
    landedAt = new Map(),
    runsOf = new Map(ids.map(id => [id, new Set()]));
  for (let tick = 0; states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed'); tick++) {
    assert(tick < 20000, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    for (const run of f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit')) {
      const id = owner(run);
      runsOf.get(id)?.add(run.id);
      if (!due.has(run.id)) due.set(run.id, tick + duration(ids.indexOf(id), runsOf.get(id)?.size ?? 1));
      if (due.get(run.id) <= tick) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    const tasks = f.pending().filter(t => !/MainAudit:start|LandingStall/.test(t.name));
    if (!tasks.length) {
      if (f.runs().some(run => run.status === 'queued' && run.gate?.mode !== 'audit')) continue;
      break;
    }
    const before = new Set(
      states(f)
        .filter(s => s.phase === 'landed')
        .map(s => s.id),
    );
    await f.execute(pick(tasks, ids));
    for (const s of states(f)) if (s.phase === 'landed' && !before.has(s.id)) landedAt.set(s.id, tick);
  }
  const byId = new Map(receipts(f).map(r => [r.submissionId, r]));
  const result = {
    ids,
    landedAt: ids.map(id => landedAt.get(id)),
    runs: ids.map(id => runsOf.get(id)?.size ?? 0),
    orderWaits: ids.map(id => byId.get(id)?.orderWaits ?? []),
  };
  t.diagnostic(JSON.stringify({ ...result, ids: undefined, firstCheck: f.reuseDecisions }));
  assert(
    states(f).every(s => s.phase === 'landed'),
    JSON.stringify(states(f).map(s => [s.sequence, s.phase])),
  );
  return result;
}
/** An entry's waits that are order holds against an independent entry. Waiting for an older passed
 * entry that is taking main (`accepting`) is the one acceptance slot, not order. */
const independentWaits = waits => waits.filter(w => w.footprints !== 'overlap' && w.held !== 'accepting');

const N = 6,
  O_LANE = 20,
  LANE = 300,
  SLOW = 1000;
/** Graph-sealed landing (D1, Issue c6b81429; core-claim 7d98c7da, dogfood 2026-11-08: a READY
 * entry held 4 passed landings behind an older entry that recomposed 3 times). An older change O
 * re-checks in the queue (SLOW ticks) after main moved under it. A passed change R depends on O,
 * so it parks behind O as a Ready entry. N newer changes independent of both then pass their Lane
 * checks. Before the fix they waited behind the parked Ready entry (a Ready entry was never
 * overtaken), so they waited out O's whole re-check (tick ~1180); graph-sealed order lets them take
 * main at once, and neither O nor R re-checks because of them. `pick` varies which due task runs
 * first among tasks due together. */
async function sealedReplay(t, { R_LANE, pick }) {
  const r = await drive(t, {
    memberPaths: [
      'src/shared.ts',
      ['src/shared.ts', 'src/o.ts'],
      'src/o.ts',
      ...Array.from({ length: N }, (_, i) => `src/p${i}.ts`),
    ],
    memberContents: ['shared', 'shared', 'shared'],
    duration: (i, nth) => (i === 0 ? 0 : nth > 1 ? SLOW : i === 1 ? O_LANE : i === 2 ? R_LANE : LANE),
    ...(pick ? { pick } : {}),
  });
  const [, older, dependent] = r.ids,
    fast = r.ids.slice(3);
  assert(r.runs[1] > 1, 'the older change re-checked in the queue');
  assert(r.landedAt[2] > r.landedAt[1], 'the dependent change landed after the one it depends on');
  const fastLanded = Math.max(...r.landedAt.slice(3));
  assert(fastLanded < LANE + SLOW / 4, `independent landings reached main by tick ${fastLanded}`);
  for (const i of fast.keys()) {
    assert.equal(r.runs[i + 3], 1, 'each independent landing ran only its Lane check');
    assert.deepEqual(independentWaits(r.orderWaits[i + 3]), [], 'no order wait against an independent entry');
    for (const w of r.orderWaits[i + 3].filter(w => w.held === 'accepting'))
      assert(fast.includes(w.submissionId), 'only behind another independent entry taking main');
  }
  // The older and dependent changes re-check only for each other, never for the independent ones.
  assert(r.runs[1] <= 3, `older runs ${r.runs[1]}`);
  assert(r.runs[2] <= 2, `dependent runs ${r.runs[2]}`);
  assert(
    r.orderWaits[2].some(
      w => w.submissionId === older && w.held === 'dependent' && w.footprints === 'overlap',
    ),
    JSON.stringify(r.orderWaits[2]),
  );
  void dependent;
}
test('incident replay c6b81429: independent landings never wait behind a dependent pair', t =>
  sealedReplay(t, { R_LANE: 150 }));
// Among tasks due at the same time, run the newest submission's first (scheduling order is free).
const newestFirst = (tasks, ids) => {
  const sub = task => ids.indexOf(JSON.stringify(task.args ?? null).match(/"submissionId":"([^"]+)"/)?.[1]);
  const due = tasks.filter(task => task.scheduledTime === tasks[0].scheduledTime);
  return due.reduce((a, b) => (sub(b) > sub(a) ? b : a));
};
test('incident replay c6b81429: same-tick passes, newest submission first', t =>
  sealedReplay(t, { R_LANE: LANE, pick: newestFirst }));

/** Guard for `accepting`: a passed entry R whose main moved stays Ready while its first-check proof
 * is analysed, so newer independent entries that pass then wait for it to take main. When the proof
 * is refused (R depends on the change that moved main) R re-checks, and those waits end with its
 * recompose: they never last R's re-check. */
test('c6b81429: an accepting wait ends when that entry re-checks instead', async t => {
  const r = await drive(t, {
    memberPaths: ['src/shared.ts', 'src/shared.ts', ...Array.from({ length: 3 }, (_, i) => `src/p${i}.ts`)],
    memberContents: ['shared', 'shared'],
    duration: (i, nth) => (i === 0 ? 0 : nth > 1 ? SLOW : i === 1 ? 150 : 152),
  });
  assert.equal(r.runs[1], 2, 'R re-checked for the change that moved main');
  const fastLanded = Math.max(...r.landedAt.slice(2));
  assert(fastLanded < 152 + SLOW / 4, `independent landings reached main by tick ${fastLanded}`);
  for (const waits of r.orderWaits.slice(2))
    assert.deepEqual(
      waits.filter(w => w.submissionId === r.ids[1]),
      waits.filter(w => w.submissionId === r.ids[1] && w.held === 'accepting'),
    );
});
