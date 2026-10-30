// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { childEnv } from '../scripts/child-env.mjs';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import {
  joinMetricAuthority,
  metricAddress,
  readMetricRecords,
  hostedStatusMetrics,
} from '../dist/self-metrics-source.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { executeHostedMetrics } from '../dist/hosted-agent-metrics.js';
import { hostedAgentActions, hostedAgentOwnerActions } from '../dist/hosted-agent-contract.js';
import { readMetrics, metricsCli } from '../dist/metrics-cli.js';
import { agentCli } from '../dist/agent-cli.js';
import { initNative } from '../dist/native-work.js';
import { cleanupOwner } from './owner-cleanup.mjs';
import { fixture, period, seam, at, empty } from './self-metrics-hosted-fixture.mjs';

test('hosted queries authorize owner/maintainer, reject stranger and plain reader, enforce validators and windowed indexes', async () => {
  const f = fixture();
  f.put(
    'projectContributors',
    { projectId: 'project', contributor: 'maintainer', agentGuidanceMaintainer: true },
    seam,
  );
  f.put('projectReaders', { projectId: 'project', reader: 'reader' }, seam);
  f.landing('before-context', at(-43201), at(-43201));
  f.landing('context', at(-1440), at(-1440));
  f.landing('included', at(0), at(0));
  f.landing('excluded-to', period.to, period.to);
  const args = { stream: 'acceptances', ...period, cursor: null };
  assert.equal(JSON.parse(await f.query('projectSelfMetrics:page', args)).page.length, 2);
  f.actor('maintainer');
  assert.equal(JSON.parse(await f.query('projectSelfMetrics:page', args)).page.length, 2);
  for (const actor of ['stranger', 'reader', null]) {
    f.actor(actor);
    await assert.rejects(
      f.query('projectSelfMetrics:page', args),
      error => error.data?.code === 'PROJECT_UNAVAILABLE',
    );
  }
  f.actor('owner');
  await assert.rejects(
    f.query('projectSelfMetrics:page', { ...args, stream: 'source' }),
    /ArgumentValidationError/,
  );
  await assert.rejects(
    f.query('projectSelfMetrics:page', { ...args, limit: 101 }),
    /ArgumentValidationError/,
  );
  assert.equal(f.meter.writes, 0);
});

test('hand-computed authority seam keeps hosted acceptances/costs, removes stale native records and reports unknown evidence', async () => {
  const f = fixture();
  f.landing('hosted', at(10), at(12));
  f.landing('person', at(15), at(25), false);
  f.run('run', at(10), at(12));
  f.put(
    'projectHostedOperations',
    {
      projectId: 'project',
      actor: 'owner',
      operationId: 'cancel',
      metricAction: 'cancel',
      metricMutation: { action: 'cancel', actor: 'owner', operationId: 'cancel', at: at(13) },
      value: '{}',
    },
    at(13),
  );
  const { records } = await readHostedMetricPages(f.query, period);
  const native = {
    ...empty(),
    moves: [
      { id: 'native', at: at(-10), head: 'old', kind: 'landing', inputs: [] },
      { id: 'stale', at: at(5), head: 'stale', kind: 'landing', inputs: [] },
    ],
    runs: [
      {
        id: 'native-run',
        at: at(-11),
        endedAt: at(-10),
        status: 'passed',
        runnerMinutes: 2,
        wallMinutes: 1,
        inputs: [],
      },
    ],
  };
  const result = metricsSurface(joinMetricAuthority(native, records, seam), { from: at(-60), to: at(120) });
  assert.equal(result.source.kind, 'joined');
  assert.equal(result.totals['5.1'].landings, 3);
  assert.equal(result.totals['5.1'].firstTryShare, null);
  assert.equal(result.totals['5.6'].runnerMinutes, 6);
  assert.equal(result.totals['5.6'].runnerMinutesPerLanding, 2);
  assert.equal(result.totals['5.6'].wallMinutes, 3);
  assert.equal(result.totals.finishToMain.p50Minutes, 2);
  assert.equal(result.totals['5.5'].interventions, 1);
  assert.equal(result.totals['5.5'].perLanding, 1 / 3);
  assert.equal(result.totals['5.3'].dropped, null, 'confirmed acceptance is not a dropped landing');
  assert.equal(result.totals.R.sources[0].minutes, null, 'check name/status is not full-suite evidence');
  assert.equal(result.totals['5.2'].errors, null);
  assert.equal(result.totals['5.4'].delivered, null);
  assert(result.totals['5.6'].gaps.some(gap => gap.includes('Authority seam')));
});

test('2x dogfood budget: 60 landings/day, 3000 weekly runs, 1200 Intents plus a day of context; status has four calls; idle zero', async t => {
  const f = fixture();
  assert.equal(f.meter.calls, 0);
  for (let i = 0; i < 480; i++) f.landing(`landing-${i}`, at((i - 60) * 24), at((i - 60) * 24 + 2));
  for (let i = 0; i < 3429; i++)
    f.run(`run-${i}`, at(-1440 + i * (11520 / 3429)), at(-1438 + i * (11520 / 3429)));
  // Unrelated Intent and operation histories must never be scanned.
  for (let i = 0; i < 1200; i++) f.tables.projectHostedRecords.push({ kind: 'intent', key: `intent-${i}` });
  for (let i = 0; i < 3000; i++)
    f.put(
      'projectHostedOperations',
      { projectId: 'project', actor: 'owner', operationId: `other-${i}`, value: '{}' },
      at(i),
    );
  const start = performance.now();
  const pages = [];
  const { records } = await readHostedMetricPages(async (name, args) => {
    const page = await f.query(name, args);
    pages.push(page);
    return page;
  }, period);
  const result = metricsSurface(records, period);
  const elapsedMs = performance.now() - start;
  const worker = spawnSync(process.execPath, ['tests/self-metrics-hosted-budget.mjs'], {
    input: JSON.stringify({ pages, period }),
    encoding: 'utf8',
    env: childEnv(),
  });
  assert.equal(worker.status, 0, worker.stderr);
  const client = JSON.parse(worker.stdout);
  assert.equal(client.calls, f.meter.calls);
  assert.equal(client.landings, 420);
  assert.equal(client.runs, 3000);
  const rssMiB = client.rssMiB;
  const measured = {
    calls: f.meter.calls,
    documents: f.meter.documents,
    writes: f.meter.writes,
    rssMiB,
    elapsedMs,
    clientElapsedMs: client.elapsedMs,
  };
  t.diagnostic(JSON.stringify(measured));
  assert.equal(result.totals['5.1'].landings, 420);
  assert.equal(result.totals['5.6'].runs, 3000);
  assert(f.meter.calls <= 60);
  assert(f.meter.documents <= 20000);
  assert.equal(f.meter.writes, 0);
  assert(rssMiB <= 300);
  assert(elapsedMs + client.elapsedMs <= 10000);
  assert.equal(f.meter.maxPage, 100);
  const previous = f.meter.calls;
  const summary = await readHostedMetricPages(f.query, period, true);
  assert.equal(f.meter.calls - previous, 4);
  assert(summary.records.surfaceGaps.some(gap => gap.includes('Status read one hosted')));
});

test('old server returns METRICS_UNAVAILABLE plus coverage and never silently falls back', async () => {
  let calls = 0;
  const old = async () => {
    calls++;
    throw new Error("Could not find public function for 'projectSelfMetrics:page'");
  };
  const { records } = await readHostedMetricPages(old, period);
  const result = metricsSurface(records, period);
  assert.equal(calls, 1);
  assert.equal(result.error.code, 'METRICS_UNAVAILABLE');
  assert(result.totals['5.1'].gaps.some(gap => gap.includes('METRICS_UNAVAILABLE')));
  const f = fixture();
  f.actor('reader');
  await assert.rejects(readHostedMetricPages(f.query, period), error => error.code === 'PROJECT_UNAVAILABLE');
  await assert.rejects(
    readHostedMetricPages(async () => {
      throw new Error('network down');
    }, period),
    error => error.code === 'HOSTED_ACTION_FAILED',
  );
});

test('source-authority gate preserves native/native-shadow readers; hosted handler is unadvertised and uses the same surface', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-hosted-metrics-'));
  writeFileSync(join(root, 'source.txt'), 'fixture\n');
  initNative(root);
  const f = fixture();
  f.landing('hosted', at(10), at(12));
  const binding = {
    projectId: 'project',
    deployment: 'https://synthetic.convex.cloud',
    projectUrl: 'https://synthetic.test',
    operationId: randomUUID(),
    name: 'Synthetic',
    visibility: 'private',
    backupId: 'backup',
  };
  try {
    for (const mode of ['native-owner', 'server-shadow', 'server']) {
      writeFileSync(
        join(root, '.forge/work/hosted-binding.json'),
        JSON.stringify({ schema: 1, binding: { ...binding, sourceAuthority: { mode, epoch: 2 } } }),
      );
      assert.equal(Boolean(metricAddress(root).address), mode === 'server');
      const previous = f.meter.calls;
      const result = await readMetricRecords(root, period, { query: f.query });
      assert.equal(result.source.kind, mode === 'server' ? 'hosted' : 'native');
      assert.equal(f.meter.calls - previous, mode === 'server' ? 7 : 0);
    }
    const previous = f.meter.calls;
    const summary = await hostedStatusMetrics(root, period.to, f.query);
    assert.equal(f.meter.calls - previous, 4);
    assert.equal(summary.landings, 1);
    const result = await executeHostedMetrics(
      { root, address: { url: binding.deployment, projectId: 'project' }, query: f.query },
      period,
    );
    assert.equal(result.totals['5.1'].landings, 1);
    assert.equal(result.totals.finishToMain.p50Minutes, 2);
    assert(!hostedAgentActions.includes('metrics'));
    assert(hostedAgentOwnerActions.includes('metrics'));
    const previousToken = process.env.FORGE_AUTH_TOKEN;
    process.env.FORGE_AUTH_TOKEN = 'synthetic-metrics-credential';
    t.after(() => {
      if (previousToken === undefined) delete process.env.FORGE_AUTH_TOKEN;
      else process.env.FORGE_AUTH_TOKEN = previousToken;
    });
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const request = JSON.parse(init.body);
      assert.equal(request.path, 'projectSelfMetrics:page');
      const { projectId, ...args } = request.args[0];
      assert.equal(projectId, 'project');
      return new Response(JSON.stringify({ status: 'success', value: await f.query(request.path, args) }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    assert.equal((await readMetrics(root, period)).totals['5.1'].landings, 1);
    assert.equal(
      (await metricsCli([root, '--from', period.from, '--to', period.to, '--json'])).totals['5.1'].landings,
      1,
    );
    assert.equal(
      (await agentCli([root, 'metrics', JSON.stringify(period)])).result.totals['5.1'].landings,
      1,
    );
  } finally {
    await cleanupOwner(root);
    rmSync(root, { recursive: true, force: true });
  }
});
