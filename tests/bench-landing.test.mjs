// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finishPhases,
  finishUntilLanded,
  githubCheckTimes,
  parseProgressLine,
  percentile,
  renderMarkdown,
  repoName,
  runRecordTimes,
  scenarioEdits,
  summarize,
  withDocsMarker,
} from '../scripts/bench-landing-lib.mjs';
import { parseArgs, plan } from '../scripts/bench-landing.mjs';

const op = 'operation=e70240fb-df34-4eef-ac47-41c617c253bf';
const run = 'run=eff75df6-3104-5e61-b605-805cee30023e';
// Shapes copied from a real finish stderr (identifiers are synthetic).
const FIXTURE = [
  [
    500,
    `waiting for lock: ${op} waiting for compose by Agent workflow (pid 80563) (started 8s ago) phase=finish; queue position=2;  elapsed=0s`,
  ],
  [2000, `preparing finish: ${op} queue position=1 holder=this operation elapsed=0s`],
  [3000, `queued for check: ${op} ${run} queue position=2 holder=pid 9 phase=running elapsed=0s totalAge=3s`],
  [9000, `running check: ${op} ${run} queue position=1 holder=pid 96523 phase=running elapsed=5s`],
  [14000, `running check: ${op} ${run} queue position=1 holder=pid 96523 phase=running elapsed=10s`],
  [20000, `landing: ${op} ${run} queue position=1 holder=this operation elapsed=13s`],
  [20001, `landing: ${op} ${run} queue position=1 holder=this operation elapsed=13s`],
].map(([atMs, line]) => ({ atMs, line }));

test('parses text, JSON and non-progress lines', () => {
  assert.deepEqual(parseProgressLine(FIXTURE[3].line), {
    phase: 'running check',
    elapsedS: 5,
    operation: 'e70240fb-df34-4eef-ac47-41c617c253bf',
    run: 'eff75df6-3104-5e61-b605-805cee30023e',
    details: 'queue position=1 holder=pid 96523 phase=running',
  });
  assert.equal(parseProgressLine(FIXTURE[2].line).totalAgeS, 3);
  assert.equal(parseProgressLine(FIXTURE[0].line).phase, 'waiting for lock');
  assert.equal(parseProgressLine('{"phase":"landing","elapsedS":2}').phase, 'landing');
  assert.equal(parseProgressLine('npm warn deprecated something'), null);
  assert.equal(parseProgressLine('{"not":"progress"}'), null);
  assert.equal(parseProgressLine('{broken'), null);
});

test('splits finish wall time into phases by line arrival', () => {
  const phases = finishPhases(FIXTURE, 0, 21000);
  assert.deepEqual(phases, {
    prepare: 500 + 1000,
    queueWait: 1500 + 6000,
    check: 11000,
    landing: 1000,
    retry: 0,
    other: 0,
  });
  assert.equal(
    Object.values(phases).reduce((a, b) => a + b),
    21000,
  );
  // Out-of-order and early/late stamps are clamped into [start, end].
  assert.deepEqual(finishPhases([...FIXTURE].reverse(), 1000, 15000), {
    prepare: 1000,
    queueWait: 7000,
    check: 6000,
    landing: 0,
    retry: 0,
    other: 0,
  });
  assert.equal(finishPhases([], 0, 4000).prepare, 4000);
  assert.equal(finishPhases([{ atMs: 10, line: 'finish retry: {"x":1} elapsed=0s' }], 0, 50).retry, 40);
});

test('reads runner and GitHub check timestamps', () => {
  assert.deepEqual(
    runRecordTimes({
      queuedAt: '2026-10-17T04:34:58.726Z',
      startedAt: '2026-10-17T04:34:58.977Z',
      endedAt: '2026-10-17T04:35:05.743Z',
    }),
    { runQueueMs: 251, runCheckMs: 6766 },
  );
  assert.deepEqual(runRecordTimes({}), { runQueueMs: null, runCheckMs: null });
  const rows = [
    {
      name: 'check',
      state: 'SUCCESS',
      startedAt: '2026-10-17T05:00:10Z',
      completedAt: '2026-10-17T05:02:10Z',
    },
    {
      name: 'extra',
      state: 'SKIPPED',
      startedAt: '0001-01-01T00:00:00Z',
      completedAt: '0001-01-01T00:00:00Z',
    },
  ];
  assert.deepEqual(githubCheckTimes(rows), { registered: true, done: true, passed: true, checkMs: 120000 });
  assert.equal(githubCheckTimes([{ ...rows[0], state: 'IN_PROGRESS' }]).done, false);
  assert.equal(githubCheckTimes([{ ...rows[0], state: 'FAILURE' }]).passed, false);
  assert.deepEqual(githubCheckTimes([]), { registered: false, done: false, passed: false, checkMs: null });
});

test('median and p90 use nearest rank; failed samples are excluded', () => {
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([], 50), null);
  const samples = [1000, 3000, 2000].map((total, i) => ({
    side: 'forge',
    scenario: 'docs',
    run: i + 1,
    status: 'ok',
    phases: { total },
  }));
  samples.push({
    side: 'forge',
    scenario: 'docs',
    run: 4,
    status: 'failed',
    error: 'finish ended failed',
    phases: {},
  });
  assert.deepEqual(summarize(samples), [
    { side: 'forge', scenario: 'docs', phase: 'total', n: 3, medianMs: 2000, p90Ms: 3000 },
  ]);
  const markdown = renderMarkdown({
    startedAt: 'T',
    environment: {
      cpus: 10,
      memoryGiB: 16,
      platform: 'darwin',
      loadStart: ['1.00'],
      forgeRunner: 'local',
      githubRunner: 'gh',
      githubVisibility: 'private',
    },
    setup: { forge: { mode: 'throwaway native owner' }, github: { repo: 'me/forge-bench-20261017' } },
    samples,
  });
  assert.match(markdown, /\| forge \| docs \| total \| 3 \| 2\.0 \| 3\.0 \|/);
  assert.match(markdown, /forge docs #4: finish ended failed/);
});

test('scenario edits are deterministic and sized as specified', () => {
  assert.deepEqual(Object.keys(scenarioEdits('docs', 't')), ['docs/development.md']);
  assert.equal(Object.keys(scenarioEdits('code', 't')).length, 2);
  assert.equal(Object.keys(scenarioEdits('multi', 't')).length, 5);
  const once = withDocsMarker('# Dev\n\nText.\n', 'aaaa');
  assert.equal(once, '# Dev\n\nText.\n\n<!-- forge-bench: aaaa -->\n');
  assert.equal(withDocsMarker(once, 'bbbb'), '# Dev\n\nText.\n\n<!-- forge-bench: bbbb -->\n');
  const code = scenarioEdits('code', 'tok');
  assert.match(code['src/bench-probe.ts'](), /export const BENCH_PROBE = 'tok';/);
  assert.match(code['tests/bench-probe.test.mjs'](), /from '\.\.\/dist\/bench-probe\.js'/);
  assert.throws(() => scenarioEdits('huge', 't'), /Unknown scenario/);
  assert.equal(repoName(new Date('2026-10-17T12:00:00Z')), 'forge-bench-20261017');
});

test('arguments are validated and the dry-run plan names every step', () => {
  assert.throws(() => parseArgs([]), /--source/);
  assert.throws(() => parseArgs(['--source', '/x', '--runs', '2']), /at least 3/);
  assert.throws(() => parseArgs(['--source', '/x', '--scenarios', 'docs,big']), /Scenarios/);
  assert.throws(() => parseArgs(['--source', '/x', '--nope']), /Unknown option/);
  const options = parseArgs(['--source', '/x', '--dry-run', '--work', '/tmp/w']);
  const steps = plan(options, {
    forge: { mode: 'throwaway', root: '/tmp/w/forge-owner' },
    github: { repo: 'me/forge-bench-20261017', clone: '/tmp/w/github-clone' },
  });
  assert.equal(steps.filter(step => /^forge (docs|code|multi) #/.test(step)).length, 9);
  assert.equal(steps.filter(step => /^github (docs|code|multi) #/.test(step)).length, 9);
  assert.ok(steps.some(step => step.includes('gh repo create me/forge-bench-20261017 --private')));
  assert.equal(steps.at(-1), 'no cleanup (pass --cleanup)');
});

test('pair presets, runner policy and validated burst sizes', async () => {
  const { PAIRS, runnerPolicy } = await import('../scripts/bench-landing-v2.mjs');
  for (const pair of Object.keys(PAIRS)) {
    const o = parseArgs(['--source', '/does-not-exist', '--pair', pair, '--dry-run', '--burst', '4,8']);
    assert.deepEqual(o.burst, [4, 8]);
    assert.equal(o.ghShards, pair === 'P3' ? 16 : 1);
    if (pair === 'P4') assert.deepEqual(o.sides, ['github']);
    const steps = plan(o, { github: { repo: `me/test-${pair}`, clone: '/tmp/clone' } });
    assert.ok(steps.some(s => s.startsWith('BURST 4:')));
    assert.ok(steps.some(s => s.startsWith('BURST 8:')));
  }
  const o = parseArgs([
    '--source',
    '/x',
    '--pair',
    'P1',
    '--gh-shards',
    '8',
    '--forge-runs-on',
    'custom',
    '--gh-merge-queue',
  ]);
  assert.deepEqual(runnerPolicy(o, 'me/test'), {
    checks: { runner: 'github-actions', repo: 'me/test', runsOn: 'custom', shards: 8 },
  });
  for (const args of [
    ['--gh-shards', '0'],
    ['--gh-shards', '1.5'],
    ['--burst', '4,no'],
    ['--burst', ''],
    ['--forge-runner', 'other'],
    ['--pair', 'P5'],
  ])
    assert.throws(() => parseArgs(['--source', '/x', ...args]));
});

test('generated workflows pin selection and run matrix plus static contracts', async () => {
  const { githubWorkflow } = await import('../scripts/bench-landing-workflow.mjs');
  const single = githubWorkflow();
  assert.match(single, /bench-landing-shard.mjs static 1/);
  assert.match(single, /shard: \[0\]/);
  assert.match(single, /needs: \[static, tests\]/);
  const matrix = githubWorkflow({ ghRunsOn: 'blacksmith-custom', ghShards: 4 });
  assert.match(matrix, /runs-on: "blacksmith-custom"/);
  assert.match(matrix, /shard: \[0, 1, 2, 3\]/);
  assert.match(matrix, /bench-landing-shard.mjs static 4/);
  assert.match(matrix, /bench-landing-shard.mjs \$\{\{ matrix.shard \}\} 4/);
  assert.match(matrix, /FORGE_CHECK_SCOPED: '1'/);
  assert.match(matrix, /merge_group/);
  assert.match(matrix, /branches: \[main\]/);
});

test('burst timing and cost fixtures retain unknown observations', async () => {
  const { burstMetrics, actionsCost } = await import('../scripts/bench-landing-v2.mjs');
  const changes = [2000, 4000].map(landedAt => ({
    status: 'ok',
    landedAt,
    checksRun: 2,
    redMain: 0,
    retries: 1,
  }));
  assert.deepEqual(burstMetrics(changes, 1000), {
    allLandedMs: 3000,
    landingsPerHour: 2400,
    checksRun: 4,
    redMain: 0,
    retries: 2,
  });
  assert.equal(burstMetrics([...changes, { status: 'failed' }], 1000).allLandedMs, null);
  assert.equal(burstMetrics([{ ...changes[0], redMain: null }], 1000).redMain, null);
  assert.deepEqual(
    actionsCost(
      { billable: { UBUNTU: { total_ms: 120000 } } },
      [{ started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:01:01Z' }],
      'blacksmith-custom',
    ),
    { actionsBillableMinutes: 2, blacksmithMinutes: 2 },
  );
  assert.deepEqual(actionsCost(null, null, 'ubuntu-latest'), {
    actionsBillableMinutes: null,
    blacksmithMinutes: null,
  });
  const a = Object.keys(scenarioEdits('code', 'a', 0)),
    b = Object.keys(scenarioEdits('code', 'b', 1));
  assert.equal(a.filter(p => b.includes(p)).length, 0);
  assert.match(scenarioEdits('code', 'a', 0)[a[1]](), /bench-probe-burst-0/);
});

test('dry-run cannot invoke gh or nforge, even without a source on disk', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const pair of ['P1', 'P2', 'P3', 'P4']) {
    const out = execFileSync(
      process.execPath,
      [
        'scripts/bench-landing.mjs',
        '--source',
        '/does-not-exist',
        '--pair',
        pair,
        '--dry-run',
        '--burst',
        '4,8',
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent', NFORGE: '/nonexistent/nforge' } },
    );
    const report = JSON.parse(out);
    assert.equal(report.dryRun, true);
    assert.match(report.setup.github.repo, new RegExp(`^<login>/forge-bench-\\d{8}-${pair.toLowerCase()}$`));
    assert.equal(report.setup.github.visibility, 'private');
    assert.match(report.workflow, /Scoped check/);
  }
});

test('finishUntilLanded keeps waiting while queued, replays with resolved pins, and does not fail', async () => {
  const bodies = [];
  const replies = [
    { status: 'waiting to land', terminal: false, resolved: { operationId: 'op-1' } },
    { status: 'waiting to land', terminal: false, resolved: { operationId: 'op-1' } },
    { status: 'accepted', terminal: true, complete: true },
  ];
  let clock = 0;
  const { result, replays } = await finishUntilLanded(
    async body => (bodies.push(body), replies.shift()),
    { laneId: 'lane', accept: true },
    { sleep: async ms => void (clock += ms), now: () => clock, pollMs: 10 },
  );
  assert.equal(result.status, 'accepted');
  assert.equal(replays, 2);
  assert.deepEqual(bodies[2], { laneId: 'lane', accept: true, operationId: 'op-1' });
  assert.equal(bodies[0].operationId, undefined);
});

test('finishUntilLanded returns a rejection as is and bounds an endless wait', async () => {
  const failed = await finishUntilLanded(async () => ({ status: 'failed', terminal: true }), {});
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.replays, 0);
  let clock = 0;
  await assert.rejects(
    finishUntilLanded(
      async () => ({ status: 'waiting to land', terminal: false }),
      {},
      { sleep: async ms => void (clock += ms), now: () => clock, pollMs: 1000, limitMs: 3000 },
    ),
    /still waiting to land/,
  );
});
