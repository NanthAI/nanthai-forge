// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Bench regression guards from bench night 2026-11-18 (Item 368ac54f): each test replays the bug
// that reached the bench, against synthetic data. No bench, service or GitHub call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinProblems } from '../scripts/bench-t3code/versions.mjs';
import { cellChecks } from '../scripts/bench-t3code/cell-checks.mjs';
import { summarizeCell, comparisonRefusal } from '../scripts/bench-t3code/scenario-report.mjs';
import {
  cellOutcome,
  orphanResult,
  rerunDecision,
  signalVoid,
  VOID_INFRASTRUCTURE,
} from '../scripts/bench-t3code/cell-outcome.mjs';
import { runCell } from '../scripts/bench-t3code/cell.mjs';
import { SCENARIOS, FORMAT_DEBT_CHECK, formatDebtForgeJson } from '../scripts/bench-t3code/scenarios.mjs';
import { staticChecks, runStaticChecks } from '../dist/agent-preflight-static.js';

const temp = (t, name) => {
  const dir = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const PATH = process.env.PATH;

// ---- Harness pin gate: one null GitHub read refused cell withdraw-join 20261118T151002.

/** A `gh` on PATH that answers each call with the next scripted reply: a status, '' (an empty
 * read), 404 (GitHub does not know the commit) or 502 (an unreadable read). */
function fakeGh(t, replies) {
  const bin = temp(t, 'fake-gh-');
  const queue = join(bin, 'replies');
  writeFileSync(queue, replies.join('\n') + '\n');
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nreply=$(head -n 1 '${queue}')\ntail -n +2 '${queue}' > '${queue}.next' && mv '${queue}.next' '${queue}'\necho "call:$reply" >> '${bin}/calls'\ncase "$reply" in\n  404) echo 'gh: Not Found (HTTP 404)' >&2; exit 1;;\n  502) echo 'gh: Bad Gateway (HTTP 502)' >&2; exit 1;;\n  *) printf '%s\\n' "$reply";;\nesac\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  t.after(() => (process.env.PATH = PATH));
  return () =>
    existsSync(join(bin, 'calls'))
      ? readFileSync(join(bin, 'calls'), 'utf8').split('\n').filter(Boolean).length
      : 0;
}
const harness = { commit: '70c7347ca38d'.padEnd(40, '0'), clean: true, laneRoot: false };
const noWait = { sleep: async () => {}, backoff: [5, 15, 40] };

test('pin gate: a null or unreadable GitHub read is retried, and the harness on main passes', async t => {
  const calls = fakeGh(t, ['', '502', 'ahead']);
  assert.deepEqual(await pinProblems(harness, noWait), []);
  assert.equal(calls(), 3, 'read again after the empty and the failed reply');
});

test('pin gate: only a definite answer refuses as not on main, at once', async t => {
  for (const answer of ['behind', 'diverged', '404']) {
    const calls = fakeGh(t, [answer]);
    const problems = await pinProblems(harness, noWait);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /is not on GitHub main \((behind|diverged|missing)\)/);
    assert.equal(calls(), 1, `${answer} is not retried`);
  }
});

test('pin gate: still unreadable after the bounded retries refuses as unverified, never "not on main"', async t => {
  const calls = fakeGh(t, ['', '502', '', '502', 'ahead']);
  const waits = [];
  const problems = await pinProblems(harness, { sleep: async s => waits.push(s), backoff: [5, 15, 40] });
  assert.equal(calls(), 4, 'four reads, then it stops');
  assert.deepEqual(waits, [5, 15, 40]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unverified: GitHub compare unreadable after 4 reads/);
  assert.doesNotMatch(problems[0], /is not on GitHub main/);
});

// ---- Guard 1: a landing refused locally for a file it did not change fails the cell (060fb653).

const lanes = new Map([
  ['lane-1', new Set(['.bench/dry/t1.md', '.bench/dry/group-g.md'])],
  ['lane-2', new Set(['.bench/dry/t2.md'])],
]);
const laneOf = call => ({ t1: 'lane-1', t2: 'lane-2' })[call.task];
const staticRefusal = files => ({
  code: 'PREFLIGHT_REQUIRED',
  message: `Inline preflight failed static checks for saved head 0123456789ab. fmt:check (${files.join(', ')}): format error. Fix the reported files, then rerun: npm run fmt:check. Fix the reported files, save, then run land --save with the same options and a fresh operationId.`,
});

test('guard 1: a local refusal naming a file the landing did not change fails the cell; its own file does not', () => {
  const foreign = cellChecks(
    [{ task: 't1', code: 1, errorCodes: ['PREFLIGHT_REQUIRED'], error: staticRefusal(['.bench/ci.sh']) }],
    lanes,
    laneOf,
  );
  assert.deepEqual(foreign.localFailures, [
    'refused locally for a file it did not change: t1 (.bench/ci.sh)',
  ]);
  const metadata = cellChecks(
    [{ task: 't2', code: 1, error: staticRefusal(['.forge/hosted-lane.json']) }],
    lanes,
    laneOf,
  );
  assert.equal(metadata.localFailures.length, 1, "Forge's own Lane metadata is never the landing's file");
  const own = cellChecks(
    [{ task: 't1', code: 1, error: staticRefusal(['.bench/dry/t1.md']) }],
    lanes,
    laneOf,
  );
  assert.deepEqual(own.localFailures, []);
  assert.equal(own.local.refusals, 1);
});

test('guard 1: the format-debt scenario declares a whole-tree check covering .forge/ that main already fails', t => {
  assert.deepEqual(SCENARIOS['format-debt'].paths, []);
  const forgeJson = formatDebtForgeJson(null, JSON.stringify({ scripts: { 'fmt:check': 'true' } }));
  assert.deepEqual(
    JSON.parse(forgeJson).preflight.static.map(c => c.name ?? c),
    ['fmt:check', FORMAT_DEBT_CHECK.name],
    'the conventional format check keeps running beside the debt check',
  );
  assert.equal(formatDebtForgeJson(forgeJson, '{}'), forgeJson, 'applying the layer twice changes nothing');
  assert.deepEqual(
    SCENARIOS['format-debt'].baseLayer(path => (path === 'package.json' ? '{}' : null)),
    {
      'forge.json': formatDebtForgeJson(null, '{}'),
    },
  );

  const root = temp(t, 'format-debt-');
  const write = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('package.json', '{}\n');
  write('forge.json', formatDebtForgeJson(null, '{}'));
  write('.bench/ci.sh', '#!/bin/sh\nexit 0\n');
  write('.bench/dry/t1.md', 'dry run t1\n');
  write('.forge/hosted-lane.json', '{"selection":{}}\n');
  const checks = staticChecks('{}', formatDebtForgeJson(null, '{}'));
  assert.deepEqual(
    checks.map(c => c.name),
    [FORMAT_DEBT_CHECK.name],
  );
  const judged = changed => runStaticChecks(root, checks, process.env, 10_000, { changed })[0];
  // The layer landing (forge.json) and an agent's dry edit: the debt is main's, never theirs.
  for (const changed of [['forge.json'], ['.bench/dry/t1.md']]) {
    const result = judged(changed);
    assert.notEqual(result.outcome, 'failed', `${changed} is refused for debt it did not add`);
    assert.notEqual(result.outcome, 'passed', 'the debt is really there');
  }
  // A change that edits a debt file owns that failure.
  assert.equal(judged(['.bench/ci.sh']).outcome, 'failed');
});

// ---- Guard 3: SYNC_REQUIRED replies per landing, and false marks (incident 36fd3295).

const syncMark = files => ({
  code: 'SYNC_REQUIRED',
  message: `SYNC REQUIRED; not landed: main changed ${files.length} file(s) this queued landing also changes (${files.join(', ')})`,
});

test('guard 3: the report counts SYNC_REQUIRED per landing and fails the cell on a same-bytes mark', () => {
  const result = {
    cellId: 'forge-n10-r1-dry-a1',
    landed: 2,
    scenario: { name: 'smoke' },
    order: ['t22302', 't26563'],
    records: [
      { task: 't22302', laneId: 'lane-a' },
      { task: 't26563', laneId: 'lane-b' },
    ],
  };
  // t22302 resolved early on top of t26563 and carries its files; t26563 landing marked it.
  const loop = Array.from({ length: 3 }, () => ({
    task: 't22302',
    code: 1,
    errorCodes: ['SYNC_REQUIRED'],
    error: syncMark(['.bench/dry/group-same-package-shared.md', '.bench/dry/t26563.md']),
  }));
  const row = summarizeCell(result, [], loop);
  assert.deepEqual(row.syncRequired, { replies: 3, perLanding: { t22302: 3 }, falseMarks: 3, unjudged: 0 });
  assert.deepEqual(row.failed, ['3 false SYNC_REQUIRED mark(s) (same bytes): t22302']);

  // A real mark names a file the landing wrote itself: counted, not false.
  const real = summarizeCell(
    result,
    [],
    [{ task: 't22302', code: 1, error: syncMark(['.bench/dry/t22302.md']) }],
  );
  assert.deepEqual(real.syncRequired, { replies: 1, perLanding: { t22302: 1 }, falseMarks: 0, unjudged: 0 });
  assert.deepEqual(real.failed, []);
  assert.deepEqual(summarizeCell(result, [], []).failed, []);
});

// ---- Guard 4: the compare step refuses unlike cells (comment 9d1c067b: N = 3 against N = 10).

const cell = (cellId, more = {}) => ({
  cellId,
  N: 10,
  dry: true,
  seed: 'b15d-rerun-2026-11-01/n10/r1',
  base: 'b'.repeat(40),
  scenario: { name: 'smoke', about: 'Unchanged dry run' },
  order: ['t1', 't2', 't3'],
  startedAt: '2026-11-18T04:20:45Z',
  records: [],
  ...more,
});

test('guard 4: comparing an N = 10 cell with an N = 3 cell is refused and names the matching accepted cell', () => {
  const fresh = cell('forge-n10-r1-dry-a1-20261118T042045');
  const accepted3 = cell('forge-n3-r1-dry-a9-20261115T105211', { N: 3, seed: 'b15d-rerun-2026-11-01/n3/r1' });
  const accepted10 = cell('forge-n10-r1-dry-a1-20261115T120716', { startedAt: '2026-11-15T12:07:16Z' });
  const voided = cell('forge-n10-r1-dry-a2-20261116T000000', { voided: ['harness crash'] });
  const refusal = comparisonRefusal([fresh, accepted3], [fresh, accepted3, accepted10, voided]);
  assert.match(
    refusal,
    /^BENCH_COMPARE_MISMATCH: forge-n3-r1-dry-a9-20261115T105211 differs from forge-n10-r1-dry-a1-20261118T042045 in N \(3 vs 10\), seed/,
  );
  assert.match(
    refusal,
    /forge-n10-r1-dry-a1-20261118T042045: compare with accepted cell forge-n10-r1-dry-a1-20261115T120716/,
  );
  // config.acceptedCells, when present, is the only source of accepted cells.
  assert.match(
    comparisonRefusal(
      [fresh, accepted3],
      [fresh, accepted3, accepted10],
      ['forge-n3-r1-dry-a9-20261115T105211'],
    ),
    /forge-n10-r1-dry-a1-20261118T042045: no accepted cell matches/,
  );
});

test('guard 4: base, scenario set and seed each refuse; switches and an unrecorded base do not', () => {
  const a = cell('a');
  for (const [field, b] of [
    ['base', cell('b', { base: 'c'.repeat(40) })],
    ['scenario', cell('b', { scenario: { name: 'withdraw-join', about: 'x' } })],
    ['scenario version', cell('b', { scenario: { name: 'smoke', about: 'v2' } })],
    ['task set', cell('b', { order: ['t1', 't2', 't9'] })],
    ['seed', cell('b', { seed: 'b15d-rerun-2026-11-01/n10/r2' })],
  ])
    assert.match(comparisonRefusal([a, b]), new RegExp(`in ${field} \\(`), field);
  assert.equal(
    comparisonRefusal([a, cell('b', { switches: { start: { FORGE_QUEUE_NEW_RUN_WAKE: true } } })]),
    null,
  );
  assert.equal(comparisonRefusal([a, cell('b', { base: undefined })]), null);
  assert.equal(
    comparisonRefusal([a, cell('b', { order: ['t3', 't1', 't2'] })]),
    null,
    "order is the seed's job",
  );
});

// ---- Guard 5: a cell stopped by a runner limit is void-infrastructure and rerun once.

test('guard 5: a signal or a vanished process is void-infrastructure; a harness crash is not rerun', () => {
  assert.equal(cellOutcome(signalVoid('SIGTERM')), VOID_INFRASTRUCTURE);
  assert.equal(signalVoid('SIGTERM').crashed, undefined, 'never recorded as crashed');
  assert.equal(cellOutcome(orphanResult({ cellId: 'c', key: 'k' })), VOID_INFRASTRUCTURE);
  const crash = { cellId: 'c1', crashed: 'TypeError', voided: ['harness crash: TypeError'] };
  assert.equal(cellOutcome(crash), 'crashed');
  assert.deepEqual(rerunDecision([crash]), { rerun: false });
  assert.deepEqual(rerunDecision([{ cellId: 'c2', ...signalVoid('SIGTERM') }]), {
    rerun: true,
    rerunOf: 'c2',
  });
});

/** A synthetic run-cell: each attempt writes cell.json, its id and the scripted outcome. */
function fakeCells(root, outcomes) {
  const ran = [];
  const execute = async (script, args, { env }) => {
    assert.equal(script, 'run-cell.mjs');
    const attempt = Number(args[args.indexOf('--attempt') + 1]);
    const cellId = `forge-n10-r1-withdraw-join-dry-a${attempt}`;
    ran.push(cellId);
    mkdirSync(join(root, 'runs', cellId), { recursive: true });
    writeFileSync(
      join(root, 'runs', cellId, 'cell.json'),
      JSON.stringify({ pid: 999_999, key: 'forge-n10-r1' }),
    );
    writeFileSync(env.BENCH_CELL_ID_OUT, cellId + '\n');
    const outcome = outcomes.shift();
    if (outcome !== 'gone')
      writeFileSync(join(root, 'runs', cellId, 'result.json'), JSON.stringify({ cellId, ...outcome }));
    return 0;
  };
  return { execute, ran };
}
const args = ['forge', '10', '1', '--dry', '--scenario', 'withdraw-join'];
const notAlive = () => false;

test('guard 5: one cell command reruns a runner-limit stop once, automatically', async t => {
  const root = temp(t, 'cell-rerun-');
  const { execute, ran } = fakeCells(root, [signalVoid('SIGTERM'), { landed: 10 }]);
  const log = [];
  await runCell(args, { root, execute, log: l => log.push(l), alive: notAlive });
  assert.equal(ran.length, 2);
  assert.match(
    log.join('\n'),
    /void-infrastructure: killed by SIGTERM[\s\S]*rerun of forge-n10-r1-withdraw-join-dry-a1[\s\S]*a2 complete/,
  );
});

test('guard 5: a command killed with its cell is rerun by the next identical command, and only once', async t => {
  const root = temp(t, 'cell-orphan-');
  // The runner limit took the whole command: the cell left no result.
  const first = fakeCells(root, ['gone']);
  await assert.rejects(
    runCell(args, { root, execute: first.execute, log: () => {}, alive: () => true }),
    /BENCH_CELL_RUNNING/,
    'a cell whose process still runs is never closed',
  );
  const log = [];
  const again = fakeCells(root, ['gone', 'gone']);
  await runCell([...args, '--attempt', '7'], {
    root,
    execute: again.execute,
    log: l => log.push(l),
    alive: notAlive,
  });
  assert.deepEqual(again.ran, ['forge-n10-r1-withdraw-join-dry-a2'], 'the rerun, and no third attempt');
  assert.match(log.join('\n'), /rerun of forge-n10-r1-withdraw-join-dry-a1/);
  assert.match(log.join('\n'), /CELL STOP two infrastructure stops in a row/);
  const closed = JSON.parse(
    readFileSync(join(root, 'runs', 'forge-n10-r1-withdraw-join-dry-a1', 'result.json'), 'utf8'),
  );
  assert.equal(cellOutcome(closed), VOID_INFRASTRUCTURE);
});
