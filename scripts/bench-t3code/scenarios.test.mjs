// SPDX-License-Identifier: Apache-2.0
// Local synthetic checks of the scripted queue scenarios; no bench, service or Git call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENARIOS,
  scenarioRole,
  scenarioTest,
  docEdit,
  landingReading,
  withdrawBody,
} from './scenarios.mjs';
import { driveForge } from './forge-protocol.mjs';
import { summarizeCell, passToLand } from './scenario-report.mjs';
import { switchProblems } from './switches.mjs';
import { pathEvidence, cellLandings } from './path-evidence.mjs';
import { scenarioEvidence as evidenceOf } from './scenario-evidence.mjs';
import { SHARED_SOURCE, TEST_DIR, SOURCE_MARKER, failureReading } from './scenarios.mjs';
import { mkdtempSync, writeFileSync as writeFile, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

test('smoke keeps the unchanged dry run: no role at any position', () => {
  for (let i = 0; i < 10; i++) assert.deepEqual(scenarioRole('smoke', i), {});
});

test('every scenario names the switch paths it exercises and is the same in every arm', () => {
  for (const [name, s] of Object.entries(SCENARIOS)) {
    assert.ok(Array.isArray(s.paths) && s.about, name);
    const roles = Array.from({ length: 10 }, (_, i) => scenarioRole(name, i));
    assert.deepEqual(
      roles,
      Array.from({ length: 10 }, (_, i) => scenarioRole(name, i)),
    );
    assert.ok(!JSON.stringify(roles).includes('FORGE_'), 'no role depends on a switch');
  }
  assert.deepEqual(scenarioRole('main-move', 3), { releaseMs: 60_000 });
  assert.equal(scenarioRole('parked-head', 0).slowSeconds, 240);
  assert.equal(scenarioRole('parked-head', 5).releaseMs, 20_000);
  // v2: the holder edits the other end of the head's source file (code overlap, clean merge).
  const [head, holder] = [0, 1].map(i => scenarioRole('parked-head', i));
  assert.equal(head.doc.path, holder.doc.path);
  assert.match(head.doc.path, /\.ts$/);
  assert.deepEqual([head.doc.at, holder.doc.at, holder.group], ['top', 'bottom', '']);
  assert.throws(() => scenarioRole('nope', 0), /unknown scenario/);
});

test('scenario files: a failing test, its fix, a slow test, and far-apart same-file edits', () => {
  assert.match(scenarioTest('t1', 'fail'), /toBe\("fixed"\)/);
  assert.match(scenarioTest('t1', 'fail'), /"fails once"/);
  assert.doesNotMatch(scenarioTest('t1', 'fixed'), /fails once/);
  assert.match(scenarioTest('t1', 'slow', 240), /240000/);
  // Failure and slowness show only in the hosted landing check, never in the local preflight.
  for (const kind of ['fail', 'slow'])
    assert.match(scenarioTest('t1', kind, 240), /process\.env\.CI === "true" \?/);
  const text = 'a\nb\n';
  assert.equal(docEdit(text, 't1', 'top'), '<!-- bench scenario t1 -->\n\na\nb\n');
  assert.equal(docEdit(text, 't2', 'bottom'), 'a\nb\n<!-- bench scenario t2 -->\n');
  assert.equal(docEdit(text, 't1', 'top', 'src/a.ts'), '// bench scenario t1\na\nb\n');
  assert.equal(docEdit('a', 't2', 'bottom', 'src/a.ts'), 'a\n// bench scenario t2\n');
});

test('a failed check calls the scenario fix once, then lands again', async () => {
  const replies = [
    { error: { code: 'CHECK_FAILED', message: 'check failed' } },
    { result: { submission: { phase: 'landed' } } },
  ];
  const calls = [];
  let fixes = 0;
  const result = await driveForge({
    root: '/tmp/lane',
    laneId: 'lane',
    message: 'dry',
    call: async command => (calls.push(command), replies.shift()),
    pause: async () => {},
    onFailure: async () => (++fixes, fixes === 1),
  });
  assert.equal(fixes, 1);
  assert.equal(result.landAttempts, 2);
  assert.deepEqual(
    calls.map(c => [c.action, c.flags]),
    [
      ['land', ['--save']],
      ['land', ['--save']],
    ],
  );
});

test('without a scenario hook a failed check stays a product failure (smoke unchanged)', async () => {
  await assert.rejects(
    driveForge({
      root: '/tmp/lane',
      laneId: 'lane',
      message: 'dry',
      call: async () => ({ error: { code: 'CHECK_FAILED', message: 'check failed' } }),
      pause: async () => {},
    }),
    /BENCH_PRODUCT_FRICTION/,
  );
});

test('report joins only the cell receipts and reads pass-to-land from the first passed check', () => {
  const receipt = (laneId, from, committedAt, extra = {}) => ({
    laneId,
    committedAt,
    heldAfterCheck: [{ from, to: committedAt }],
    recomposeCount: 1,
    costs: { attempts: 2, runnerAccepted: 10, runnerDiscarded: 5 },
    ...extra,
  });
  assert.equal(passToLand(receipt('a', '2026-01-01T00:00:00Z', '2026-01-01T00:01:40Z')), 100);
  const row = summarizeCell(
    {
      cellId: 'c',
      landed: 2,
      scenario: { name: 'cohort-fail' },
      switches: { start: { X: true } },
      records: [{ laneId: 'a' }, { laneId: 'b' }],
      convex: { projectExecutions: 40, costUsd: 0.01 },
    },
    [
      receipt('a', '2026-01-01T00:00:00Z', '2026-01-01T00:01:40Z'),
      receipt('b', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z'),
      receipt('other', '2026-01-01T00:00:00Z', '2026-01-01T09:00:00Z'),
    ],
  );
  assert.equal(row.receipts, 2);
  assert.equal(row.passToLandP50, 200);
  assert.equal(row.attemptsPerLanding, 2);
  assert.equal(row.recompositions, 2);
  assert.equal(row.wastePercent, (100 * 10) / 30);
  assert.equal(row.convexUsdPer1000, 5);
  assert.deepEqual(row.switches, { X: true });
});

test('a switch that is unreadable or changes during a cell voids it', () => {
  assert.deepEqual(switchProblems({ A: true }, { A: true }), []);
  assert.deepEqual(switchProblems({ A: true }, { A: false }), ['switch A changed during cell']);
  assert.deepEqual(switchProblems({ A: null }, { A: true }), ['switch A unreadable']);
});

test('the withdraw role waits for a running check and withdraws by submissionId when it has one', () => {
  const reply = (phase, timing = {}) => ({ result: { submission: { id: 's1', phase, timing } } });
  assert.deepEqual(landingReading(reply('queued')), { submissionId: 's1', running: false, over: false });
  assert.equal(landingReading(reply('checking')).running, true);
  assert.equal(landingReading(reply('queued', { checkReservedAt: 'x' })).running, true);
  assert.equal(landingReading(reply('queued', { checkReservedAt: 'x', ciEndedAt: 'y' })).running, false);
  assert.equal(landingReading(reply('landed')).over, true);
  assert.equal(
    landingReading({ result: { submissions: [{ submission: { id: 's2', phase: 'checking' } }] } })
      .submissionId,
    's2',
  );
  assert.deepEqual(landingReading({ error: { code: 'X' } }), {
    submissionId: null,
    running: false,
    over: false,
  });
  // 2026-11-18 cell forge-n10-r1-withdraw-join-dry-a1-20261118T123218: the CLI refused
  // { submissionId, reason } with BAD_ARGUMENT ("reason is recorded only for a withdraw by Lane").
  assert.deepEqual(withdrawBody('lane', 's1', 'r'), { submissionId: 's1' });
  assert.deepEqual(withdrawBody('lane', null, 'r'), { laneId: 'lane', reason: 'r' });
});

test('a real checking landing reply starts the withdraw; the old status trigger never matched it', async () => {
  const { landingReading: read } = await import('./scenarios.mjs');
  // Shape of `landing {operationId}` while the check runs: no runId field anywhere.
  const reply = {
    result: {
      submission: { id: 's1', phase: 'checking', timing: { submittedAt: 'a', checkReservedAt: 'b' } },
    },
  };
  const text = JSON.stringify(reply.result);
  const oldTrigger = /"phase":"checking"/.test(text) && /"runId":"[^"]+"/.test(text);
  assert.equal(oldTrigger, false, 'the old trigger waited for a field the reply never has');
  assert.equal(read(reply).running, true);
});

test('scenario evidence voids a cell whose role did not fire and records group arrival order', async () => {
  const { scenarioEvidence, scenarioEvents } = await import('./scenario-evidence.mjs');
  const at = s =>
    `2026-01-01T00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
  const land = (task, s, verb = 'agent land --detail --save') => ({ task, verb, startedAt: at(s) });
  const records = [
    { task: 'w', dispatchedAt: at(0), changes: { files: [] } },
    { task: 'f', dispatchedAt: at(0), changes: { files: [] } },
    { task: 's', dispatchedAt: at(0), changes: { files: [{ path: 'README.md' }] } },
    { task: 'late', dispatchedAt: at(0), changes: { files: [] } },
  ];
  const roles = [
    { task: 'w', role: { withdrawOnce: true }, group: 'g' },
    { task: 'f', role: { failOnce: true }, group: 'g' },
    { task: 's', role: { slowSeconds: 240, doc: { path: 'README.md', at: 'top' } }, group: '' },
    { task: 'late', role: { releaseMs: 90_000 }, group: '' },
  ];
  const calls = [
    land('f', 3),
    land('w', 5),
    land('w', 700, 'agent land --detail --withdraw'),
    land('s', 1),
    land('late', 92),
  ];
  const events = line =>
    scenarioEvents(line.map(e => JSON.stringify({ event: 'scenario', ...e })).concat(['not json']));
  // The cells of 2026-11-18: withdraw refused, no failed check, short checks only.
  const bad = scenarioEvidence({
    roles,
    records,
    calls,
    jobs: [{ conclusion: 'success', startedAt: at(0), completedAt: at(150) }],
    events: { w: events([{ step: 'withdrawn', error: 'LANDING_NOT_LIVE' }]) },
  });
  assert.deepEqual(
    bad.problems.map(p => p.split(' (')[0]),
    [
      'scenario role did not fire: withdraw on w',
      'scenario role did not fire: fail-once on f',
      'scenario role did not fire: slow-check on s',
    ],
  );
  assert.deepEqual(bad.groupOrder, { g: ['f', 'w'] });
  const good = scenarioEvidence({
    roles,
    records,
    calls,
    jobs: [{ conclusion: 'success', startedAt: at(0), completedAt: at(400) }],
    events: {
      w: events([{ step: 'withdrawn', error: null }]),
      f: events([{ step: 'fix-after-failed-check', code: 'CHECK_FAILED', admission: false }]),
    },
  });
  assert.deepEqual(good.problems, []);
  assert.equal(good.roles.length, 5);
  const early = scenarioEvidence({ roles: [roles[3]], records, calls: [land('late', 10)], events: {} });
  assert.match(early.problems[0], /release on late/);
});

// The parked-head cell with N1 on (2026-11-18, receipts trimmed to the fields the check reads):
// every landing batched or solo on one run, nobody held after its check. N1's path was not
// reached, so the cell must not count as on-path evidence.
const parkedHeadV1 = [
  ['98cad0e9', '11:28:55', null, false],
  ['1ec9d4ef', '11:29:12', 'ec46bf64'],
  ['25b86d7f', '11:30:46', '29f8ae2d'],
  ['fb21db0b', '11:30:46', '29f8ae2d'],
  ['5e6b5d62', '11:30:46', '29f8ae2d'],
  ['2e871a46', '11:32:03', '24eb607a'],
  ['e0dd2aef', '11:32:03', '24eb607a'],
  ['54d741a8', '11:32:10', '7a785cb2'],
  ['842406c2', '11:35:10', '4cab745e'],
  ['2c1aac78', '11:38:38', 'a722887b'],
].map(([submissionId, at, batchId, mainMoved = true]) => ({
  submissionId,
  committedAt: `2026-11-18T${at}Z`,
  checkRunIds: [`run-${batchId ?? submissionId}`],
  heldAfterCheck: [],
  orderWaits: null,
  admittedAt: null,
  batchId,
  sharedBatch: null,
  mainMoved,
  firstCheck: null,
  costs: { runnerDiscarded: 0 },
}));
const allOn = {
  FORGE_QUEUE_NEW_RUN_WAKE: true,
  FORGE_QUEUE_COHORT_KEEP_HEALTHY: true,
  FORGE_QUEUE_CANCEL_HONOURS_FAST: true,
};

test('the parked-head v1 cell did not reach any switch path: switch-on means path not reached', () => {
  const paths = pathEvidence(parkedHeadV1, { FORGE_QUEUE_NEW_RUN_WAKE: true });
  assert.equal(paths.N1.label, 'path not reached');
  assert.equal(paths.N1.precondition, false);
  assert.equal(paths.O3.label, null, 'a switch that is off gets no label');
  for (const rule of ['N1', 'O3', 'O4'])
    assert.equal(pathEvidence(parkedHeadV1, allOn)[rule].label, 'path not reached', rule);
});

test('N1 is reached only when a held, passed follower overtakes a holder that checks again', () => {
  const holder = { submissionId: 'h', committedAt: '2026-01-01T00:10:00Z', checkRunIds: ['r1', 'r2'] };
  const follower = at => ({
    submissionId: 'f',
    committedAt: at,
    checkRunIds: ['r3'],
    heldAfterCheck: [{ from: '2026-01-01T00:04:00Z', to: at }],
    orderWaits: [{ submissionId: 'h', held: 'accepting', footprints: 'disjoint' }],
  });
  const woken = pathEvidence([holder, follower('2026-01-01T00:06:00Z')], allOn).N1;
  assert.deepEqual([woken.precondition, woken.reached, woken.label], [true, true, 'on path']);
  const waited = pathEvidence([holder, follower('2026-01-01T00:11:00Z')], {}).N1;
  assert.deepEqual([waited.precondition, waited.reached, waited.label], [true, false, null]);
  const overlap = follower('2026-01-01T00:06:00Z');
  overlap.orderWaits[0].footprints = 'overlap';
  assert.equal(pathEvidence([holder, overlap], allOn).N1.precondition, false, 'overlap is not N1');
  assert.equal(
    pathEvidence([{ ...holder, checkRunIds: ['r1'] }, follower('2026-01-01T00:06:00Z')], allOn).N1
      .precondition,
    false,
    'a holder that never checked again is not N1',
  );
});

test('O3 keeps an admitted healthy member of a failed shared check', () => {
  const member = (runs, extra = {}) => ({
    submissionId: 'm',
    admittedAt: '2026-01-01T00:01:00Z',
    sharedBatch: { runId: 'shared', individualPassed: true, likelyCulprit: false },
    checkRunIds: runs,
    batchId: 'b',
    ...extra,
  });
  assert.equal(pathEvidence([member(['shared'])], allOn).O3.label, 'on path');
  const rechecked = pathEvidence([member(['shared', 'solo'])], allOn).O3;
  assert.deepEqual([rechecked.precondition, rechecked.label], [true, 'path not reached']);
  assert.equal(
    pathEvidence([member(['shared'], { sharedBatch: { runId: 'shared', likelyCulprit: true } })], allOn).O3
      .precondition,
    false,
    'the likely culprit is not a healthy member',
  );
  // O4 needs run windows and own files: see the O4 test below.
  assert.equal(pathEvidence([member(['shared'])], allOn).O4.precondition, false);
});

// (a) O4. The A' smoke cell (2026-11-18, dogfood policy, switches off): every landing landed on
// its admission run or on a queue check no overlapping landing committed under. The 70c7347c
// rule read "main moved + first check" as O4 reached.
test('O4 is reached only by a solo queue check still running when an overlapping landing committed', () => {
  const t = s =>
    `2026-11-18T14:00:00.000Z`.replace(
      '00:00.000',
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000`,
    );
  const receipt = (laneId, extra) => ({
    laneId,
    receiptId: `r-${laneId}`,
    batchId: null,
    checkRunIds: ['run'],
    costs: { runnerDiscarded: 0 },
    mainMoved: true,
    ...extra,
  });
  const smoke = [
    receipt('a', {
      committedAt: t(247),
      admissionBase: { receiptId: 'pre' },
      firstCheck: { landedOn: 'admission-run', mainMoved: true, rule: 'clean-disjoint-v2' },
    }),
    receipt('b', { committedAt: t(529), admissionBase: { receiptId: 'r-a' }, firstCheck: null }),
    receipt('c', {
      committedAt: t(620),
      admissionBase: { receiptId: 'r-a' },
      firstCheck: { landedOn: 'admission-run', mainMoved: true, rule: 'clean-disjoint-v2' },
    }),
  ];
  const cell = {
    files: new Map([
      ['a', new Set(['g.md'])],
      ['b', new Set(['g.md'])],
      ['c', new Set(['g.md'])],
    ]),
    windows: new Map([
      ['a', [[Date.parse(t(41)), Date.parse(t(213))]]],
      ['b', [[Date.parse(t(324)), Date.parse(t(495))]]],
      ['c', [[Date.parse(t(454)), Date.parse(t(584))]]],
    ]),
  };
  const fp = pathEvidence(smoke, { FORGE_QUEUE_CANCEL_HONOURS_FAST: true }, cell).O4;
  assert.deepEqual([fp.precondition, fp.reached, fp.label], [false, false, 'path not reached']);
  // b's queue check runs 324-495 s; an overlapping landing commits at 400 s, after b's base.
  const under = receipt('d', { committedAt: t(400), admissionBase: { receiptId: 'pre' }, firstCheck: null });
  cell.files.set('d', new Set(['g.md']));
  const kept = pathEvidence([...smoke, under], { FORGE_QUEUE_CANCEL_HONOURS_FAST: true }, cell).O4;
  assert.deepEqual([kept.precondition, kept.reached, kept.label], [true, true, 'on path']);
  // Disjoint files, or a landing already in b's base, is not a main move under it.
  cell.files.set('d', new Set(['other.md']));
  assert.equal(pathEvidence([...smoke, under], {}, cell).O4.precondition, false);
  cell.files.set('d', new Set(['g.md']));
  const inBase = smoke.map(r => (r.laneId === 'b' ? { ...r, admissionBase: { receiptId: 'r-d' } } : r));
  assert.equal(pathEvidence([...inBase, under], {}, cell).O4.precondition, false);
  // Switch off: the sweep retired b's run (another run, runner time discarded).
  const retired = smoke.map(r =>
    r.laneId === 'b'
      ? { ...r, checkRunIds: ['run', 'run2'], costs: { runnerDiscarded: 2 }, firstComposeStartedAt: t(300) }
      : r,
  );
  const off = pathEvidence([...retired, under], {}, cell).O4;
  assert.deepEqual([off.precondition, off.reached, off.label], [true, false, null]);
});

test("cellLandings keeps only a Lane's own files, never paths it synced from main", () => {
  const result = {
    order: ['t1', 't2'],
    records: [
      {
        task: 't1',
        laneId: 'l1',
        overlap: 'same-file:x',
        changes: { files: [{ path: '.bench/dry/t2.md' }] },
        landing: {
          operations: [
            { timing: { checkReservedAt: '2026-01-01T00:00:10Z', ciEndedAt: '2026-01-01T00:01:00Z' } },
          ],
        },
      },
      { task: 't2', laneId: 'l2', overlap: 'disjoint:y' },
    ],
  };
  const cell = cellLandings(result, {
    roleOf: i => (i === 0 ? { doc: { path: 'README.md', at: 'top' } } : {}),
    groupOf: r => (r.overlap.startsWith('disjoint') ? '' : 'x'),
  });
  assert.deepEqual([...cell.files.get('l1')], ['.bench/dry/t1.md', '.bench/dry/group-x.md', 'README.md']);
  assert.deepEqual([...cell.files.get('l2')], ['.bench/dry/t2.md']);
  assert.deepEqual(cell.windows.get('l1'), [
    [Date.parse('2026-01-01T00:00:10Z'), Date.parse('2026-01-01T00:01:00Z')],
  ]);
});

// (b) fail-once counts only a CHECK_FAILED reply. A' cohort-fail t27456 (2026-11-18): its land
// ended COMPOSITION_CONFLICT and the old hook spent the fix on it; the 70c7347c guard counted it.
test('fail-once fires only on a CHECK_FAILED reply; a conflict end does not count', () => {
  assert.deepEqual(
    failureReading({ error: { code: 'COMPOSITION_CONFLICT', message: 'retained source conflicts' } }),
    {
      code: 'COMPOSITION_CONFLICT',
      admission: false,
    },
  );
  assert.deepEqual(
    failureReading({
      error: {
        code: 'CHECK_FAILED',
        message: 'The admission check of this change alone failed; it did not join a batch.',
      },
    }),
    { code: 'CHECK_FAILED', admission: true },
  );
  const roles = [{ task: 't', role: { failOnce: true } }];
  const fired = events => evidenceOf({ roles, records: [], calls: [], events: { t: events } }).roles[0].fired;
  assert.equal(fired([{ event: 'scenario', step: 'fix-after-failed-check' }]), false, 'old event, no code');
  assert.equal(
    fired([{ event: 'scenario', step: 'fix-after-failed-check', code: 'COMPOSITION_CONFLICT' }]),
    false,
  );
  assert.equal(
    fired([{ event: 'scenario', step: 'fix-after-failed-check', code: 'CHECK_FAILED', admission: false }]),
    true,
  );
  const semantic = events =>
    evidenceOf({
      roles: [{ task: 't', role: { failOnce: 'semantic' } }],
      records: [],
      calls: [],
      events: { t: events },
    }).roles[0].fired;
  assert.equal(
    semantic([{ event: 'scenario', step: 'fix-after-failed-check', code: 'CHECK_FAILED', admission: true }]),
    false,
    'failed at admission',
  );
  assert.equal(
    semantic([{ event: 'scenario', step: 'fix-after-failed-check', code: 'CHECK_FAILED', admission: false }]),
    true,
  );
});

// (c) cohort-fail v2: the semantic test passes on main and on its own change (admission), and
// fails once position 1's edit of the shared source is under it (queue check); one culprit.
test('cohort-fail v2: position 4 passes alone, fails with position 1 under it, passes after its fix', async () => {
  const [first, culprit] = [0, 3].map(i => scenarioRole('cohort-fail', i));
  assert.deepEqual(first.doc, { path: SHARED_SOURCE, at: 'top' });
  assert.equal(culprit.failOnce, 'semantic');
  assert.ok(culprit.releaseMs > 0, 'released after position 1, so its queue check is stacked on it');
  assert.equal(joinPath(TEST_DIR, SHARED_SOURCE.slice(TEST_DIR.length + 1)), SHARED_SOURCE);
  for (let i = 1; i < 10; i++)
    if (i !== 3) assert.deepEqual(scenarioRole('cohort-fail', i), {}, `position ${i + 1}`);
  // Run the generated test for real against the file before and after position 1's edit.
  const dir = mkdtempSync(joinPath(tmpdir(), 'bench-semantic-'));
  try {
    writeFile(
      joinPath(dir, 'vitest.mjs'),
      'export const results = []; export const it = (name, fn) => { try { fn(); results.push(true); } catch { results.push(false); } }; export const expect = value => ({ not: { toContain: part => { if (String(value).includes(part)) throw Error("contains"); } }, toBe: other => { if (value !== other) throw Error("differs"); } });\n',
    );
    const file = SHARED_SOURCE.slice(TEST_DIR.length + 1);
    const run = async (source, kind, n) => {
      writeFile(joinPath(dir, file), source);
      const test = scenarioTest('t4', kind).replace('"@effect/vitest"', '"./vitest.mjs"');
      writeFile(joinPath(dir, `case${n}.mjs`), test);
      const shim = await import(joinPath(dir, 'vitest.mjs'));
      const before = shim.results.length;
      await import(joinPath(dir, `case${n}.mjs`));
      return shim.results.slice(before);
    };
    const main = 'export const a = 1;\n';
    assert.deepEqual(await run(main, 'semantic', 1), [true], 'admission: passes on main');
    assert.deepEqual(
      await run(docEdit(main, 't1', 'top', SHARED_SOURCE), 'semantic', 2),
      [false],
      'queue: fails with position 1 under it',
    );
    assert.ok(docEdit(main, 't1', 'top', SHARED_SOURCE).startsWith(SOURCE_MARKER));
    assert.deepEqual(
      await run(docEdit(main, 't1', 'top', SHARED_SOURCE), 'fixed', 3),
      [true],
      'after the fix',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
