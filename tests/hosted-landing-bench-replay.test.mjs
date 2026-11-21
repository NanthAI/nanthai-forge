// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { regressions, calibration } from './queue-sim/replay-gate.mjs';
import { checkedPackagePlacement } from '../dist/package-placement-pin.js';
import { pinnedPackagePlacement, placedRiskBetween } from '../dist/package-placement.js';
const directory = new URL('./fixtures/queue-traces/', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('baseline.json', directory)));
const traces = readdirSync(directory)
  .filter(name => /^n\d+-r\d+\.json$/.test(name))
  .map(name => JSON.parse(readFileSync(new URL(name, directory))));

// Owner split: retained model is not calibrated; further qualification waits for the real A/B.
test.skip('5e3c3a3c: benchmark replay waits for owner-approved N=10 real A/B', async t => {
  assert.equal(baseline.cells.length, traces.length, 'qualification requires every primary cell');
  const { synthetic } = await import('./hosted-landing-batches-fixture.mjs');
  const { replayTrace } = await import('./queue-sim/trace-driver.mjs');
  const environment = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-bench-regression' };
  const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const old = [],
    candidate = [];
  for (const trace of traces) {
    const cell = baseline.cells.find(cell => cell.N === trace.N && cell.rep === trace.rep);
    assert.equal(cell?.resultSha256, trace.resultSha256, 'baseline belongs to these exact inputs');
    const observed = Object.fromEntries(
      ['timeToMainMedianSeconds', 'wallSeconds', 'ciBilledMinutes', 'recomposes'].map(metric => [
        metric,
        trace.observed[metric],
      ]),
    );
    assert.deepEqual(
      calibration(observed, cell.replay),
      [],
      'old rules must be predictive before qualification',
    );
    await t.test(`N=${trace.N} rep=${trace.rep}`, async cellTest => {
      old.push({ N: trace.N, ...cell.replay });
      candidate.push({ N: trace.N, ...(await replayTrace(cellTest, trace)) });
    });
  }
  const perN = rows =>
    [...new Set(rows.map(row => row.N))]
      .sort((a, b) => a - b)
      .map(N => {
        const cells = rows.filter(row => row.N === N);
        return {
          N,
          ...Object.fromEntries(
            Object.keys(cells[0])
              .filter(metric => metric !== 'N')
              .map(metric => {
                const values = cells.map(cell => cell[metric]).sort((a, b) => a - b);
                return [metric, values[Math.floor(values.length / 2)]];
              }),
          ),
        };
      });
  const before = perN(old),
    after = perN(candidate),
    failures = regressions(before, after);
  t.diagnostic(JSON.stringify({ before, after, failures }));
  assert.deepEqual(
    failures,
    [],
    'STOP: report per-N table and responsible rule to lead; do not tune the baseline',
  );
});

test('accepted primary benchmark traces retain all 12 cells and preserve missing inputs explicitly', () => {
  assert.deepEqual(
    traces.map(t => `${t.N}/${t.rep}`).sort(),
    [1, 3, 5, 10].flatMap(N => [1, 2, 3].map(rep => `${N}/${rep}`)).sort(),
  );
  for (const trace of traces) {
    assert.equal(trace.tasks.length, 10);
    assert.match(trace.resultSha256, /^[a-f0-9]{64}$/);
    const encoded = JSON.stringify(trace);
    assert(
      !/\/Users\/|\/private\/|https:\/\/|sessionId|codexHome|agentRun/.test(encoded),
      'trace contains only public-safe numeric metadata and task paths',
    );
  }
});

test('replay gate rejects any worse metric at any N and never treats a missing result as zero', () => {
  const old = [
    {
      N: 1,
      timeToMainMedianSeconds: 10,
      timeToMainP90Seconds: 12,
      wallSeconds: 20,
      ciBilledMinutes: 3,
      recomposes: 1,
    },
  ];
  assert.deepEqual(regressions(old, structuredClone(old)), []);
  for (const metric of Object.keys(old[0]).filter(key => key !== 'N')) {
    const next = structuredClone(old);
    next[0][metric]++;
    assert.equal(regressions(old, next)[0].metric, metric);
  }
  assert(regressions(old, []).length);
  assert(regressions(old, [{ N: 1 }]).length);
});

test('uncalibrated old rules cannot qualify a comparison or replace the observed floor', () => {
  const observed = { timeToMainMedianSeconds: 100, wallSeconds: 200, ciBilledMinutes: 10, recomposes: 2 };
  assert.deepEqual(calibration(observed, { ...observed }), []);
  assert(calibration(observed, { ...observed, wallSeconds: 230 }).length);
  assert(calibration(observed, { ...observed, recomposes: 4 }).length);
  assert(calibration(observed, { ...observed, ciBilledMinutes: null }).length);
});

test('standalone placement may change only a queue pair with a path under a certified folder', () => {
  const dir = '.repos/vendor';
  const manifest = dir + '/package.json';
  const tree = {
    'package.json': '{"name":"root","scripts":{"test":"node --test"}}',
    'package-lock.json': '{}',
    'apps/pinned/package.json': '{"name":"pinned"}',
    'apps/pinned/package-lock.json': '{}',
    [manifest]: '{}',
  };
  const pin = settings => checkedPackagePlacement(Object.keys(tree), path => tree[path], settings);
  const off = pin(undefined);
  const on = pin({ checkEntries: [], commandLines: [] });
  const baseline = pinnedPackagePlacement({
    packagePlacement: {
      rule: 'package-placement-v2',
      packages: [
        ['js', '', 0, 1, []],
        ['js', 'apps/pinned', 0, 0, []],
      ],
      unresolved: [],
    },
  });
  const offGraph = pinnedPackagePlacement(off),
    onGraph = pinnedPackagePlacement(on);
  const standalone = on.packagePlacement.packages.filter(row => row[5] === 1).map(row => row[1]);
  assert.deepEqual(standalone, [dir]);
  let pairs = 0;
  const compare = (candidate, main) => {
    const previous = placedRiskBetween(candidate, main, [], baseline);
    const disabled = placedRiskBetween(candidate, main, [], offGraph);
    assert.deepEqual(disabled, previous);
    const enabled = placedRiskBetween(candidate, main, [], onGraph);
    if (![...candidate, ...main].some(path => standalone.some(folder => path.startsWith(folder + '/'))))
      assert.deepEqual(enabled, previous);
    return enabled;
  };
  for (const { tasks } of traces)
    for (const candidate of tasks)
      for (const main of tasks) {
        if (candidate === main || !candidate.paths?.length || !main.paths?.length) continue;
        compare(candidate.paths, main.paths);
        pairs++;
      }
  assert(pairs > 0, 'retained bench task paths exercised the guard');
  assert.deepEqual(compare([manifest], ['apps/pinned/module.ts']), [
    { path: manifest, reach: ['js:' + dir], standalone: 'js-non-member' },
  ]);
});
