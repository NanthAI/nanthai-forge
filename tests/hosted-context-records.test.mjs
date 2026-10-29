// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordsFixture } from './hosted-context-records-fixture.mjs';
import { decisionContext } from '../dist/decision-types.js';
import { moduleUrl } from './convex-module.mjs';
const { hostedBriefDecisions } = await import(moduleUrl('../convex/projectHostedDecisionsStore.ts'));
const code = expected => error => error.data?.code === expected;
const friction = (extra = {}) => ({
  operationId: randomUUID(),
  title: 'Synthetic friction',
  detail: 'Finite command',
  area: 'agent',
  cost: { minutes: 2, retries: 1 },
  ...extra,
});
const decision = (extra = {}) => ({
  operationId: randomUUID(),
  target: { kind: 'project' },
  decidedBy: 'Synthetic owner',
  what: 'Keep exact records',
  why: 'Retain context',
  ...extra,
});
const list = s => s.invoke('projectHostedDecisions:list', { projectId: 'project', cursor: null });

test('friction and decisions replay exactly; changed requests fail without appending', async () => {
  const s = recordsFixture();
  for (const [name, command] of [
    ['projectHostedFriction:capture', friction()],
    [
      'projectHostedDecisions:decide',
      decision({ decidedAt: '2026-10-24', actor: 'Builder', tool: 'fixture' }),
    ],
  ]) {
    const first = await s.request(name, command),
      writes = s.counts().writes;
    assert.deepEqual(await s.request(name, command), first);
    assert.equal(s.counts().writes, writes);
    await assert.rejects(
      s.request(name, { ...command, ...(command.title ? { title: 'Changed' } : { why: 'Changed' }) }),
      code('WORK_OPERATION_CHANGED'),
    );
    assert.equal(s.counts().writes, writes);
    assert.equal(first.id, command.operationId);
    assert.ok(first.request.match(/^[a-f0-9]{64}$/));
    if (first.kind === 'decision') {
      assert.equal(first.requester.name, 'owner');
      assert.equal(first.actor.name, 'Builder');
      assert.equal(first.decidedAt, '2026-10-24');
    }
  }
  assert.equal(s.scheduled.length, 0);
});

test('current stranger/contributor/maintainer authority is checked on writes and replay', async () => {
  const s = recordsFixture();
  const original = decision();
  await s.request('projectHostedDecisions:decide', original);
  s.tables.projectContributors.set('contributor', {
    _id: 'contributor',
    projectId: 'project',
    contributor: 'contributor',
    agentGuidanceMaintainer: true,
  });
  s.caller('contributor');
  await s.request('projectHostedFriction:capture', friction());
  await assert.rejects(s.request('projectHostedDecisions:decide', decision()), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(s.request('projectHostedDecisions:decide', original), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(
    s.invoke('projectHostedDecisions:setMaintainer', {
      projectId: 'project',
      operationId: randomUUID(),
      actor: 'contributor',
      enabled: true,
    }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.caller('owner');
  const grant = { projectId: 'project', operationId: randomUUID(), actor: 'contributor', enabled: true };
  await s.invoke('projectHostedDecisions:setMaintainer', grant);
  await s.invoke('projectHostedDecisions:setMaintainer', grant);
  await assert.rejects(
    s.invoke('projectHostedDecisions:setMaintainer', { ...grant, enabled: false }),
    code('WORK_OPERATION_CHANGED'),
  );
  s.caller('contributor');
  await s.request('projectHostedDecisions:decide', decision());
  s.caller('owner');
  await s.invoke('projectHostedDecisions:setMaintainer', {
    ...grant,
    operationId: randomUUID(),
    enabled: false,
  });
  s.caller('contributor');
  await assert.rejects(s.request('projectHostedDecisions:decide', decision()), code('PROJECT_UNAVAILABLE'));
  s.tables.hostedProjects.get('project').visibility = 'public';
  for (const actor of ['stranger', undefined]) {
    s.caller(actor);
    for (const [name, command] of [
      ['projectHostedFriction:capture', friction()],
      ['projectHostedDecisions:decide', decision()],
      [
        'projectHostedOverlapAcks:append',
        {
          operationId: randomUUID(),
          answers: [
            { operationId: randomUUID(), laneId: randomUUID(), noticeId: 'a'.repeat(64), choice: 'split' },
          ],
        },
      ],
    ])
      await assert.rejects(s.request(name, command), code('PROJECT_UNAVAILABLE'));
  }
});

test('append-only supersession retains chains and forks; pages and briefs derive from hosted records', async () => {
  const s = recordsFixture();
  const old = await s.request('projectHostedDecisions:decide', decision());
  const next = await s.request('projectHostedDecisions:decide', decision({ supersedes: old.id }));
  const last = await s.request('projectHostedDecisions:decide', decision({ supersedes: next.id }));
  const fork = await s.request('projectHostedDecisions:decide', decision({ supersedes: old.id }));
  const rows = (await list(s)).page;
  assert.deepEqual(rows[0], old);
  assert.deepEqual(next.overrides, { kind: 'decision', decisionId: old.id });
  const context = decisionContext(rows);
  assert.deepEqual(
    context.active.map(r => r.id),
    [last.id, fork.id],
  );
  assert.deepEqual(context.superseded[0].supersededBy, [next.id, fork.id]);
  assert.deepEqual((await hostedBriefDecisions(s.ctx, 'project')).decisions, rows);
  for (const extra of [
    { supersedes: randomUUID() },
    { target: { kind: 'intent', intentId: randomUUID() } },
    { overrides: { kind: 'decision', decisionId: randomUUID() } },
  ])
    await assert.rejects(s.request('projectHostedDecisions:decide', decision(extra)), code('NOT_FOUND'));
  assert.equal((await list(s)).page.length, 4);
});

test('ack batch records 100 metric-compatible answers in one call, with stable replay and no scheduler', async t => {
  const s = recordsFixture();
  s.tables.projectContributors.set('c', { _id: 'c', projectId: 'project', contributor: 'contributor' });
  s.caller('contributor');
  const batch = {
    operationId: randomUUID(),
    answers: Array.from({ length: 100 }, (_, i) => ({
      operationId: randomUUID(),
      laneId: randomUUID(),
      noticeId: String(i).padStart(64, '0'),
      choice: i % 2 ? 'split' : 'accept-order',
    })),
  };
  const before = s.counts(),
    started = performance.now();
  const result = await s.request('projectHostedOverlapAcks:append', batch);
  const cost = {
    calls: s.counts().calls - before.calls,
    reads: s.counts().reads - before.reads,
    writes: s.counts().writes - before.writes,
    durationMs: Math.round(performance.now() - started),
  };
  t.diagnostic(JSON.stringify({ ackBatch100: cost }));
  assert.equal(cost.calls, 1);
  assert.equal(cost.writes, 101);
  assert.ok(cost.reads <= 3);
  assert.equal(result.answers.length, 100);
  assert.equal(result.answers[0].disposition, 'acknowledged');
  assert.equal(result.answers[1].disposition, 'routed-around');
  assert.match(result.answers[0].deliveryId, /^hook:[a-f0-9]{64}$/);
  assert.deepEqual(await s.request('projectHostedOverlapAcks:append', batch), result);
  await assert.rejects(
    s.request('projectHostedOverlapAcks:append', { ...batch, answers: batch.answers.slice(1) }),
    code('WORK_OPERATION_CHANGED'),
  );
  await assert.rejects(
    s.request('projectHostedOverlapAcks:append', {
      operationId: randomUUID(),
      answers: [{ ...batch.answers[0], choice: 'swap' }],
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.equal(s.scheduled.length, 0);
  assert.equal(
    (await s.invoke('projectHostedOverlapAcks:list', { projectId: 'project', cursor: null })).page.length,
    100,
  );
});

test('real Convex argument validators reject extra/wrong arguments and native authority refuses hosted writes', async () => {
  const s = recordsFixture();
  for (const name of [
    'projectHostedFriction:capture',
    'projectHostedDecisions:decide',
    'projectHostedOverlapAcks:append',
    'projectHostedFrictionImport:preview',
    'projectHostedFrictionImport:apply',
  ]) {
    await assert.rejects(
      s.invoke(name, { projectId: 'project', request: {}, extra: true }),
      /ArgumentValidationError/,
    );
    await assert.rejects(s.invoke(name, { projectId: 'project' }), /ArgumentValidationError/);
  }
  s.tables.hostedProjects.get('project').sourceAuthority.mode = 'native-owner';
  await assert.rejects(
    s.request('projectHostedFriction:capture', friction()),
    code('HOSTED_ACTION_UNSUPPORTED'),
  );
  await assert.rejects(
    s.request('projectHostedDecisions:decide', decision()),
    code('HOSTED_ACTION_UNSUPPORTED'),
  );
});

test('decision lists retain opaque page cursors and bounded brief coverage beyond one page', async () => {
  const s = recordsFixture(),
    at = '2026-10-24T00:00:00.000Z';
  const records = Array.from({ length: 120 }, (_, i) => {
    const id = randomUUID();
    return {
      schema: 1,
      kind: 'decision',
      id,
      operationId: id,
      request: 'a'.repeat(64),
      at,
      decidedAt: at,
      target: { kind: 'project' },
      decidedBy: 'Owner',
      what: `Synthetic ${i}`,
      why: 'Paged context',
      actor: { kind: 'agent', name: 'fixture' },
      requester: { kind: 'agent', name: 'fixture' },
    };
  });
  await s.request('projectHostedFrictionImport:apply', { decisions: records.slice(0, 100) });
  await s.request('projectHostedFrictionImport:apply', { decisions: records.slice(100) });
  const before = s.counts().calls,
    first = await list(s);
  assert.equal(s.counts().calls - before, 1);
  assert.equal(first.page.length, 100);
  assert.equal(first.isDone, false);
  const second = await s.invoke('projectHostedDecisions:list', {
    projectId: 'project',
    cursor: first.continueCursor,
  });
  assert.equal(second.isDone, true);
  assert.deepEqual([...first.page, ...second.page], records);
  const brief = await hostedBriefDecisions(s.ctx, 'project');
  assert.equal(brief.more, true);
  assert.equal(brief.decisions.length, 100);
  assert.deepEqual(brief.decisions, records.slice(20));
});
