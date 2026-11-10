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
const list = s =>
  s.invoke('projectHostedDecisions:list', {
    projectId: 'project',
    cursor: null,
  });

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
      s.request(name, {
        ...command,
        ...(command.title ? { title: 'Changed' } : { why: 'Changed' }),
      }),
      code('WORK_OPERATION_CHANGED'),
    );
    assert.equal(s.counts().writes, writes);
    assert.equal(first.id, command.operationId);
    assert.ok(first.request.match(/^[a-f0-9]{64}$/));
    if (first.kind === 'decision') {
      assert.equal(first.requester.name, 'owner');
      // A free-text actor is not an identity: the record names the caller (8809fba5).
      assert.equal(first.actor.name, 'owner');
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
  const grant = {
    projectId: 'project',
    operationId: randomUUID(),
    actor: 'contributor',
    enabled: true,
  };
  await s.invoke('projectHostedDecisions:setMaintainer', grant);
  await s.invoke('projectHostedDecisions:setMaintainer', grant);
  await assert.rejects(
    s.invoke('projectHostedDecisions:setMaintainer', {
      ...grant,
      enabled: false,
    }),
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

test('retired overlap answer endpoints refuse old CLIs with the upgrade step and write nothing', async () => {
  const s = recordsFixture();
  s.caller('contributor');
  const before = s.counts();
  const upgrade = error =>
    error.data?.code === 'CLI_UPGRADE_REQUIRED' && /Upgrade nforge/.test(error.data.message);
  await assert.rejects(s.request('projectHostedOverlapAcks:append', { operationId: randomUUID() }), upgrade);
  await assert.rejects(
    s.invoke('projectHostedOverlapAcks:list', {
      projectId: 'project',
      cursor: null,
    }),
    upgrade,
  );
  assert.equal(s.counts().writes, before.writes);
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
  await s.request('projectHostedFrictionImport:apply', {
    decisions: records.slice(0, 100),
  });
  await s.request('projectHostedFrictionImport:apply', {
    decisions: records.slice(100),
  });
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

test('server friction validation names the field and expected shape, including no-Lane requests', async () => {
  const s = recordsFixture();
  for (const [field, value] of [
    ['title', ''],
    ['laneId', 'invalid'],
    ['operationId', 'invalid'],
    ['cost', { minutes: -1 }],
  ])
    await assert.rejects(
      s.request('projectHostedFriction:capture', friction({ [field]: value })),
      error =>
        error.data?.code === 'BAD_ARGUMENT' &&
        error.data.message.includes(field) &&
        error.data.message.includes('--help'),
    );
  const result = await s.request('projectHostedFriction:capture', friction());
  assert.equal(result.laneId, undefined);
  assert.equal([...s.tables.projectHostedFriction.values()][0].actor, 'owner');
});
