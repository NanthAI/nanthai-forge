// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { drive, overlapBase, overlapEdits } from './queue-sim/overtake-drive.mjs';
import { storageClock } from './storage-clock.mjs';
const { generationStartedAfterPass, overtakeOlder, overtakeMark, sealedOlder, unsealedBy, olderRiskOnly } =
  await import(moduleUrl('../src/landing-overtake.ts'));
const { PASS_HELD } = await import(moduleUrl('../src/landing-speed-alerts.ts'));
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

test('a spent hold only releases a real pass earlier than the holder’s generation', () => {
  for (const [passedAt, startedAt, releases] of [
    [undefined, 100, false],
    [PASS_HELD, 100, false],
    [100, 99, false],
    [100, 100, false],
    [100, 101, true],
    [100, NaN, false],
  ])
    assert.equal(generationStartedAfterPass(passedAt, startedAt), releases, `${passedAt} / ${startedAt}`);
});

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
  // Distinct, line-clean edits on a shared code path require a real recheck (identical bytes
  // carry the pass, Issue 1018d0f8). The N newer changes touch independent files.
  const memberPaths = [
    'src/shared.ts',
    'src/shared.ts',
    ...Array.from({ length: N }, (_, i) => `src/p${i}.ts`),
  ];
  const f = await batchesFixture(t, {
    batchMaxSize: null,
    admissionCheck: 'full',
    memberPaths,
    baselineFiles: [['src/shared.ts', overlapBase]],
    memberContents: overlapEdits,
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
    'order-sensitive',
    'coverage-landing',
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
  let list = recordOrderWait({}, wait('a'), 1_000);
  assert.deepEqual(list, [{ submissionId: 'a', held: 'dependent', footprints: 'overlap', at: 1_000 }]);
  assert.equal(
    recordOrderWait({ orderWait: 'a', orderWaits: list }, wait('a'), 2_000),
    list,
    'a repeat of the latest wait keeps its original start',
  );
  list = recordOrderWait({ orderWait: 'a', orderWaits: list }, wait('a', 'accepting'), 3_500);
  assert.equal(list.length, 2);
  assert.equal(list[0].seconds, 2.5);
  assert.equal(list[0].at, undefined);
  for (let i = 0; i < 20; i++)
    list = recordOrderWait(
      { orderWait: list.at(-1).submissionId, orderWaits: list },
      wait(`x${i}`),
      4_000 + i,
    );
  assert.equal(list.length, HOSTED_ORDER_WAITS);
});

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
    baselineFiles: [
      ['src/shared.ts', overlapBase],
      ['src/o.ts', overlapBase],
    ],
    memberContents: [overlapEdits[0], overlapEdits[1], overlapEdits[0]],
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
    baselineFiles: [['src/shared.ts', overlapBase]],
    memberContents: overlapEdits,
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

// Zoo timing incident 70a9bd2f: a build input and disjoint source arrive together.
// The required combined check must fit within 1.5 solo check durations.
// Flow's receipt sequence and its earlier landing bucket add 122 read B and 144 write B
// per pair (85f456c1). Keep this measured delta separate from other writers' exact bases.
// The byte fixtures below include run cause attribution on their existing
// dispatch and metrics rows. The two measured cases gained 220 read and 324 write bytes.
const canonicalReplayCost = ({ calls, readBytes, writeBytes, aliasWriteBytes }) => ({
  calls,
  readBytes: readBytes - 122,
  writeBytes: writeBytes - 144 - aliasWriteBytes,
});

test('incident replay 70a9bd2f: global-risk A/C overtake meets the unchanged 1.5x solo timing bar', async t => {
  storageClock(t, { elapsed: true });
  const CHECK = 1000;
  const solo = await drive(t, {
    memberPaths: ['src/feature.ts'],
    duration: () => CHECK,
  });
  const pairInput = {
    memberPaths: ['build.rs', 'src/feature.ts'],
    duration: (i, nth) => CHECK + (i === 1 && nth === 1 ? 20 : 0),
  };
  const before = await drive(t, { ...pairInput, unknownAdmissionRisk: true });
  const pair = await drive(t, pairInput);
  assert(before.landedAt[1] > 1.5 * solo.landedAt[0], 'the original path reproduces the miss');
  // Accepted pre-cancellation control: 121 calls, 1,822,710 read / 676,662 write B.
  // Early retirement now improves the unknown-risk arm too (102 calls), so it
  // no longer isolates the old path. Its ceiling held until the exact row below;
  // the live arm still guards latency, one exact check and zero idle work below.
  // DB reads 1,822,710 -> 1,896,315 (Item 9a04d916, compose settle; owner-approved +$0.02/1k): a settle mutation runs each finish wake with no
  // IO in flight, and an acceptance page it cannot hand out is stepped once more by its drive.
  // DB reads 1,896,315 -> 1,897,683 (Item 42200ce4, pass-to-land stamp): every landing row read after its first
  // pass now carries passedAt (about 17 B), the only state the queue health alarm needs. About 700 B per landing,
  // under $0.001 per 1,000 landings; no new call or write.
  // DB reads 1,897,683 -> 1,897,704 (Item 43b51a5e, queue-stall fix: handoff mark, own-risk flag and
  // reservation-cycle fields on landing rows): 21 B per pair, no new call or write.
  // DB reads 1,897,704 -> 1,900,085 (Item fa2c1383, keep the run: the check's kind recorded on the
  // landing row for admission and first checks too, the record the scoped-share measure reads):
  // `"checkKind":"full"` on every later row read, no new call or write, under $0.001 per 1,000 landings.
  // Exact on the fixed clock (Item fa2c1383 follow-up f): ISO stamps, scheduler time and measured
  // step durations (`callMs`, the old 20 B spread) are frozen, so the replay's cost is one number and a
  // drop fails too: ratchet it with the change that earned it. Source phase timing (e3082c24) adds
  // 381 read and 231 write bytes to both fixtures. On this clock the pair measures
  // 111 calls, 1,899,135 read / 606,570 write B (wall clock: 111 calls, about 1,900,046 / 607,524 B),
  // below the ceilings above (121 calls, 1,900,085 / 676,662 B), which this exact row replaces.
  // DB reads 1,899,135 -> 1,894,559 (Item 76be0714, public plan visibility): a query reads a document by id once and
  // hands each caller its own copy (convex/publicWorkReadContext.ts); no call or write changes.
  // Reads 1,894,559 -> 1,895,343 B, writes 606,570 -> 607,145 B (e62d834b, review 308f217c): each scheduled source
  // step arms a repair wake at its lease end that its commit cancels (a scheduler insert, a status read and a cancel);
  // no call, about 0.7 KB of DB I/O per landing.
  // Reads 1,895,343 -> 1,895,409 B, writes 607,145 -> 607,326 B (Item 85f456c1, Flow view): the line summary's Flow
  // day and the marks' check key ride writes that already happen; no call or write added, about 120 B per landing.
  // Reads 1,895,409 -> 1,895,434 B, writes 607,326 -> 607,376 B (Item 32e8de50, top bar first try): the Flow day's
  // `first` row rides the landing's summary write; no call or write added, about 25 B per landing.
  // Reads 1,895,434 -> 1,896,106 B, writes 607,376 -> 608,297 B (Item 85f456c1, In-queue writer and batch truth gap): the In-queue binding write (+1 write
  // per submitted Lane, owner-accepted) and the batch publish's line-summary update; no call, about 0.8 KB per landing.
  // Item 2c420916: +69 read and +69 write bytes for the two existing acceptance rows' health facts.
  // Item 0930a720: compose root prefetch removes two descriptor calls. The fixture reads 22,387 fewer bytes.
  // Item f65d8024 stages exact Lane identity and publishes two terminal feed rows in the
  // existing acceptance mutations. It reuses the loaded plan. Calls remain at 109.
  // Slice B adds 33 document bytes and 357 modeled index-key bytes per terminal
  // event (one per landing). This document-only cost row counts the 66 bytes.
  // Item 9064e885 adds 6,660 read and 1,091 write bytes for receipt pins and order evidence on rows already used.
  // Item ced8e98f adds 3,475 read and 1,758 write bytes for replay evidence on those existing writes.
  // Item 4e013cdb: audit cadence bookkeeping adds 20 write bytes on existing rows.
  // Item ced8e98f follow-up: replacement causes and the no-hold stamp add 218 write bytes there.
  // Item fc1831eb: the Lane overlap row carries `saves` (and presence the copy) for Loose ends: +110 read and +100 write
  // bytes for the pair on rows already read and written; no call, no row.
  // Item 8c50ce13: messages are always stored once and referenced, so the pair's two receipts and
  // events name their bodies: 34 fewer read and 68 fewer write bytes, with unchanged calls.
  // Item 5b4b5918: the queue judges a bound admission proof in the tick that binds it, so the
  // second claim and advance go: 109 -> 107 calls, 63,309 fewer read and 20,920 fewer write bytes.
  // Item fc1831eb: the pair's two Intents carry no Item marker, so the legacy no-Item landing notes are gone: 874 fewer
  // write bytes, with unchanged calls and reads.
  // Item ced8e98f (recheck none): the causes stamp on existing replay writes adds 1,051 read and
  // 346 write bytes, with unchanged calls.
  // Item c6615b66 (automatic enrolment): each Lane's coordination session row is written at its presence insert and
  // removed at close, inside those mutations: +1,339 read and +1,870 write bytes for the pair, with unchanged calls.
  // Item 411727ba: source resolve reuses the project row its step fence read (one project read fewer per
  // resolve call): 2,088 fewer read bytes for the pair, with unchanged calls and writes.
  // Item 411727ba (bucketed overlap changes): each Lane's saved list is a bucket row beside a slim overlap row: +286 read
  // and +182 write bytes for the pair, with unchanged calls.
  // Item 3c01e736: the compose state stores its compact server steps: +714 read and +238 write bytes for the pair
  // (and at 4,000 files), with unchanged calls.
  // Item 8b7ab7a9: the cold metadata pair shares one upload drive and callback.
  // Four fewer calls, 123,394 fewer read bytes and 26,132 fewer write bytes.
  // Item 1018d0f8: the request rows' discarded run count (`runs` and short run keys) adds 3,699 read and 491
  // write bytes for the pair, with unchanged calls.
  const measured = canonicalReplayCost(pair);
  assert.deepEqual(
    measured,
    { calls: 103, readBytes: 1_703_538, writeBytes: 568_541 },
    'the 70a9bd2f pair cost moved; ratchet this row to the measured cost, with the reason',
  );
  assert.equal(pair.idle, 0, 'the settled pair has no idle queue work');
  assert.equal(pair.runs[0], 1);
  assert.equal(pair.runs[1], 1, 'C runs the exact combined tree instead of a wasted solo admission');
  assert(
    pair.landedAt[1] <= 1.5 * solo.landedAt[0],
    `C reached main at ${pair.landedAt[1]} ticks; solo ${solo.landedAt[0]}, bar ${1.5 * solo.landedAt[0]}`,
  );
});

test('70a9bd2f: admission pipeline calls and metadata bytes stay bounded at 4000 source files', async t => {
  storageClock(t, { elapsed: true });
  const input = {
    memberPaths: ['build.rs', 'src/feature.ts'],
    baselineFiles: Array.from({ length: 4000 }, (_, i) => [
      `lib/file-${i}.ts`,
      `export const value = ${i};\n`,
    ]),
    duration: (i, nth) => 1000 + (i === 1 && nth === 1 ? 20 : 0),
  };
  await drive(t, { ...input, unknownAdmissionRisk: true });
  const after = await drive(t, input);
  assert(after.landedAt[1] <= 1500, 'one check duration plus bounded source/queue progress');
  assert.deepEqual(after.runs, [1, 1]);
  // Same pre-cancellation control ceiling as the small replay, measured at 4000
  // files. The live unknown-risk arm now benefits from early retirement too.
  // DB reads 1,827,467 -> 1,901,561 (Item 9a04d916, compose settle; owner-approved +$0.02/1k), as in the small replay.
  // DB reads 1,901,561 -> 1,902,948 (Item 42200ce4, pass-to-land stamp on landing rows), as in the small replay.
  // DB reads 1,902,948 -> 1,902,970 (Item 43b51a5e, queue-stall fix), as in the small replay.
  // DB reads 1,902,970 -> 1,905,313 (Item fa2c1383, recorded check kind), as in the small replay.
  // Exact on the fixed clock, as in the small replay (ceilings 121 calls, 1,905,313 / 679,017 B; wall
  // clock about 1,905,292 / 610,020 B).
  // DB reads 1,904,377 -> 1,899,801 (Item 76be0714, one get per document per query), as in the small replay.
  // Reads 1,899,801 -> 1,900,595 B, writes 609,061 -> 609,641 B (e62d834b, review 308f217c): the source repair
  // wake, as in the small replay; no call.
  // Reads 1,900,595 -> 1,900,661 B, writes 609,641 -> 609,822 B (Item 85f456c1): the Flow fields, as in the small
  // replay; no call.
  // Reads 1,900,661 -> 1,900,686 B, writes 609,822 -> 609,872 B (Item 32e8de50): the `first` row, as in the small
  // replay; no call.
  // Reads 1,900,686 -> 1,901,360 B, writes 609,872 -> 610,798 B (Item 85f456c1, In-queue writer and batch truth gap): the In-queue binding write, as in the
  // small replay; no call.
  // Item 2c420916: +69 read and +69 write bytes, matching the small replay.
  // Item 0930a720: compose root prefetch removes two descriptor calls. The fixture reads 22,433 fewer bytes.
  // Item f65d8024: the bounded two-Lane feed projection adds the same 640 read bytes here.
  // Slice B adds the same 66 document bytes for the pair, excluding the modeled index keys.
  // Item 9064e885 adds the same 6,660 read and 1,091 write bytes at 4,000 files.
  // Item ced8e98f adds the same 3,475 read and 1,758 write bytes at 4,000 files.
  // Item 4e013cdb: the same 20 write bytes at 4,000 files, with unchanged calls and reads.
  // Item ced8e98f follow-up: the same 218 write bytes for replacement causes and the no-hold stamp.
  // Item fc1831eb: the same +110 read and +100 write bytes for the pair's `saves` fields.
  // Item 8c50ce13: the same 34 fewer read and 68 fewer write bytes from stored messages.
  // Item 5b4b5918: one queue tick fewer per bound admission proof: 2 fewer calls, 63,480 fewer
  // read and 21,001 fewer write bytes at 4,000 files.
  // Item fc1831eb: the same legacy no-Item notes gone at 4,000 files: 878 fewer write bytes.
  // Item ced8e98f (recheck none): the same 1,051 read and 346 write bytes at 4,000 files.
  // Item c6615b66: the pair's coordination session rows, as in the small replay: +1,159 read and +1,727 write bytes.
  // Item 411727ba: the same resolve project-row reuse at 4,000 files: 2,088 fewer read bytes.
  // Item 411727ba (bucketed overlap changes): the same +286 read and +182 write bytes at 4,000 files.
  // Item 8b7ab7a9: the grouped upload still removes four calls at 4,000 files,
  // with 123,656 fewer read bytes and 26,216 fewer write bytes.
  // Item 1018d0f8: the same discarded run count adds 3,699 read and 491 write bytes at 4,000 files.
  const measured = canonicalReplayCost(after);
  assert.deepEqual(
    measured,
    { calls: 103, readBytes: 1_708_133, writeBytes: 570_734 },
    'the 70a9bd2f 4,000-file cost moved; ratchet this row to the measured cost, with the reason',
  );
  assert.equal(after.idle, 0);
});

test('70a9bd2f: a follower that finishes before its predecessor keeps the exact combined pass', async t => {
  const solo = await drive(t, { memberPaths: ['src/feature.ts'], duration: () => 1000 });
  const pair = await drive(t, {
    memberPaths: ['build.rs', 'src/feature.ts'],
    duration: i => (i === 0 ? 1020 : 1000),
  });
  assert.deepEqual(pair.runs, [1, 1]);
  assert(pair.landedAt[1] > pair.landedAt[0], 'A is the accepted predecessor even when C finishes first');
  assert(pair.landedAt[1] <= solo.landedAt[0] * 1.5);
  assert.equal(pair.idle, 0);
});

test("olderRiskOnly: only the older side's own global risk links two disjoint changes", () => {
  const mine = ['src/a.ts'];
  for (const theirs of [
    ['convex/schema.ts'],
    ['.github/workflows/forge-check.yml', 'src/b.ts'],
    ['build.rs'],
  ])
    assert.equal(olderRiskOnly(mine, theirs, []), true, theirs.join());
  assert.equal(olderRiskOnly(mine, ['ci/check.sh'], ['ci/check.sh']), true, 'a check entry');
  assert.equal(olderRiskOnly(mine, ['src/b.ts'], []), false, 'no risk: unrelatedChanges decides');
  assert.equal(
    olderRiskOnly(['package.json'], ['convex/schema.ts'], []),
    false,
    'the passed side is risky too',
  );
  assert.equal(olderRiskOnly(['ci/check.sh'], ['convex/schema.ts'], ['ci/check.sh']), false);
  assert.equal(olderRiskOnly(['src/a.ts'], ['src/a.ts', 'convex/schema.ts'], []), false, 'overlapping paths');
  assert.equal(olderRiskOnly(['src'], ['src/a.ts', 'convex/schema.ts'], []), false, 'a containing path');
  assert.equal(
    olderRiskOnly(['db/migrate/2_b.rb'], ['db/migrate/2_a.rb', 'convex/schema.ts'], []),
    false,
    'a sequence folder both changed',
  );
  assert.equal(olderRiskOnly(null, ['convex/schema.ts'], []), false, 'unknown paths');
  assert.equal(olderRiskOnly(mine, null, []), false, 'unknown paths');
  assert.equal(olderRiskOnly(mine, [], []), false);
});

/** Core-claim incident 43b51a5e (dogfood 2026-11-19 15:03-16:28Z): an older entry that changed one
 * global-risk file was checking in the queue, and every newer passed landing waited behind it as
 * `dependent` (disjoint paths; only the older side's own risk linked them): 9 passed landings waited
 * up to 80 min, and the older entry re-checked on every main move. Replay on the dogfood queue shape
 * (each agent's check starts at submission): entry 0 lands at once and moves main; the older entry O
 * checks for SLOW ticks; 9 newer changes with disjoint paths pass after RISK_LANE ticks. They take
 * main without a dependent hold, and O re-checks at most once more for them. The project lets agents
 * change workflow files without review (an explicit protected-path list), as on the dogfood project. */
const RISK_N = 9,
  RISK_LANE = 150;
async function riskOnlyReplay(t, olderPath) {
  const r = await drive(t, {
    memberPaths: ['src/first.ts', olderPath, ...Array.from({ length: RISK_N }, (_, i) => `src/r${i}.ts`)],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: { admissionCheck: false, requestCheck: true, batching: false },
    duration: i => (i === 0 ? 0 : i === 1 ? SLOW : RISK_LANE),
  });
  const older = r.ids[1];
  const readyLanded = Math.max(...r.landedAt.slice(2));
  assert(readyLanded < RISK_LANE + SLOW / 4, `the passed landings reached main by tick ${readyLanded}`);
  for (const [i, waits] of r.orderWaits.slice(2).entries())
    assert.deepEqual(
      waits.filter(w => w.submissionId === older && w.held === 'dependent'),
      [],
      `entry ${i + 2} never waits as dependent on the older entry`,
    );
  for (const [i, runs] of r.runs.slice(2).entries())
    assert.equal(runs, 1, `entry ${i + 2} ran only its own check`);
  // Its own check, plus at most one more because the passed ones took main.
  assert(r.runs[1] <= 2, `the older entry re-checks at most once (${r.runs[1]} runs)`);
  assert.equal(r.idle, 0, 'the drained queue has no idle work');
  return r;
}
test('incident replay 43b51a5e: an older workflow-only check never holds 9 passed landings', async t => {
  const r = await riskOnlyReplay(t, '.github/workflows/contracts-nightly.yml');
  // Measured on this replay before the fix (9 dependent holds, 9 re-checks): fewer calls now.
  const baseline = { calls: 695 };
  assert(r.calls <= baseline.calls, `Convex transactions ${baseline.calls} -> ${r.calls}`);
});
test('43b51a5e: an older entry linked only by its own global risk is overtaken once, not a dependent hold', async t => {
  const r = await riskOnlyReplay(t, 'convex/schema.ts');
  assert.equal(r.runs[1], 2, 'the older entry was overtaken once and re-checked once');
  const baseline = { calls: 695 };
  assert(r.calls <= baseline.calls, `Convex transactions ${baseline.calls} -> ${r.calls}`);
});
