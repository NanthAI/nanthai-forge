// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { saveBytes } from '../dist/hosted-save.js';
import { metricAliasGeneration } from '../dist/self-metrics-context.js';
import { composeFixture, code } from './hosted-compose-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const bootstrap = await import(moduleUrl('../convex/projectMetricContextBootstrap.ts'));
const { metricAliasRows } = await import(moduleUrl('../convex/projectMetricAliasWriter.ts'));
const { metricContextPage } = await import(moduleUrl('../convex/projectMetricContext.ts'));

test('five pinned pages from a late legacy compose backfill one per commit and support later Candidate reuse', async () => {
  const f = await composeFixture();
  const lanes = [];
  for (let index = 0; index < 5; index++) lanes.push(await f.lane(f.baseline));
  const selected = f.selection(lanes);
  const pages = [];
  let pin = null;
  for (const lane of lanes.toReversed()) {
    const value = { schema: 1, kind: 'forge-hosted-compose-page', entries: [lane], next: pin };
    pin = f.put(saveBytes(value));
    pages.unshift({ pin, value });
  }
  selected.request.inputs = { root: pin, pages: 5, count: 5 };
  selected.pages.inputs = pages;
  await f.prepare(selected);
  await f.stage(selected);
  // A legacy operation published its compose after writer deployment without memberships.
  f.tables.projectMetricFacts.clear();
  f.patch('hostedProjects', f.projectId, { metricContextGap: 'legacy-compose' });
  f.insert('projectFinishReadRows', {
    kind: 'projectLiveLineSummary',
    projectId: f.projectId,
    sourceId: f.projectId,
    value: JSON.stringify({ main: { head: f.main.head }, landingSequence: f.main.sourceRevision }),
  });
  const through = Math.min(...[...f.tables.projectHostedComposes.values()].map(row => row._creationTime)) - 1;
  const target = { projectId: f.projectId, operationId: randomUUID() };
  const start = JSON.parse(
    await f.call('metricsBootstrapBegin', bootstrap.begin, { ...target, from: 0, through }),
  );
  assert.equal(start.root.pin.sha256, pages[0].pin.sha256);
  let state = start;
  for (const [index, page] of pages.entries()) {
    const input = { ...target, step: state.step, page: new TextDecoder().decode(saveBytes(page.value)) };
    const next = await f.call('metricsBootstrapAdvance', bootstrap.advance, input);
    const count = f.tables.projectMetricFacts.size;
    assert.equal(await f.call('metricsBootstrapAdvance', bootstrap.advance, input), next);
    assert.equal(f.tables.projectMetricFacts.size, count);
    state = JSON.parse(next);
    assert.equal(state.composePages, index + 1);
  }
  assert.equal(state.phase, 'requests');
  assert.equal(state.aliases, 15);
  for (const phase of ['requests', 'attempts', 'runs']) {
    assert.equal(state.phase, phase);
    state = JSON.parse(
      await f.call('metricsBootstrapAdvance', bootstrap.advance, {
        ...target,
        step: state.step,
        page: null,
      }),
    );
  }
  assert.equal(state.phase, 'ready');
  await f.call('metricsBootstrapGrant', bootstrap.grant, target);
  assert.equal(f.tables.hostedProjects.get(f.projectId).metricContextGap, undefined);

  // The writer links a later attempt to an earlier compose root by business ID.
  const attempt = { id: 'reused-candidate', at: '1970-01-01T00:00:01.000Z', candidate: { inputs: pin } };
  const id = f.insert('projectHostedLandingAttempts', {
    projectId: f.projectId,
    attemptId: attempt.id,
    submissionId: attempt.id,
    number: 0,
    value: JSON.stringify(attempt),
  });
  const sourceCreatedAt = f.tables.projectHostedLandingAttempts.get(id)._creationTime;
  assert(sourceCreatedAt >= through);
  for (const alias of metricAliasRows(f.projectId, attempt.id, {
    stream: 'attempts',
    sourceCreatedAt,
    row: { ...attempt, inputPin: pin },
  }))
    f.insert('projectMetricFacts', alias);
  for (const lookup of [
    { kind: 'lane', id: lanes[0].laneId },
    { kind: 'intent', id: f.intentId },
  ]) {
    const page = await f.run('coveredMetricRoot', async ctx =>
      metricContextPage(ctx, await ctx.db.get(f.projectId), {
        lookups: [lookup],
        generation: metricAliasGeneration,
        context: 0,
        from: sourceCreatedAt + 1,
        to: sourceCreatedAt + 2,
        cursor: null,
      }),
    );
    assert.deepEqual(
      page.page.map(item => item.row.id),
      [attempt.id],
    );
  }
});

test('bootstrap refuses coverage when a previously unknown legacy root appears during the pass', async () => {
  const f = await composeFixture();
  f.insert('projectFinishReadRows', {
    kind: 'projectLiveLineSummary',
    projectId: f.projectId,
    sourceId: f.projectId,
    value: JSON.stringify({ main: { head: f.main.head }, landingSequence: f.main.sourceRevision }),
  });
  const target = { projectId: f.projectId, operationId: randomUUID() };
  const start = JSON.parse(
    await f.call('metricsBootstrapBegin', bootstrap.begin, { ...target, from: 0, through: 0 }),
  );
  f.patch('hostedProjects', f.projectId, { metricContextGap: 'late-recovery' });
  await assert.rejects(
    f.call('metricsBootstrapAdvance', bootstrap.advance, {
      ...target,
      step: start.step,
      page: null,
    }),
    code('EVIDENCE_CHANGED'),
  );
  assert.equal(f.tables.hostedProjects.get(f.projectId).metricContextCoverage, undefined);
});

test('reset only clears the bootstrap operation it names', async () => {
  const f = await composeFixture();
  f.insert('projectFinishReadRows', {
    kind: 'projectLiveLineSummary',
    projectId: f.projectId,
    sourceId: f.projectId,
    value: JSON.stringify({ main: { head: f.main.head }, landingSequence: f.main.sourceRevision }),
  });
  const target = { projectId: f.projectId, operationId: randomUUID() };
  let state = JSON.parse(
    await f.call('metricsBootstrapBegin', bootstrap.begin, { ...target, from: 0, through: 0 }),
  );
  while (state.phase !== 'ready') {
    state = JSON.parse(
      await f.call('metricsBootstrapAdvance', bootstrap.advance, { ...target, step: state.step, page: null }),
    );
  }
  await f.call('metricsBootstrapGrant', bootstrap.grant, target);
  await f.call('metricsBootstrapReset', bootstrap.reset, { ...target, operationId: randomUUID() });
  assert.equal(
    f.tables.hostedProjects.get(f.projectId).metricContextCoverage.generation,
    metricAliasGeneration,
  );
  await f.call('metricsBootstrapReset', bootstrap.reset, target);
  await f.call('metricsBootstrapGrant', bootstrap.grant, target);
  assert.equal(f.tables.hostedProjects.get(f.projectId).metricContextCoverage, undefined);
});
