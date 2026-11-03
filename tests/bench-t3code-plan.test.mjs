// SPDX-License-Identifier: Apache-2.0
// B1.5d harness: the pre-registered plan, grading attribution and scoring, token totals,
// contamination and coordination rules (pure functions; no network, no bench data).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  schedule,
  taskOrder,
  DESIGN,
  batches,
  batch,
  rep3Decision,
  spread,
  primaryMetrics,
  repNs,
  nextBatch,
} from '../scripts/bench-t3code/plan.mjs';
import { batchGuard, staleBenchFreeze } from '../scripts/bench-t3code/drive.mjs';
import { realConflicts, mergeConflicts } from '../scripts/bench-t3code/hunks.mjs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { testCases, changedTitles, titleMatches, attribute } from '../scripts/bench-t3code/attribution.mjs';
import { grade, parseOracle, SUITES } from '../scripts/bench-t3code/oracle.mjs';
import { installKey, PACKAGES } from '../scripts/bench-t3code/deps.mjs';
import {
  usage,
  codexUsage,
  codexArgs,
  quotaHit,
  sandboxProfile,
  agentOf,
} from '../scripts/bench-t3code/agent.mjs';
import { readSession } from '../scripts/bench-t3code/transcripts.mjs';
import { usageProblems } from '../scripts/bench-t3code/gates.mjs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { scanTask } from '../scripts/bench-t3code/contamination.mjs';
import { forgeTask, githubTask, cellCoordination, gateTime } from '../scripts/bench-t3code/coordination.mjs';
import { differences } from '../scripts/bench-t3code/versions.mjs';
import { coordinationOf } from '../scripts/bench-t3code/broker.mjs';
import { settled, openLanes, resolveLanes } from '../scripts/bench-t3code/forge-arm.mjs';

const ids = [
  't27514',
  't27521',
  't19456',
  't23766',
  't26563',
  't26770',
  't27069',
  't23938',
  't22302',
  't27456',
];
/** Each dispatch group sits in consecutive positions of the order. */
const groupsContiguous = order =>
  DESIGN.dispatchGroups.every(g => {
    const at = g.map(id => order.indexOf(id)).sort((a, b) => a - b);
    return at.at(-1) - at[0] === g.length - 1;
  });

test('batches: concurrent pairs at N 1,3,5, sequential N 10 alternating, never over 10 agents', () => {
  const all = batches(ids);
  assert.equal(all.length, 8, 'reps 1 and 2, N 1,3,5,10');
  for (const b of all) {
    assert.equal(b.cells.length, 2);
    assert.deepEqual(b.cells.map(c => c.arm).sort(), ['forge', 'github']);
    assert.ok(b.agentsAtOnce <= DESIGN.maxAgents, `${b.key} runs ${b.agentsAtOnce} agents`);
    assert.equal(b.mode, b.N === 10 ? 'sequential' : 'concurrent');
    assert.deepEqual(b.cells[0].order, b.cells[1].order, 'both arms share the order');
    assert.deepEqual([...b.order].sort(), [...ids].sort());
    assert.ok(groupsContiguous(b.order), `${b.key}: dispatch groups back to back`);
  }
  const n10 = rep => batch(ids, 10, rep).cells[0].arm;
  assert.deepEqual([n10(1), n10(2), n10(3)], ['github', 'forge', 'github'], 'first arm alternates by rep');
  assert.equal(new Set(schedule(ids).map(c => c.key)).size, 24, 'every cell reps 1-3 is addressable');
  assert.deepEqual(batches(ids), all, 'deterministic');
  assert.notDeepEqual(taskOrder(ids, 'a'), taskOrder(ids, 'b'));
});

test('dispatch groups: each kept together with its inner order varying; a partial group is not', () => {
  const inner = new Set();
  for (let i = 0; i < 200; i++) {
    const order = taskOrder(ids, `seed-${i}`);
    assert.ok(groupsContiguous(order), `seed-${i}`);
    assert.deepEqual([...order].sort(), [...ids].sort());
    inner.add(order.filter(id => DESIGN.dispatchGroups[2].includes(id)).join(','));
  }
  assert.equal(inner.size, 6, 'every inner order of the preview triple occurs');
  // Without t27456 the triple is not a unit; its other members are shuffled freely.
  const partial = ids.filter(id => id !== 't27456');
  const apart = Array.from({ length: 200 }, (_, i) => taskOrder(partial, `p-${i}`)).some(
    order => Math.abs(order.indexOf('t19456') - order.indexOf('t22302')) > 1,
  );
  assert.ok(apart);
});

const cellResult = ({ times, landed = times.length, strict }) => ({
  records: times.map((t, i) => ({ task: `t${i}`, timeToMainSeconds: t, landing: { landed: i < landed } })),
  oracle: { grade: { strictSuccess: strict } },
  taskVoids: [],
});
test('batch order: rep 1 N descending, rep 2 ascending, rep 3 descending; resume keeps it', () => {
  assert.deepEqual(
    [repNs(1), repNs(2), repNs(3)],
    [
      [10, 5, 3, 1],
      [1, 3, 5, 10],
      [10, 5, 3, 1],
    ],
  );
  assert.deepEqual(
    batches(ids).map(b => b.key),
    ['n10-r1', 'n5-r1', 'n3-r1', 'n1-r1', 'n1-r2', 'n3-r2', 'n5-r2', 'n10-r2'],
  );
  // Attempt history per batch in plan order (true = void). The next batch to run is the first
  // with no valid attempt and fewer than two: a void batch re-runs before the next one starts.
  assert.equal(nextBatch([[], [], []]), 0);
  assert.equal(nextBatch([[false], [], []]), 1);
  assert.equal(nextBatch([[false], [true], []]), 1, 're-run the void batch first');
  assert.equal(nextBatch([[false], [true, true], []]), 2, 'two void attempts: published, move on');
  assert.equal(nextBatch([[true, false], [false], [false]]), -1);
  // A crash mid-batch is closed as interrupted (void) on resume, so it re-runs in place.
  assert.equal(nextBatch([[false], [false], [true], []]), 2);
});

test('rep 3 rule: winner flip or a >25% spread runs rep 3; close reps do not', () => {
  const r1 = {
    forge: cellResult({ times: [100, 110, 120], strict: 5 }),
    github: cellResult({ times: [200, 210, 220], strict: 5 }),
  };
  const close = {
    forge: cellResult({ times: [105, 115, 125], strict: 5 }),
    github: cellResult({ times: [210, 220, 230], strict: 6 }),
  };
  assert.deepEqual(rep3Decision(r1, close), { ...rep3Decision(r1, close), run: false, reasons: [] });
  const flip = {
    forge: cellResult({ times: [105, 115, 125], strict: 4 }),
    github: cellResult({ times: [210, 220, 230], strict: 5 }),
  };
  const f = rep3Decision(r1, {
    forge: cellResult({ times: [105, 115, 125], strict: 6 }),
    github: cellResult({ times: [210, 220, 230], strict: 5 }),
  });
  assert.equal(f.run, false, 'Forge 5=5 tie then Forge ahead is not a flip');
  const ff = rep3Decision({ ...r1, forge: cellResult({ times: [100, 110, 120], strict: 6 }) }, flip);
  assert.equal(ff.run, true);
  assert.match(ff.reasons.join(';'), /strict: winner flips \(Forge -> GitHub\)/);
  const slow = rep3Decision(r1, { ...close, forge: cellResult({ times: [140, 150, 160], strict: 5 }) });
  assert.equal(slow.run, true);
  assert.match(slow.reasons.join(';'), /timeToMain: forge 110 vs 150 \(36% > 25%\)/);
  assert.equal(rep3Decision(r1, null).run, true, 'a rep without a valid cell gets rep 3');
  assert.equal(spread(4, 5), 0.25, '4 vs 5 is exactly 25%: not more');
  assert.equal(primaryMetrics(cellResult({ times: [1, 2, 3, 4], landed: 3, strict: 2 })).timeToMain, 2);
});

test('batch guard: a fake landing or version change between batch start and end voids', () => {
  const s = {
    cli: { build: 'b', commit: 'c' },
    githubMain: 'c',
    deploy: { headSha: 'd' },
    convexTree: { deploy: 't' },
    checkWorkflow: { forge: 'f', github: 'g' },
    harness: { commit: 'h', filesSha256: 'x' },
    agent: 'codex gpt-6.1-sol high codex-cli 0.164.0',
    freeze: true,
  };
  assert.deepEqual(batchGuard(s, structuredClone(s)), []);
  assert.match(batchGuard(s, { ...s, githubMain: 'landed' }).join(), /githubMain: c -> landed/);
  assert.match(batchGuard(s, { ...s, deploy: { headSha: 'd-fake-landing' } }).join(), /deploy.headSha/);
  assert.match(batchGuard(s, { ...s, freeze: false }).join(), /freeze file missing/);
  const lane = { ...s, harness: { commit: null, filesSha256: 'x' } };
  assert.equal(batchGuard(lane, lane).length, 1, 'a Lane-root harness has no commit: a difference');
  assert.deepEqual(
    batchGuard(lane, lane, { unpinned: true }),
    [],
    'except in an explicit --unpinned dry run',
  );
  assert.equal(
    batchGuard(lane, { ...lane, harness: { commit: null, filesSha256: 'y' } }, { unpinned: true }).length,
    1,
  );
  assert.equal(staleBenchFreeze('bench driver batch n3-r1 pid 999999999'), true);
  assert.equal(staleBenchFreeze(`bench driver batch n3-r1 pid ${process.pid}`), false);
  assert.equal(staleBenchFreeze('lead hold'), false, 'a freeze someone else wrote is never removed');
});

test('gate time: preflight after save and overlap refusals count the time to the next land', () => {
  const t = gateTime([
    {
      verb: 'agent land --save',
      startedAt: '2026-11-01T00:00:00Z',
      endedAt: '2026-11-01T00:00:20Z',
      errorCodes: ['PREFLIGHT_REQUIRED'],
    },
    {
      verb: 'agent preflight',
      startedAt: '2026-11-01T00:00:30Z',
      endedAt: '2026-11-01T00:01:30Z',
      errorCodes: [],
    },
    {
      verb: 'agent land --save',
      startedAt: '2026-11-01T00:02:00Z',
      endedAt: '2026-11-01T00:02:05Z',
      errorCodes: ['OVERLAP_UNANSWERED'],
    },
    { verb: 'agent ack', startedAt: '2026-11-01T00:02:10Z', endedAt: '2026-11-01T00:02:11Z', errorCodes: [] },
    {
      verb: 'agent land --save',
      startedAt: '2026-11-01T00:02:40Z',
      endedAt: '2026-11-01T00:06:00Z',
      errorCodes: [],
    },
  ]);
  assert.deepEqual(t, {
    preflightRefusals: 1,
    preflightCalls: 1,
    preflightSeconds: 60,
    preflightLostSeconds: 120,
    overlapRefusals: 1,
    overlapLostSeconds: 40,
    refusedLandSeconds: 25,
  });
});

test('real conflicts: same hunks conflict, other regions and a synced-in sibling merge clean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b15d-hunks-'));
  try {
    const meta = join(root, 'meta');
    const git = (...a) => execFileSync('git', ['-C', meta, ...a], { encoding: 'utf8' });
    execFileSync('git', ['init', '-q', meta]);
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    writeFileSync(join(meta, 'a.ts'), lines.join('\n') + '\n');
    git('add', '.');
    git('-c', 'user.email=b@x', '-c', 'user.name=b', 'commit', '-qm', 'base');
    const baseCommit = git('rev-parse', 'HEAD').trim();
    const version = (task, edit) => {
      const dir = join(root, task);
      mkdirSync(dir, { recursive: true });
      const l = [...lines];
      edit(l);
      writeFileSync(join(dir, 'a.ts'), l.join('\n') + '\n');
      return { task, changes: { dir, files: [{ path: 'a.ts', status: 'M', saved: true }] } };
    };
    const tA = version('tA', l => (l[3] = 'A edit'));
    const tB = version('tB', l => (l[3] = 'B edit'));
    const tC = version('tC', l => (l[25] = 'C edit'));
    const tD = version('tD', l => ((l[3] = 'A edit'), (l[10] = 'D edit'))); // synced tA in
    const pairs = await realConflicts({ meta, baseCommit, tasks: [tA, tB, tC, tD] });
    const of = (x, y) => pairs.find(p => p.tasks.includes(x) && p.tasks.includes(y)).realConflict;
    assert.equal(of('tA', 'tB'), true);
    assert.equal(of('tA', 'tC'), false);
    assert.equal(of('tA', 'tD'), false, 'carrying the sibling change is not a conflict');
    assert.equal(of('tB', 'tD'), true);
    const n = (task, peer) => ({
      noticeId: `${task}${peer}`,
      file: 'a.ts',
      with: [{ lane: peer }],
      class: task === 'tA' ? 'blocking' : 'advisory',
    });
    const fk = (task, notices) =>
      forgeTask({
        task,
        calls: [{ verb: 'agent land', endedAt: '1', startedAt: '0', notices, answers: [], errorCodes: [] }],
        landing: { landed: true, operations: [] },
        session: { source: 'none', seen: [], actions: [] },
        laneTask: new Map([
          ['tB', 'tB'],
          ['tC', 'tC'],
        ]),
      });
    const cell = cellCoordination(
      'forge',
      [fk('tA', [n('tA', 'tB')]), fk('tC', [n('tC', 'tA')]), fk('tB', []), fk('tD', [])],
      ['tA', 'tB', 'tC', 'tD'].map(task => ({
        task,
        overlap: 'same-package:x',
        landing: { landed: true },
        changes: {},
      })),
      { realConflicts: pairs },
    );
    assert.deepEqual(cell.metric4.byClass, {
      blocking: { notices: 1, acknowledged: 0, useful: 1, noise: 0, unknown: 0 },
      advisory: { notices: 1, acknowledged: 0, useful: 0, noise: 1, unknown: 0 },
    });
    assert.deepEqual(
      cell.metric4.missed,
      [{ path: 'a.ts', tasks: ['tB', 'tD'] }],
      'real conflict nobody was told about',
    );
    // Only tasks that ran at the same time can miss a notice; a task's own Lane is not a peer.
    const at = (task, from, to) => ({
      task,
      overlap: 'same-package:x',
      dispatchedAt: `2026-11-01T00:${from}:00Z`,
      landing: { landed: true, acceptedAt: `2026-11-01T00:${to}:00Z` },
    });
    const own = forgeTask({
      task: 'tB',
      calls: [
        {
          verb: 'agent land',
          endedAt: '1',
          notices: [{ noticeId: 'own', file: 'a.ts', with: [{ lane: 'LB' }], class: 'advisory' }],
          answers: [],
          errorCodes: [],
        },
      ],
      landing: { landed: true, operations: [] },
      session: { source: 'none', seen: [], actions: [] },
      laneTask: new Map([['LB', 'tB']]),
    });
    const timed = cellCoordination(
      'forge',
      [own, ...['tA', 'tD'].map(t => fk(t, []))],
      [at('tA', '00', '10'), at('tB', '20', '30'), at('tD', '25', '40')],
      { realConflicts: pairs },
    );
    assert.deepEqual(
      timed.metric4.missed,
      [{ path: 'a.ts', tasks: ['tB', 'tD'] }],
      'tB and tD overlapped in time',
    );
    assert.equal(timed.metric4.notConcurrent, 1, 'tA landed before tB started');
    assert.deepEqual(
      timed.metric4.byClass.advisory,
      { notices: 1, acknowledged: 0, useful: 0, noise: 1, unknown: 0 },
      'a notice naming only its own Lane is noise',
    );
    // Both added one file, the second on top of the first: carried, not a conflict.
    const added = (task, text) => {
      const d = join(root, `add-${task}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'new.md'), text);
      return { task, changes: { dir: d, files: [{ path: 'new.md', status: 'A', saved: true }] } };
    };
    const adds = await realConflicts({
      meta,
      baseCommit,
      tasks: [added('tA', 'tA\n'), added('tB', 'tA\ntB\n'), added('tC', 'tC\n')],
    });
    assert.deepEqual(
      adds.map(p => [p.tasks.join('+'), p.realConflict, p.carried ?? false]),
      [
        ['tA+tB', false, true],
        ['tA+tC', true, false],
        ['tB+tC', true, false],
      ],
    );
    // Carried is only certain when the later task started after the earlier landed.
    const carriedCell = runs =>
      cellCoordination(
        'forge',
        ['tA', 'tB', 'tC'].map(t => fk(t, [])),
        runs,
        { realConflicts: adds },
      ).realConflicts.find(p => p.tasks.join('+') === 'tA+tB').realConflict;
    assert.equal(carriedCell([at('tA', '00', '10'), at('tB', '20', '30'), at('tC', '40', '50')]), false);
    assert.equal(carriedCell([at('tA', '00', '25'), at('tB', '20', '30'), at('tC', '40', '50')]), null);
    // No evidence is not a conflict: a merge git cannot run (exit 255) or a bad base is unknown.
    assert.equal(await mergeConflicts(join(root, 'nope1'), join(root, 'nope2'), join(root, 'nope3')), null);
    const bad = await realConflicts({ meta, baseCommit: 'f'.repeat(40), tasks: [tA, tB] });
    assert.deepEqual(
      bad.map(p => p.realConflict),
      [null],
    );
    const gone = {
      task: 'tE',
      changes: { dir: join(root, 'missing'), files: [{ path: 'a.ts', status: 'M', saved: true }] },
    };
    const broken = await realConflicts({ meta, baseCommit, tasks: [tA, gone] });
    assert.deepEqual(
      broken.map(p => [p.conflicts, p.realConflict]),
      [[null, null]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('forge landing: a passed check still queued to land is in flight, not done', () => {
  // n3-r1-dry-a4 t27514: phase ready, observation pending/queued at 12:23, landed 12:39.
  assert.equal(settled('ready', 'pending'), false);
  assert.equal(settled('ready', null), true, 'ready with nothing pending waits for an accept');
  assert.equal(settled('landed', 'landed'), true);
  assert.equal(settled('checking', null), false);
});

test('forge Lanes: resolve Lanes are found and the ledger lists Lanes never closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b15d-lanes-'));
  try {
    const root = join(dir, 't1');
    for (const [d, laneId] of [
      ['r1', 'L-resolve'],
      ['junk', null],
    ]) {
      mkdirSync(join(`${root}.forge-client`, 'lanes', d, '.forge'), { recursive: true });
      if (laneId)
        writeFileSync(
          join(`${root}.forge-client`, 'lanes', d, '.forge', 'hosted-lane.json'),
          JSON.stringify({ selection: { laneId } }),
        );
    }
    assert.deepEqual(
      resolveLanes(root).map(l => l.laneId),
      ['L-resolve'],
    );
    assert.deepEqual(resolveLanes(join(dir, 'none')), []);
    const ledger = join(dir, 'forge-lanes.jsonl');
    writeFileSync(
      ledger,
      ['open L1', 'open L2', 'closed L1', 'open L3', 'closed L3', 'open L3']
        .map(x => JSON.stringify({ op: x.split(' ')[0], laneId: x.split(' ')[1] }))
        .join('\n') + '\n',
    );
    assert.deepEqual(
      openLanes(ledger).map(l => l.laneId),
      ['L2', 'L3'],
    );
    assert.deepEqual(openLanes(join(dir, 'missing.jsonl')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relay: notice class and reason are kept; an OVERLAP_UNANSWERED refusal is blocking', () => {
  const c = coordinationOf(
    ['agent', '.', 'land', '{}'],
    JSON.stringify({
      overlapNotice: {
        items: [{ noticeId: 'n1', file: 'a.ts', with: [], class: 'advisory', reason: 'disjoint-ranges' }],
      },
    }),
  );
  assert.deepEqual([c.notices[0].class, c.notices[0].reason], ['advisory', 'disjoint-ranges']);
  const r = coordinationOf(
    ['agent', '.', 'land', '{}'],
    '{"error":{"code":"OVERLAP_UNANSWERED","message":"Answer the overlap notice(s) on a.ts before landing"}}',
  );
  assert.deepEqual(
    [r.notices[0].class, r.notices[0].refusal],
    [null, true],
    'older gate wording says no class',
  );
  const blocking = coordinationOf(
    ['agent', '.', 'land', '{}'],
    '{"error":{"code":"OVERLAP_UNANSWERED","message":"Answer the blocking overlap notice(s) on a.ts, b.ts before landing (project overlapGate: block)."}}',
  );
  assert.deepEqual(
    blocking.notices.map(n => [n.file, n.class, n.reason]),
    [
      ['a.ts', 'blocking', 'refused'],
      ['b.ts', 'blocking', 'refused'],
    ],
  );
});

test('metric 4: a receipt then a refusal on its file is one gated notice; later class fills in', () => {
  const call = (endedAt, notices, extra = {}) => ({
    verb: 'agent land',
    endedAt,
    notices,
    answers: [],
    ...extra,
  });
  const t = forgeTask({
    task: 'tA',
    calls: [
      call('2026-11-01T00:00:00Z', [
        { noticeId: 'n', file: 'shared.ts', with: [{ lane: 'L2' }], class: null },
      ]),
      call('2026-11-01T00:01:00Z', [{ noticeId: null, file: 'shared.ts', refusal: true, class: null }], {
        errorCodes: ['OVERLAP_UNANSWERED'],
      }),
      call('2026-11-01T00:02:00Z', [
        { noticeId: 'n', file: 'shared.ts', class: 'blocking', reason: 'same-hunk' },
      ]),
    ],
    landing: { landed: true, operations: [] },
    session: { source: 'none', seen: [], actions: [] },
    laneTask: new Map([['L2', 'tB']]),
  });
  assert.deepEqual(
    t.notices.map(n => [n.noticeId, n.file, n.gated, n.class, n.reason, n.peers.join(), n.deliveredAt]),
    [['n', 'shared.ts', true, 'blocking', 'same-hunk', 'tB', '2026-11-01T00:00:00Z']],
  );
  // Refusal first, receipt with the id after: still one notice.
  const r = forgeTask({
    task: 'tA',
    calls: [
      call('1', [{ noticeId: null, file: 'shared.ts', refusal: true, class: 'blocking', reason: 'refused' }]),
      call('2', [{ noticeId: 'n', file: 'shared.ts', class: 'blocking', reason: 'same-hunk' }]),
      call('3', [{ noticeId: 'm', file: 'other.ts', class: 'advisory' }]),
    ],
    landing: { landed: true, operations: [] },
    session: { source: 'none', seen: [], actions: [] },
    laneTask: new Map(),
  });
  assert.deepEqual(
    r.notices.map(n => [n.noticeId, n.gated, n.class]),
    [
      ['n', true, 'blocking'],
      ['m', false, 'advisory'],
    ],
  );
});

test('harness scripts: every script parses (preflight once shipped with a duplicate const)', () => {
  const dir = join(import.meta.dirname, '../scripts/bench-t3code');
  for (const name of readdirSync(dir).filter(f => f.endsWith('.mjs')))
    execFileSync(process.execPath, ['--check', join(dir, name)]);
});

const before = `describe('x', () => {
  it('keeps', () => { expect(1).toBe(1); });
  it.effect("changes", () => Effect.succeed(1));
});`;
const after = `describe('x', () => {
  it('keeps', () => { expect(1).toBe(1); });
  it.effect("changes", () => Effect.succeed(2));
  it.effect.each([{ pi: 'a' }, { pi: 'b' }])("stops when it $pi", ({ pi }) => Effect.void);
});`;

test('attribution: added and changed cases, it.each titles, latest changer owns a shared case', () => {
  assert.deepEqual([...testCases(after).keys()], ['keeps', 'changes', 'stops when it $pi']);
  assert.deepEqual(changedTitles(before, after), ['changes', 'stops when it $pi']);
  assert.ok(titleMatches('x stops when it a', 'stops when it $pi'));
  assert.ok(!titleMatches('x keepsake', 'keeps'));
  const files = { base: before, A: after, B: after.replace('Effect.succeed(2)', 'Effect.succeed(3)') };
  const show = (commit, path) =>
    path === 'f.test.ts'
      ? files[commit.replace('^1', '')] && commit.endsWith('^1')
        ? commit === 'A^1'
          ? files.base
          : files.A
        : files[commit]
      : null;
  const tasks = [
    { id: 'tA', mergedAt: '1', mergeCommit: 'A', oracle: { testFiles: ['f.test.ts'] } },
    { id: 'tB', mergedAt: '2', mergeCommit: 'B', oracle: { testFiles: ['f.test.ts'] } },
  ];
  const owners = attribute(tasks, show);
  assert.equal(owners.latest['f.test.ts'], 'B');
  assert.deepEqual(owners.files['f.test.ts'], { changes: 'tB', 'stops when it $pi': 'tA' });
});

test('grade: per-task cases on a shared file, strict and lenient, wording-only, existing suite', () => {
  const tasks = [
    { id: 'tA', oracle: { testFiles: ['f.test.ts'] } },
    { id: 'tB', oracle: { testFiles: ['f.test.ts'] } },
    { id: 'tC', oracle: { testFiles: ['g.test.ts'] } },
  ];
  const b64 = s => Buffer.from(s).toString('base64');
  const lines = [
    'ORACLE failed f.test.ts 2/3',
    `ORACLE-CASE passed f.test.ts ${b64('x keeps')} ${b64('')}`,
    `ORACLE-CASE passed f.test.ts ${b64('x stops when it a')} ${b64('')}`,
    `ORACLE-CASE failed f.test.ts ${b64('x changes')} ${b64("AssertionError: expected 'Pi has no key' to include 'Pi default has no key'")}`,
    'ORACLE passed g.test.ts 1/1',
    `ORACLE-CASE passed g.test.ts ${b64('g one')} ${b64('')}`,
    `ORACLE-CASE skipped h.test.ts ${b64('h needs nushell')} ${b64('')}`,
    ...SUITES.map(p => `ORACLE-PACKAGE ${p} passed 1/1`),
  ];
  const result = parseOracle(lines);
  const owners = { files: { 'f.test.ts': { changes: 'tB', 'stops when it $pi': 'tA' } } };
  const g = grade(tasks, result, owners);
  assert.equal(g.perTask.tA.strict, 'passed', 'tB failing its own case does not fail tA');
  assert.equal(g.perTask.tB.strict, 'failed');
  assert.equal(g.perTask.tB.wordingOnly, true);
  assert.equal(g.perTask.tC.strict, 'passed', 'a file only one task changed: all its cases');
  assert.equal(g.strictSuccess, 2);
  assert.equal(g.fileLevelSuccess, 1, 'the old file-level score failed both tasks of the shared file');
  assert.ok(Math.abs(g.lenientScore - 2 / 3) < 1e-9);
  assert.equal(g.existingSuitesGreen, true, '"x keeps" is unowned and passed; a base skip is no failure');
  assert.equal(g.existingSkipped, 1);
  // Every suite of the scope must report: one missing suite is not a green cell.
  const short = grade(tasks, parseOracle(lines.slice(0, -1)), owners);
  assert.equal(short.existingSuitesGreen, false);
  assert.equal(short.suiteGreen, false);
});

test('scope: oracle suites, the check and the dependency install name the same packages', () => {
  const ci = readFileSync(new URL('../scripts/bench-t3code/oracle.sh', import.meta.url), 'utf8');
  assert.deepEqual(SUITES, [
    '@t3tools/shared',
    '@t3tools/provider-pi',
    '@t3tools/client-runtime',
    '@t3tools/source-control-forgejo',
    'effect-codex-app-server',
    't3:src/preview',
  ]);
  assert.deepEqual(
    SUITES.map(s => s.split(':')[0]),
    PACKAGES,
    'deps installs exactly the packages the oracle tests',
  );
  assert.match(ci, /PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24\.04-x64/);
  // The install is keyed by the lockfile and the filter set: a new filter set on the same
  // lockfile is a new install, never a silent reuse of the old one.
  const dir = mkdtempSync(join(tmpdir(), 'forge-b15d-deps-'));
  try {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const now = installKey(dir),
      old = installKey(dir, ['@t3tools/shared']);
    assert.match(now, /^[0-9a-f]{12}-[0-9a-f]{8}$/);
    assert.equal(now.split('-')[0], old.split('-')[0], 'same lockfile');
    assert.notEqual(now, old, 'different filter set');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage: totals every turn and model, keeps the last turn apart', () => {
  const out = JSON.stringify({
    session_id: 's',
    num_turns: 1,
    duration_api_ms: 9000,
    usage: {
      input_tokens: 4,
      output_tokens: 45,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 1,
    },
    modelUsage: {
      a: {
        inputTokens: 70,
        outputTokens: 10000,
        cacheReadInputTokens: 1600000,
        cacheCreationInputTokens: 50000,
      },
      b: { inputTokens: 4, outputTokens: 695, cacheReadInputTokens: 60520, cacheCreationInputTokens: 2115 },
    },
  });
  const u = usage(`noise\n${out}`);
  assert.equal(u.outputTokens, 10695);
  assert.equal(u.cacheReadInputTokens, 1660520);
  assert.equal(u.lastTurn.outputTokens, 45);
  assert.equal(u.durationApiMs, 9000);
});

test('contamination: reaching for upstream, solution refs or history voids the task', () => {
  const prNumbers = [27097, 27514];
  const scan = (inputs, seen = [], calls = []) =>
    scanTask({
      session: { source: 'transcript', actions: inputs.map(input => ({ tool: 'Bash', input })), seen },
      calls,
      prNumbers,
    });
  assert.equal(
    scan(['vp test run src/a.test.ts', 'git pull --no-rebase origin main', 'gh pr checks']).void,
    false,
  );
  for (const bad of [
    'gh pr list --state merged',
    'git fetch origin q/27514-ref',
    'curl https://github.com/pingdotgg/t3code/pull/27097',
    'git log --all --oneline',
    'cat ../../forge-bench/b15d/tasks.json',
    'gh api repos/x/y/compare/a...b',
  ])
    assert.equal(scan([bad]).void, true, bad);
  assert.equal(scan([], [' * [new branch]      q/27514-ref -> origin/q/27514-ref']).void, true);
  const fork = (input, ownPrs) =>
    scanTask({
      session: { source: 'transcript', actions: [{ tool: 'Bash', input }], seen: [] },
      prNumbers,
      ownPrs,
    }).void;
  assert.equal(fork('gh pr checks 12 --watch', [12]), false, 'its own PR');
  assert.equal(fork('gh pr diff 7', [12]), true, "an earlier cell's PR");
  assert.equal(fork('git fetch origin pull/7/head', [12]), true);
  const sha = (input, mergeShas) =>
    scanTask({
      session: { source: 'transcript', actions: [{ tool: 'Bash', input }], seen: [] },
      prNumbers,
      mergeShas,
    }).void;
  const merge = 'afb8619e1ddcda94388e3cba89f2c1384e85d711';
  assert.equal(sha('git show afb8619e', [merge]), true, 'a task merge commit is a solution ref');
  assert.equal(sha(`git fetch origin ${merge}`, [merge]), true);
  assert.equal(sha('git show afb8619', [merge]), true, 'from 7 hex characters');
  assert.equal(sha('git show afb861', [merge]), false, 'shorter is not a ref');
  assert.equal(sha('git log -1 deadbeefcafe', [merge]), false, 'other commits are fine');
  const lane = '11111111-1111-4111-8111-111111111111',
    other = '22222222-2222-4222-8222-222222222222';
  const own = [{ verb: 'agent land', args: ['{}'], operationIds: [lane], ids: [lane] }];
  assert.equal(
    scan([], [], [...own, { verb: 'agent observe', args: [`{"operationId":"${lane}"}`] }]).void,
    false,
  );
  assert.equal(scan([], [], [...own, { verb: 'agent show', args: [`{"receiptId":"${other}"}`] }]).void, true);
});

test('coordination: Forge metric 4 and pair outcome; GitHub sibling-caused queue failure', () => {
  const notice = { noticeId: 'n1', file: 'a.ts', with: [{ lane: 'L2', intent: 'tB: other' }] };
  const callsA = [
    {
      verb: 'agent land',
      endedAt: '2026-11-01T00:01:00Z',
      notices: [notice],
      errorCodes: ['OVERLAP_UNANSWERED'],
      answers: [],
    },
    {
      verb: 'agent ack',
      endedAt: '2026-11-01T00:01:30Z',
      notices: [],
      answers: [{ noticeId: null, choice: 'accept-order' }],
    },
    { verb: 'agent land', endedAt: '2026-11-01T00:05:00Z', notices: [], answers: [] },
  ];
  const session = { source: 'transcript', seen: ['... OVERLAP NOTICE ...'], actions: [] };
  const laneTask = new Map([['L2', 'tB']]);
  const a = forgeTask({
    task: 'tA',
    calls: callsA,
    landing: { landed: true, operations: [] },
    session,
    laneTask,
  });
  const b = forgeTask({
    task: 'tB',
    calls: [{ verb: 'agent land', endedAt: 'x', notices: [], answers: [] }],
    landing: { landed: true, operations: [] },
    session,
    laneTask,
  });
  assert.equal(a.gateRefusals, 1);
  assert.equal(a.extraLandAttempts, 0, 'answering a notice is not rework');
  assert.equal(a.notices[0].acknowledged, true);
  assert.equal(a.notices[0].ackSeconds, 30);
  const cell = cellCoordination(
    'forge',
    [a, b],
    [
      { task: 'tA', overlap: 'overlap:x', landing: { landed: true } },
      { task: 'tB', overlap: 'overlap:x', landing: { landed: true } },
    ],
  );
  const { byClass, missed, notConcurrent, gateTime: gt, ...m4 } = cell.metric4;
  assert.deepEqual(byClass, {
    unclassified: { notices: 1, acknowledged: 1, useful: 0, noise: 0, unknown: 1 },
  });
  assert.deepEqual([missed, notConcurrent, gt.overlapRefusals], [[], 0, 1]);
  assert.deepEqual(
    { ...m4, choices: undefined },
    {
      noticesRaised: 1,
      delivered: 1,
      acknowledged: 1,
      ackRate: 1,
      gated: 0,
      gatedAcknowledged: 0,
      choices: undefined,
    },
  );
  assert.equal(cell.pairs[0].peer, 'tB');
  assert.equal(cell.classes['overlap:x'].landedCleanRate, 1);
  const refused = coordinationOf(
    ['agent', '.', 'land', '{}'],
    '{"error":{"code":"OVERLAP_UNANSWERED","message":"Answer the overlap notice(s) on a.ts, b.ts before landing (project overlapGate: block)."}}',
  );
  assert.deepEqual(
    refused.notices.map(n => n.file),
    ['a.ts', 'b.ts'],
  );
  const runs = [
    { pr: 7, event: 'pull_request', conclusion: 'success', created_at: '1' },
    { pr: 7, event: 'merge_group', conclusion: 'failure', created_at: '2' },
    { pr: 7, event: 'pull_request', conclusion: 'success', created_at: '3' },
    { pr: 7, event: 'merge_group', conclusion: 'success', created_at: '4' },
  ];
  const g = githubTask({
    task: 'tC',
    landing: { landed: true, prs: [7] },
    session: { seen: ['CONFLICT (content): Merge conflict in a.ts'], actions: [] },
    runs,
  });
  assert.equal(g.siblingCausedFailures, 1);
  assert.equal(g.extraPrPushes, 1);
  assert.equal(g.mergeConflicts, 1);
  assert.equal(g.reworkBecauseSibling, true);
  assert.equal(g.clean, false);
});

test('versions: any changed or unreadable value is a difference', () => {
  const s = {
    cli: { build: 'b', commit: 'c' },
    githubMain: 'c',
    deploy: { headSha: 'd' },
    convexTree: { deploy: 't' },
    checkWorkflow: { forge: 'f', github: 'g' },
    harness: { commit: 'h', filesSha256: 'x' },
    agent: 'codex gpt-6.1-sol high codex-cli 0.164.0',
  };
  assert.deepEqual(differences(s, structuredClone(s)), []);
  assert.equal(differences(s, { ...s, cli: { build: 'b', commit: 'fake' } }).length, 1);
  assert.equal(differences(s, { ...s, agent: null }).length, 1);
  assert.equal(differences(s, { ...s, agent: 'codex gpt-6.1-sol high codex-cli 0.165.0' }).length, 1);
});

const rollout = [
  { type: 'session_meta', payload: { id: 'thread-1' } },
  { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } },
  { type: 'token_usage_record', payload: {} },
  {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input: 'text(await tools.exec_command({cmd:"gh pr diff 7 && nforge agent . land --save"}))',
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      output: [
        { type: 'input_text', text: 'Script completed' },
        {
          type: 'input_text',
          text: JSON.stringify({
            exit_code: 1,
            output: 'OVERLAP NOTICE n1\nCONFLICT (content): Merge conflict in a.ts',
          }),
        },
      ],
    },
  },
  {
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git rebase main"}' },
  },
  { type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } },
  { type: 'token_usage_record', payload: {} },
  {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 800,
          output_tokens: 90,
          reasoning_output_tokens: 40,
        },
        last_token_usage: { input_tokens: 600 },
      },
      rate_limits: { primary: { used_percent: 12, window_minutes: 10080 }, secondary: null },
    },
  },
]
  .map(e => JSON.stringify(e))
  .join('\n');

test('codex: usage over every request, quota from CLI errors only, args and sandbox for parity', () => {
  const stdout = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'I hit a rate limit earlier, retrying' } },
    { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 90 } },
  ]
    .map(e => JSON.stringify(e))
    .join('\n');
  const u = codexUsage(stdout, rollout);
  assert.equal(u.source, 'rollout');
  assert.equal(u.numTurns, 2, 'every model request, not the one exec turn');
  assert.equal(u.inputTokens, 200, 'uncached input');
  assert.equal(u.cacheReadInputTokens, 800);
  assert.equal(u.outputTokens, 90);
  assert.equal(u.reasoningOutputTokens, 40);
  assert.deepEqual(u.models, ['gpt-6.1-sol']);
  assert.deepEqual(u.execJsonTotals, { input: 1000, cached: 800, output: 90 });
  assert.equal(codexUsage(stdout).source, 'exec-json', 'no rollout: exec --json totals');
  // Agent prose about limits is not a quota hit; a CLI error or a full window is.
  assert.equal(quotaHit({ provider: 'codex', stdout, stderr: '', usage: u }), false);
  const failed = codexUsage(
    JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit" } }),
  );
  assert.equal(failed.parseError, true);
  assert.equal(quotaHit({ provider: 'codex', stdout: '', stderr: '', usage: failed }), true);
  assert.equal(
    quotaHit({
      provider: 'codex',
      stdout: '',
      stderr: '',
      usage: { ...u, rateLimits: { primary: { used_percent: 100 } } },
    }),
    true,
  );
  assert.equal(
    quotaHit({ provider: 'codex', stdout: '', stderr: 'ERROR: 429 Too Many Requests', usage: u }),
    true,
  );

  const a = agentOf({ agent: { provider: 'codex' } });
  assert.deepEqual([a.model, a.effort], ['gpt-6.1-sol', 'high']);
  assert.equal(agentOf({}).provider, 'codex');
  const args = codexArgs({ ...a, workspace: '/w', prompt: '-p looks like a flag' });
  for (const want of [
    '--json',
    'model_reasoning_effort="high"',
    'web_search="disabled"',
    'allow_login_shell=false',
    '--ignore-user-config',
    '--ignore-rules',
    'multi_agent',
  ])
    assert.ok(args.includes(want), want);
  assert.deepEqual(args.slice(-2), ['--', '-p looks like a flag'], 'the prompt is never parsed as flags');
  const profile = sandboxProfile({
    workspace: '/w/ws',
    benchRoot: '/x/forge-bench/b15d',
    codexHome: join(homedir(), '.codex-bench/h'),
  });
  assert.match(profile, new RegExp(`deny file-read\\*.*${join(homedir(), '.codex')}"`));
  assert.match(profile, /\.codex-bench\/h/);
  assert.match(profile, /literal "[^"]*\.codex\/auth\.json"/);
  assert.doesNotMatch(sandboxProfile({ workspace: '/w/ws', benchRoot: '/x/forge-bench/b15d' }), /\.codex/);
  assert.deepEqual(usageProblems({ provider: 'codex', weekly: 10, has5h: false, session5h: null }), []);
  assert.equal(usageProblems({ provider: 'codex', weekly: 90, has5h: false }).length, 1);
  assert.equal(usageProblems({ provider: 'claude', weekly: 10, has5h: true, session5h: null }).length, 1);
});

test('codex transcripts: the leak scan and coordination counters read rollout actions and outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-codex-'));
  try {
    writeFileSync(join(dir, 't.transcript.jsonl'), rollout + '\n');
    const session = readSession(join(dir, 't'));
    assert.equal(session.format, 'codex');
    assert.equal(session.actions.length, 2);
    assert.ok(session.seen.some(x => x.includes('CONFLICT (content): Merge conflict in a.ts')));
    assert.equal(
      scanTask({ session, prNumbers: [27097], ownPrs: [] }).void,
      true,
      'gh pr diff 7 is another PR',
    );
    const g = githubTask({ task: 'tC', landing: { landed: true, prs: [7] }, session, runs: [] });
    assert.equal(g.mergeConflicts, 1);
    assert.equal(g.rebases, 1);
    // A Codex patch names the agent's own workspace by absolute path, under the bench root.
    const ws = '/b/forge-bench/b15d/ws/cell/t1';
    const patch = { tool: 'exec', input: `apply_patch("*** Update File: ${ws}/src/a.ts")` };
    const own = { source: 'transcript', actions: [patch], seen: [`${ws}.forge-client/lanes/x`] };
    assert.equal(scanTask({ session: own, prNumbers: [], workspace: ws }).void, false);
    const sibling = {
      ...own,
      actions: [{ tool: 'exec', input: 'cat /b/forge-bench/b15d/ws/cell/t2/src/a.ts' }],
    };
    assert.equal(scanTask({ session: sibling, prNumbers: [], workspace: ws }).void, true);
    assert.equal(
      scanTask({ session: own, prNumbers: [] }).void,
      true,
      'no workspace given: still bench data',
    );
    const help = forgeTask({
      task: 't1',
      calls: [
        { verb: 'agent land --help', notices: [], answers: [] },
        { verb: 'agent land --save', notices: [], answers: [] },
      ],
      landing: { landed: true, operations: [] },
      session: own,
      laneTask: new Map(),
    });
    assert.equal(help.landAttempts, 1, 'land --help is not an attempt');
    assert.equal(help.clean, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relay: a separate process answers agents while the harness process is blocked', async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, realpathSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-relay-')));
  try {
    const cli = join(dir, 'cli.mjs'),
      log = join(dir, 'calls.jsonl'),
      root = join(dir, 'ws');
    mkdirSync(root);
    mkdirSync(join(dir, 'ws.forge-client', 'lanes', 'r'), { recursive: true });
    const id = '11111111-1111-4111-8111-111111111111';
    writeFileSync(
      cli,
      `console.log(JSON.stringify({ action: process.argv[4], operationId: '${id}', result: {}, overlapNotice: { items: [{ noticeId: 'n1', file: 'a.ts', with: [] }] } }));\n` +
        // A refused land prints its error on stderr (the real CLI does): its gate notice counts.
        `console.error(JSON.stringify({ error: { code: 'OVERLAP_UNANSWERED', message: 'Answer the blocking overlap notice(s) on b.ts before landing' } }));\n`,
    );
    const broker = spawn(
      process.execPath,
      [new URL('../scripts/bench-t3code/broker.mjs', import.meta.url).pathname, cli, log],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    try {
      const { port, admin } = await new Promise(done => broker.stdout.once('data', d => done(JSON.parse(d))));
      const post = (path, body) =>
        fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body) }).then(r =>
          r.text().then(text =>
            text
              .split('\n')
              .filter(Boolean)
              .map(JSON.parse)
              .reduce(
                (out, frame) => ({
                  ...out,
                  ...frame,
                  stdout: (out.stdout ?? '') + (frame.stdout ?? ''),
                  stderr: (out.stderr ?? '') + (frame.stderr ?? ''),
                }),
                {},
              ),
          ),
        );
      assert.equal((await post('/register', { admin, token: 't', root, task: 'tA' })).ok, true);
      assert.equal((await post('/register', { admin: 'wrong', token: 'u', root: '/' })).ok, false);
      // spawnSync blocks this (harness) process for the whole client run: only an out-of-process relay can answer.
      const client = `const post = (cwd, args) => fetch('http://127.0.0.1:${port}/', { method: 'POST', body: JSON.stringify({ token: 't', cwd, args }) }).then(r => r.text()).then(t => t.split('\\n').filter(Boolean).map(JSON.parse).reduce((a, f) => ({ ...a, ...f, stdout: (a.stdout ?? '') + (f.stdout ?? '') }), {}));
        const ok = await post(${JSON.stringify(root)}, ['agent', '.', 'land', '{}']);
        const out = await post(${JSON.stringify(dir)}, ['agent', '.', 'land', '{}']);
        const resolve = await post(${JSON.stringify(join(dir, 'ws.forge-client', 'lanes', 'r'))}, ['agent', '.', 'resolve', '{}']);
        console.log(JSON.stringify({ ok: ok.code, refused: out.code, resolve: resolve.code, stdout: ok.stdout }));`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', client], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      const answer = JSON.parse(run.stdout);
      assert.equal(answer.ok, 0);
      assert.equal(answer.refused, 2, 'a call outside the agent workspace is refused');
      assert.equal(answer.resolve, 0, "the agent's own resolve Lane root is allowed");
      const [call] = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      assert.equal(call.task, 'tA');
      assert.equal(call.verb, 'agent land');
      assert.deepEqual(call.operationIds, [id]);
      assert.equal(call.notices[0].noticeId, 'n1');
      assert.deepEqual(
        call.notices.map(n => [n.file, n.class, n.refusal ?? false]),
        [
          ['a.ts', null, false],
          ['b.ts', 'blocking', true],
        ],
        'the refusal on stderr is read too',
      );
    } finally {
      broker.kill();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relay: agents keep getting answers while the harness deletes a Lane folder', async t => {
  const { spawn } = await import('node:child_process');
  const { realpathSync, existsSync } = await import('node:fs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-relay-rm-')));
  const broker = spawn(
    process.execPath,
    [
      new URL('../scripts/bench-t3code/broker.mjs', import.meta.url).pathname,
      join(dir, 'cli.mjs'),
      join(dir, 'calls.jsonl'),
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  try {
    const root = join(dir, 'ws');
    const lane = join(dir, 'ws.forge-client', 'lanes', 'old');
    for (let d = 0; d < 40; d++) {
      mkdirSync(join(lane, 'node_modules', `p${d}`), { recursive: true });
      for (let f = 0; f < 50; f++)
        writeFileSync(join(lane, 'node_modules', `p${d}`, `f${f}.js`), 'x'.repeat(512));
    }
    mkdirSync(root);
    writeFileSync(join(dir, 'cli.mjs'), `console.log('{}');\n`);
    const { port, admin } = await new Promise(done => broker.stdout.once('data', d => done(JSON.parse(d))));
    await fetch(`http://127.0.0.1:${port}/register`, {
      method: 'POST',
      body: JSON.stringify({ admin, token: 't', root, task: 'tA' }),
    });
    // An agent calling the CLI in a loop, in its own process.
    const client = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const calls = []; const until = Date.now() + 3000;
         while (Date.now() < until) {
           const start = Date.now();
           const r = await fetch('http://127.0.0.1:${port}/', { method: 'POST', body: JSON.stringify({ token: 't', cwd: ${JSON.stringify(root)}, args: ['agent', '.', 'status'] }) }).then(r => r.text()).then(t => JSON.parse(t.trim().split('\\n').at(-1)));
           calls.push({ start, end: Date.now(), code: r.code });
           if (calls.length === 1) console.log('go');
         }
         console.log(JSON.stringify(calls));`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    client.stdout.on('data', d => (out += d));
    await new Promise(done => client.stdout.once('data', done));
    // The worst case: the harness thread is blocked for the whole deletion (rmSync, then held
    // to 1.5 s as a stand-in for a large node_modules). The relay is not in this process.
    const t0 = Date.now();
    rmSync(join(dir, 'ws.forge-client'), { recursive: true, force: true });
    while (Date.now() - t0 < 1500);
    const t1 = Date.now();
    await new Promise(done => client.once('exit', done));
    const calls = JSON.parse(out.trim().split('\n').at(-1));
    const during = calls.filter(c => c.start >= t0 && c.end <= t1);
    assert.equal(existsSync(lane), false);
    assert.ok(during.length >= 3, `answers while the folder was deleted: ${during.length}`);
    assert.ok(during.every(c => c.code === 0));
    const worst = Math.max(...during.map(c => c.end - c.start));
    t.diagnostic(`${during.length} answers during a ${t1 - t0} ms blocked deletion; slowest ${worst} ms`);
    assert.ok(worst < 1000, `slowest relay answer during the deletion ${worst} ms`);
  } finally {
    broker.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('meter: a stream that closes before the project shows up refuses; an early close voids', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { convexMeter } = await import('../scripts/bench-t3code/meter.mjs');
  const fake = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    return child;
  };
  let child;
  const meter = convexMeter({
    deployment: 'd',
    projectId: 'p',
    name: 'n',
    cwd: '.',
    spawnLogs: () => (child = fake()),
  });
  child.stdout.write('{"kind":"Completion","timestamp":1}\n');
  child.emit('close', 1);
  await assert.rejects(
    meter.ready(async () => {}, 10_000),
    /BENCH_METER_CLOSED/,
  );
  const report = meter.stop();
  assert.equal(report.valid, false);
  assert.ok(report.problems.some(p => p.startsWith('stream closed early')));
  const silent = convexMeter({ deployment: 'd', projectId: 'p', name: 'n', cwd: '.', spawnLogs: fake });
  assert.equal(silent.stop().valid, false, 'no log lines is never a zero cost');
});

test('harness scripts: script and main bodies never use const or let above its declaration (TDZ crash)', () => {
  // These scripts run at entry, so a use before a script/main `const` only fails mid-cell
  // (2026-11-01: run-cell crashed at grading on `batchBarrier`). Parse and check statically.
  const isFunction = n =>
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessor(n) ||
    ts.isSetAccessor(n);
  for (const name of ['run-cell.mjs', 'drive.mjs', 'preflight.mjs']) {
    const file = join(import.meta.dirname, '../scripts/bench-t3code', name);
    const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const scopes = [
      src.statements,
      ...src.statements
        .filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'main' && n.body)
        .map(n => n.body.statements),
    ];
    for (const statements of scopes) {
      const declaredAt = new Map();
      statements.forEach((st, index) => {
        if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.BlockScoped)
          for (const d of st.declarationList.declarations)
            if (ts.isIdentifier(d.name) && !declaredAt.has(d.name.text)) declaredAt.set(d.name.text, index);
      });
      statements.forEach((st, index) => {
        const visit = n => {
          if (isFunction(n) || ts.isImportDeclaration(n)) return; // functions run later, when called
          const nameOnly =
            (n.parent?.name === n &&
              !ts.isShorthandPropertyAssignment(n.parent) &&
              !ts.isVariableDeclaration(n.parent)) ||
            n.parent?.propertyName === n;
          if (ts.isIdentifier(n) && declaredAt.get(n.text) > index && !nameOnly) {
            const { line } = src.getLineAndCharacterOfPosition(n.getStart());
            assert.fail(`${name}:${line + 1} uses ${n.text} before its declaration`);
          }
          ts.forEachChild(n, visit);
        };
        visit(st);
      });
    }
  }
});
