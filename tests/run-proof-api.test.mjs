// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { checkCause } from '../dist/hosted-check.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const proof = await import(moduleUrl('../convex/projectRunProof.ts'));
const actions = await import(moduleUrl('../convex/projectRunProofActions.ts'));
const code = value => error => (error.data?.code ?? error.code) === value;

test('proof reads exact saved claims and never turns a missing check into a passing check', async t => {
  const s = await saveFixture();
  const x = await s.prepare([], {
    notVerified: ['Platform coverage was not run'],
    authorship: { kind: 'agent' },
    agentClient: 'fixture:model-one',
  });
  const saved = (await s.submit(x)).outcome.result;
  const data = JSON.parse(
    await s.call('proof', proof.read, { projectId: s.projectId, laneId: s.laneId, saveId: saved.saveId }),
  );
  assert.equal(data.save.id, saved.saveId);
  assert.equal(data.save.app, 'fixture');
  assert.equal(data.save.model, 'model-one');
  assert.deepEqual(data.save.notVerified, ['Platform coverage was not run']);
  assert.equal(data.check, null);
  assert.equal(data.claimMatchesCheck, null);
  assert.equal(s.counts.at(-1).writes, 0);
  t.diagnostic(JSON.stringify({ kind: 'synthetic proof read', ...s.counts.at(-1) }));
  await assert.rejects(
    s.call('private-proof', proof.read, { projectId: s.projectId, laneId: s.laneId }, 'stranger'),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    s.call('missing-proof', proof.read, { projectId: s.projectId, laneId: s.laneId, saveId: randomUUID() }),
    code('NOT_FOUND'),
  );
});

test('a full-check request keeps the original Candidate and source pins and replays one run', async t => {
  const key = process.env.FORGE_HOSTED_CHECK_KEY_ID;
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
  t.after(() => {
    if (key === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
    else process.env.FORGE_HOSTED_CHECK_KEY_ID = key;
  });
  const s = await checksFixture();
  const original = await s.enqueue(s.selection());
  const input = { projectId: s.projectId, runId: original.id, operationId: randomUUID() };
  const run = JSON.parse(await s.call('proof-full', actions.runAll, input));
  assert.equal(run.request.expectedHead, original.request.expectedHead);
  assert.equal(run.request.candidateId, original.request.candidateId);
  assert.equal(run.request.expectedDefinition, original.request.expectedDefinition);
  assert.equal(run.request.gate.mode, 'full');
  assert.equal(run.gate.mode, 'full');
  assert.notEqual(run.id, original.id);
  assert.equal(run.status, 'queued');
  const replay = JSON.parse(await s.call('proof-full-replay', actions.runAll, input));
  assert.equal(replay.id, run.id);
  assert.deepEqual(
    [...s.tables.projectHostedCheckRuns.values()].map(row => row.cause),
    [checkCause.manual, checkCause.proof],
  );
  await assert.rejects(
    s.call('private-full', actions.runAll, { ...input, operationId: randomUUID() }, 'stranger'),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('making one claim or every claim creates the same linked Items after a lost reply', async t => {
  const { setup } = await import('./hosted-planning-fixture.mjs');
  const { digest } = await import('../dist/state/hash.js');
  const s = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  s.tables.hostedProjects.set(s.projectId, { ...project, sourceAuthority: { mode: 'server', epoch: 1 } });
  const saveId = randomUUID(),
    laneId = randomUUID(),
    head = 'a'.repeat(64);
  const saved = {
    kind: 'save',
    id: saveId,
    version: 0,
    at: '2026-11-01T10:00:00.000Z',
    laneId,
    actor: 'SYNTHETIC_PRIVATE_ACCOUNT_ID',
    operationId: randomUUID(),
    expectedHead: head,
    expectedSourceVersion: 0,
    head,
    sourceVersion: 0,
    changes: { sha256: 'b'.repeat(64), size: 0 },
    notVerified: ['Platform tests were not run', 'The optional adapter was not checked'],
  };
  const value = JSON.stringify(saved),
    recordId = 'proof-save-record';
  s.tables.projectHostedRecords.set(recordId, {
    _id: recordId,
    _creationTime: 100,
    projectId: s.projectId,
    kind: 'save',
    key: saveId,
    parent: laneId,
    status: 'saved',
    version: 0,
    digest: digest(value),
    bytes: Buffer.byteLength(value),
    bodyId: 'proof-save-body',
    inline: value,
  });
  s.tables.projectHostedRecordHeads.set('proof-save-head', {
    _id: 'proof-save-head',
    _creationTime: 100,
    projectId: s.projectId,
    kind: 'save',
    key: saveId,
    parent: laneId,
    status: 'saved',
    version: 0,
    recordId,
  });
  const input = { projectId: s.projectId, saveId };
  const single = JSON.parse(await actions.followups._handler(s.ctx, { ...input, line: 0 }));
  const batch = JSON.parse(await actions.followups._handler(s.ctx, { ...input, offset: 0 }));
  assert.equal(single.items[0].id, batch.items[0].id);
  assert.equal(batch.items.length, 2);
  assert.deepEqual(JSON.parse(await actions.followups._handler(s.ctx, { ...input, offset: 0 })), batch);
  const data = (await s.read()).data;
  for (const item of data.planningItems.filter(item => batch.items.some(made => made.id === item.id))) {
    assert(!item.body.includes('SYNTHETIC_PRIVATE_ACCOUNT_ID'));
    assert(item.body.includes(saveId) && item.body.includes(head));
  }
  assert.equal(data.planningItems.filter(item => batch.items.some(made => made.id === item.id)).length, 2);
});

for (const claim of [undefined, [], ['Platform coverage remains unverified']]) {
  test(`landing declaration stays exact and retry-safe: ${claim === undefined ? 'absent' : claim.length ? 'lines' : 'empty'}`, async () => {
    const { landingFixture } = await import('./hosted-landing-fixture.mjs');
    const f = await landingFixture();
    const request = f.request({
      ...(claim === undefined ? {} : { notVerified: claim }),
      outside: [{ kind: 'deploy', what: 'Published to https://private.invalid?token=secret' }],
    });
    const state = await f.enqueue(request);
    assert.deepEqual(state.request.notVerified, claim);
    assert.equal(state.actor, 'owner');
    assert.equal(state.request.outside[0].what.includes('https://'), false);
    assert.equal((await f.enqueue(request)).id, state.id);
    assert.equal(f.tables.projectHostedLandingRequests.size, 1);
  });
}
