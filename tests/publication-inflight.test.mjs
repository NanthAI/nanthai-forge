// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { fixture, checkpoint, modules } from './project-exchange-fixture.mjs';
const actions = modules.projectExchangeActions;
const failCode = code => error => error.data?.code === code;

test('retry during seed validation waits for the same operation instead of starting another seed', async t => {
  const s = fixture(),
    first = await checkpoint(t, s);
  const get = s.ctx.storage.get;
  let release, entered;
  const blocked = new Promise(resolve => {
    entered = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let reads = 0;
  s.ctx.storage.get = async id => {
    reads++;
    if (reads === 1) {
      entered();
      await gate;
    }
    return get(id);
  };
  const original = actions.publish._handler(s.ctx, first.input);
  await blocked;
  const retry = actions.publish._handler(s.ctx, first.input);
  await assert.rejects(
    actions.publish._handler(s.ctx, { ...first.input, size: first.input.size + 1 }),
    failCode('WORK_OPERATION_CHANGED'),
  );
  assert.equal(reads, 1);
  release();
  const id = await original,
    completedReads = reads;
  assert.equal(await retry, id);
  assert.equal(reads, completedReads, 'waiting retry reuses committed receipt without a storage read');
  assert.equal(s.tables.projectBackups.size, 1);
  assert.equal(await actions.publish._handler(s.ctx, first.input), id);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'stranger' });
  await assert.rejects(actions.publish._handler(s.ctx, first.input), failCode('PROJECT_UNAVAILABLE'));
});

test('failed validation releases its claim; crashed workers expire at the action budget', async t => {
  const s = fixture(),
    first = await checkpoint(t, s),
    get = s.ctx.storage.get;
  s.ctx.storage.get = async () => {
    throw new Error('synthetic storage failure');
  };
  await assert.rejects(actions.publish._handler(s.ctx, first.input));
  assert.equal([...s.tables.projectPublicationAttempts.values()][0].expiresAt, 0);
  s.ctx.storage.get = get;
  assert.ok(await actions.publish._handler(s.ctx, first.input));
  const input = {
    projectId: 'project',
    owner: 'owner',
    operationId: randomUUID(),
    request: 'pinned',
    attemptId: randomUUID(),
  };
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const claim = modules.projectPublicationAttempt.claim;
  assert.equal((await claim._handler(s.ctx, input)).claimed, true);
  const replacement = { ...input, attemptId: randomUUID() };
  assert.equal((await claim._handler(s.ctx, replacement)).claimed, false);
  now += 600001;
  assert.equal((await claim._handler(s.ctx, replacement)).claimed, true);
  await modules.projectPublicationAttempt.release._handler(s.ctx, input);
  assert.equal(
    (await claim._handler(s.ctx, { ...input, attemptId: randomUUID() })).claimed,
    false,
    'old worker cannot release the new claim',
  );
});

test('existing project deletion purges internal publication attempts with the other project records', async () => {
  const s = fixture();
  await modules.projectPublicationAttempt.claim._handler(s.ctx, {
    projectId: 'project',
    owner: 'owner',
    operationId: randomUUID(),
    request: 'original',
    attemptId: randomUUID(),
  });
  s.tables.hostedProjects.get('project').removal = 'deleting';
  const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
  await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
  assert.equal(s.tables.projectPublicationAttempts.size, 0);
});
