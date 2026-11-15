// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';
const modules = Object.fromEntries(
  await Promise.all(
    ['secretActions', 'projectLifecycle', 'accountActions', 'projectHostedCheckWorker'].map(async name => [
      name,
      await import(moduleUrl(`../convex/${name}.ts`)),
    ]),
  ),
);
const denied = e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE';
function fixture() {
  const s = state([]);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project', name: 'synthetic', revision: 1 }));
  s.tables.cliCredentials.set('device', {
    _id: 'device',
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'test',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600000,
    revoked: false,
    scope: 'cli',
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'synthetic-device' });
  return s;
}
test('owner device credentials cannot reveal secret values, permanently delete projects or receive runner signing keys', async () => {
  for (const [module, name, input] of [
    ['secretActions', 'reveal', { id: 'secret', operationId: randomUUID() }],
    [
      'projectLifecycle',
      'permanentlyDelete',
      { projectId: 'project', operationId: randomUUID(), expectedRevision: 1, confirm: 'synthetic' },
    ],
    [
      'accountActions',
      'begin',
      {
        operationId: randomUUID(),
        selection: [{ kind: 'project', id: 'project', pin: 'a'.repeat(64) }],
        leave: [],
      },
    ],
    ['projectHostedCheckWorker', 'register', { projectId: 'project', request: '{}' }],
  ]) {
    const s = fixture();
    await assert.rejects(modules[module][name]._handler(s.ctx, input), denied, `${module}:${name}`);
    assert.equal(s.tables.hostedProjects.get('project').revision, 1);
    assert.equal(s.tables.accountOperations.size, 0);
  }
});
test('owner devices retain reversible trash and restore', async () => {
  const s = fixture();
  await modules.projectLifecycle.trash._handler(s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    expectedRevision: 1,
  });
  assert.equal(s.tables.hostedProjects.get('project').removal, 'trash');
  await modules.projectLifecycle.restore._handler(s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    expectedRevision: 2,
  });
  assert.equal(s.tables.hostedProjects.get('project').removal, undefined);
});

test('project deletion in a retained account plan still requires the person on advance; unrelated cleanup remains available', async () => {
  const s = fixture();
  const device = s.ctx.auth.getUserIdentity;
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const inventory = await modules.accountActions.inventory._handler(s.ctx, {
    kind: 'project',
    paginationOpts: { cursor: null, numItems: 10 },
  });
  const item = inventory.page[0];
  const operationId = randomUUID();
  await modules.accountActions.begin._handler(s.ctx, {
    operationId,
    selection: [{ kind: 'project', id: item.id, pin: item.pin }],
    leave: [],
  });
  s.ctx.auth.getUserIdentity = device;
  await assert.rejects(modules.accountActions.advance._handler(s.ctx, { operationId, cursor: null }), denied);
  assert.equal(s.tables.hostedProjects.get('project').revision, 1);
  const unrelated = await modules.accountActions.begin._handler(s.ctx, {
    operationId: randomUUID(),
    selection: [],
    leave: [],
  });
  assert.equal(unrelated.stage, 'ready');
});
