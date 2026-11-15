// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, gains, quantile } from '../scripts/bench-t3code/stats-math.mjs';
import { readSeries, readB15dReport } from '../scripts/bench-t3code/stats-data.mjs';
import { runRework } from '../scripts/bench-t3code/rework.mjs';
import { buildReport, main } from '../scripts/bench-t3code/stats.mjs';
import { render } from '../scripts/bench-t3code/stats-render.mjs';
import { headlineRows } from '../scripts/bench-t3code/stats-overview.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-bench-stat-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  const cell = (id, overrides = {}, directory = id) => {
    const records = [10, 30, 80].map((seconds, i) => ({
      task: `t${i}`,
      timeToMainSeconds: seconds,
      prepSeconds: i + 1,
      landing: { landed: true },
    }));
    const result = {
      cellId: id,
      arm: 'forge',
      N: 3,
      rep: 1,
      attempt: 1,
      voided: [],
      records,
      landed: 3,
      wallSecondsToAllLanded: 120,
      tokens: {
        inputTokens: 9,
        cacheReadInputTokens: 90,
        cacheCreationInputTokens: 0,
        outputTokens: 6,
        numTurns: 3,
      },
      ci: { billedMinutes: 6, jobs: 3 },
      oracle: { grade: { strictSuccess: 2 } },
      rework: { sums: { reworkTurns: 999 } },
      ...overrides,
    };
    put(`runs/${directory}/result.json`, result);
    for (const record of result.records ?? []) {
      const file = join(root, 'runs', directory, 'agents', `${record.task}.transcript.jsonl`);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg',
            content: [{ type: 'text', text: 'implement' }],
            usage: { input_tokens: 3, cache_read_input_tokens: 30, output_tokens: 2 },
          },
        }) + '\n',
      );
    }
    return result;
  };
  const batch = (ids, voided = [], name = ids.join('-')) =>
    put(`batches/${name}/batch.json`, { cells: ids.map(cellId => ({ cellId })), voided });
  return { root, put, cell, batch };
}

test('descriptive statistics retain unequal extrema, midpoint median and arithmetic mean without missing-as-zero', () => {
  assert.deepEqual(describe([2, 4, 9, 25, null, NaN]), { n: 4, min: 2, max: 25, mean: 10, median: 6.5 });
  assert.equal(quantile([10, 30, 80], 0.9), 70);
  assert.deepEqual(describe([]), { n: 0, min: null, max: null, mean: null, median: null });
});

test('gains preserve adverse floors, favorable ceilings, higher-is-better scores and zero-reference deltas', () => {
  const g = gains(describe([10, 20, 30]), describe([5, 15, 40]), 'wallSeconds');
  assert.equal(g.median.percent, 25);
  assert.equal(g.floor.percent, -300);
  assert.equal(g.ceiling.percent, (100 * 25) / 30);
  const higher = gains(describe([7, 10]), describe([8, 9]), 'landed');
  assert.equal(higher.floor.improvement, -2);
  assert.equal(higher.ceiling.improvement, 2);
  assert.deepEqual(gains(describe([0]), describe([3]), 'reworkTurns').median, {
    reference: 0,
    treatment: 3,
    improvement: -3,
    percent: null,
  });
});

test('batch void excludes both arms, independent of clean result flags and unrelated folder names', t => {
  const f = fixture(t);
  f.cell('forge-valid-id', {}, 'arbitrary-folder');
  f.cell('github-valid-id', { arm: 'github', voided: ['harness error on t0 /private/account-id'] });
  f.batch(['forge-valid-id', 'github-valid-id'], ['github void: harness error on t0 /private/account-id']);
  const s = readSeries([f.root], runRework);
  assert.equal(s.cells.length, 0);
  assert.equal(s.voided.length, 2);
  assert.ok(s.voided.every(c => c.batchVoided));
  assert.doesNotMatch(JSON.stringify(s), /private|account-id|arbitrary-folder/);
});

test('partial landing costs divide by actual successes, missing wall stays unknown, and rework is recomputed', t => {
  const f = fixture(t);
  const r = f.cell('partial', { landed: 2, wallSecondsToAllLanded: null });
  r.records[2].landing.landed = false;
  f.put('runs/partial/result.json', r);
  f.put('runs/partial/forge-metrics.json', {
    result: {
      totals: { finishToMain: { p50Minutes: 2, partial: true }, B: { reuseAcceptances: 1, partial: false } },
    },
  });
  f.batch(['partial']);
  const [c] = readSeries([f.root], runRework).cells;
  assert.equal(c.perLanding.ciBilledMinutes, 3);
  assert.equal(c.perCell.prepSeconds, 6);
  assert.equal(c.perCell.timeToMainMedianSeconds, 20);
  assert.equal(c.perCell.timeToMainMaxSeconds, 30);
  assert.equal(c.perLanding.wallSeconds, null);
  assert.equal(c.perCell.reworkTurns, 0);
  assert.equal(c.perCell.finishToMainP50Seconds, 120);
  assert.deepEqual(c.forgeMetrics.partial, { finishToMain: true, B: false });
});

test('missing transcript coverage never fabricates zero recovery', t => {
  const f = fixture(t);
  f.cell('missing');
  f.batch(['missing']);
  rmSync(join(f.root, 'runs/missing/agents/t1.transcript.jsonl'));
  const [c] = readSeries([f.root], runRework).cells;
  assert.equal(c.reworkCoverage.covered, 2);
  assert.equal(c.perCell.reworkTurns, null);
  assert.equal(c.perCell.reworkTokens, null);
});

test('task voids are excluded from registered timing while all-landed observations remain explicitly separate', t => {
  const f = fixture(t);
  f.cell('flagged', { taskVoids: ['t0', 't1', 't2'], quotaTasks: ['t0', 't1', 't2'] });
  f.batch(['flagged']);
  const s = readSeries([f.root], runRework);
  assert.equal(s.cells[0].perCell.timeToMainMedianSeconds, null);
  assert.equal(s.cells[0].perCell.observedTimeToMainMedianSeconds, 30);
  const g = buildReport([{ name: 'tuned', ...s }]).series[0].groups[0];
  assert.equal(g.pooledTimeToMain.n, 0);
  assert.equal(g.observedPooledTimeToMain.n, 3);
  assert.equal(g.observedPooledTimeToMain.p90, 70);
});

test('duplicate identities count once, conflicting bytes fail, and replay/stacking groups stay separate', t => {
  const f = fixture(t);
  const r = f.cell('scored');
  f.cell('auto', { coordinationCell: { kind: 'overlap', stack: 'auto' }, N: 8 });
  f.cell('offer', { coordinationCell: { kind: 'overlap', stack: 'offer' }, N: 8 });
  f.cell('replay', { diagnostic: { kind: 'conflict' }, N: 10 });
  f.batch(['scored', 'auto', 'offer', 'replay']);
  f.put('runs/copy/result.json', r);
  const s = readSeries([f.root, join(f.root, 'runs/scored')], runRework);
  assert.equal(s.cells.length, 4);
  const report = buildReport([{ name: 'tuned', ...s }]);
  assert.deepEqual(
    new Set(report.series[0].groups.map(g => `${g.kind}:${g.arm}`)),
    new Set(['scored:forge', 'overlap:forge-auto', 'overlap:forge-offer', 'replay-conflict:forge']),
  );
  f.put('runs/copy/result.json', { ...r, landed: 1 });
  assert.throws(() => readSeries([f.root], runRework), /Conflicting result bytes/);
});

test('dry, model-check and unbatched observations cannot leak into scored statistics', t => {
  const f = fixture(t);
  f.cell('dry', { dry: true });
  f.cell('model', { modelCheck: true });
  f.cell('unbatched');
  f.batch(['dry', 'model']);
  const s = readSeries([f.root], runRework);
  assert.equal(s.cells.length, 0);
  assert.equal(s.excluded.length, 3);
});

test('history compares common kind/N/arm only and pooled percentiles use task observations', t => {
  const f = fixture(t);
  f.cell('f1');
  f.cell('g1', { arm: 'github', wallSecondsToAllLanded: 240 });
  f.cell('f2', { rep: 2, wallSecondsToAllLanded: 60 });
  f.batch(['f1', 'g1', 'f2']);
  const current = readSeries([f.root], runRework);
  const earlier = { ...current, cells: current.cells.filter(c => c.cellId !== 'f2') };
  const report = buildReport([
    { name: 'tuned', ...current },
    { name: 'before', ...earlier },
  ]);
  const g = report.series[0].groups.find(g => g.arm === 'forge');
  assert.deepEqual(g.perCell.wallSeconds, { n: 2, min: 60, max: 120, mean: 90, median: 90 });
  assert.deepEqual(g.pooledTimeToMain, { n: 6, p50: 30, p90: 80, max: 80 });
  assert.equal(report.series[0].gains[0].pooledTimeToMainGains.p90.improvement, -10);
  assert.equal(report.history[0].comparisons.length, 2);
  assert.equal(report.history[0].comparisons[0].perCell.wallSeconds.median.percent, 25);
  const text = render(report);
  assert.doesNotMatch(text, new RegExp(f.root));
});

test('published B1.5d fallback marks rounded coverage and excludes the separate owner extra attempt', t => {
  const f = fixture(t);
  const path = join(f.root, 'published.md');
  writeFileSync(
    path,
    '| n3-r2 | 100 / 6 / 30 / 20 / $0.01 | 200 / 7 / 40 / 60 |\n| n3-r3 a2 (extra, see Deviation) | 50 / 6 / 20 / 10 | 100 / 7 / 30 / 40 |\n| n3-r1 a1 | void (network loss) | void |\n',
  );
  const s = readB15dReport(path);
  assert.equal(s.cells.length, 4);
  assert.equal(s.voided.length, 2);
  assert.equal(s.cells.filter(c => c.kind === 'scored').length, 2);
  assert.equal(s.cells.filter(c => c.kind === 'scored-owner-extra').length, 2);
  assert.match(s.coverage, /rounded/);
  assert.equal(s.cells[0].perCell.turns, null);
  assert.deepEqual(s.cells[0].taskTimes, []);
});

test('CLI writes deterministic public scalar artifacts without copying private source fields', async t => {
  const f = fixture(t);
  f.cell('public-cell', { versions: { account: 'private-account' }, extraField: '/private/bench-input' });
  f.batch(['public-cell']);
  const out = join(f.root, 'output/results');
  const args = ['--series', `tuned=${f.root}`, '--out', out];
  await main(args);
  const first = readFileSync(`${out}.json`, 'utf8');
  await main(args);
  assert.equal(readFileSync(`${out}.json`, 'utf8'), first);
  assert.doesNotMatch(first + readFileSync(`${out}.md`, 'utf8'), /private-account|\/private\/bench-input/);
  assert.equal(JSON.parse(first).series[0].cells.length, 1);
  assert.match(readFileSync(`${out}.md`, 'utf8'), /\[the JSON record\]\(results\.json\)/);
});

test('partial reruns replace complete N groups without pooling historical arms or repetitions', t => {
  const f = fixture(t);
  f.cell('old3', { N: 3 });
  f.cell('old10', { N: 10, wallSecondsToAllLanded: 1000 });
  f.cell('old-github10', { N: 10, arm: 'github', wallSecondsToAllLanded: 900 });
  f.cell('new10', { N: 10, wallSecondsToAllLanded: 750 });
  f.cell('new-github10', { N: 10, arm: 'github', wallSecondsToAllLanded: 1200 });
  f.batch(['old3', 'old10', 'old-github10', 'new10', 'new-github10']);
  const all = readSeries([f.root], runRework);
  const subset = prefix => ({ ...all, cells: all.cells.filter(c => c.cellId.startsWith(prefix)) });
  const report = buildReport(
    [
      { name: 'tuned', ...subset('old') },
      { name: 'rerun', ...subset('new') },
    ],
    { primary: 'rerun' },
  );
  const rows = headlineRows(report.series[1], [report.series[0]]);
  assert.deepEqual(
    rows.map(r => r.slice(0, 4)),
    [
      [3, 'forge', 'tuned', 1],
      [10, 'forge', 'rerun', 1],
      [10, 'github', 'rerun', 1],
    ],
  );
  assert.equal(rows[1][6], '750');
  const text = render(report);
  assert.match(text, /rerun \| Paired series \| 1200 \| 750 \| 450 \(37.5%\)/);
  assert.match(text, /tuned \| Historical reference \| 900 \| 750 \| 150 \(16.667%\)/);
  const missingArm = { ...report.series[1], groups: report.series[1].groups.filter(g => g.arm === 'forge') };
  assert.equal(headlineRows(missingArm, [report.series[0]]).filter(r => r[0] === 10).length, 1);
});

test('registered replay metadata retains late-task latency and zero model usage without copying source', t => {
  const f = fixture(t);
  f.cell('registered-replay', {
    N: 10,
    versions: {
      start: { cli: { build: '/private/fixture-build', commit: 'a'.repeat(64), git: 'b'.repeat(40) } },
    },
    diagnostic: {
      kind: 'replay-conflict',
      plan: {
        release: 'late-third',
        tasks: [{ id: 's10', releaseAtMs: 200000, edits: [{ path: '/private/fixture' }] }],
      },
    },
    modelTokens: 0,
    replay: { prepMs: 2000, elapsedMs: 800000 },
    records: [{ task: 's10', timeToMainSeconds: 500, recoveries: 2, landing: { landed: true } }],
  });
  f.batch(['registered-replay']);
  const input = readSeries([f.root], runRework);
  const cell = input.cells[0];
  assert.equal(cell.kind, 'replay-conflict');
  assert.equal(cell.sourcePins.cliState, 'a'.repeat(64));
  assert.equal(cell.sourcePins.cliCommit, 'b'.repeat(40));
  assert.deepEqual(cell.replay, {
    release: 'late-third',
    modelTokens: 0,
    prepSeconds: 2,
    protocolSeconds: 800,
    lateTasks: [{ task: 's10', releaseAtMs: 200000, timeToMainSeconds: 500, recoveries: 2 }],
  });
  const report = buildReport([{ name: 'rerun', ...input }]);
  const text = render(report);
  assert.match(
    text,
    /registered-replay \| forge \| replay-conflict \| late-third \| 2 \| 800 \| 120 \| s10 \| 500 \| 2 \| 0/,
  );
  assert.doesNotMatch(JSON.stringify(cell), /private|fixture/);
  assert.equal(headlineRows(report.series[0]).length, 0);
});

test('voided replay failures retain public codes without inventing valid tail times or copying errors', t => {
  const f = fixture(t);
  f.cell('void-replay', {
    N: 10,
    diagnostic: { kind: 'replay-conflict' },
    voided: ['harness error on s04'],
    records: [
      {
        task: 's04',
        harnessError: 'GH006 rejected /private/fixture notification-secret',
        landing: { landed: false },
      },
    ],
  });
  const input = readSeries([f.root], runRework);
  assert.deepEqual(input.voided[0].failureCodes, ['GH006']);
  assert.equal(input.voided[0].batchVoided, null);
  assert.equal(input.cells.length, 0);
  const report = buildReport([{ name: 'rerun', ...input }]);
  const text = render(report);
  assert.match(text, /Valid replay cells: 0; voided replay attempts: 1/);
  assert.match(text, /void-replay \| forge \| replay-conflict \| GH006/);
  assert.doesNotMatch(JSON.stringify(report), /notification-secret|private\/fixture/);
});
