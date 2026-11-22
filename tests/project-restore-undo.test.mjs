// SPDX-License-Identifier: Apache-2.0
// Undo after a restore (Item 966cb821): the restore hands back a receipt (the revision it wrote and its own operation
// id), and the Undo trash call must present it. A stale tab whose restore changed nothing gets no receipt, and an
// invitation accepted after the restore closes the Undo, so neither can trash a restored or shared project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { invitationFixture, refusal } from './invitation-fixture.mjs';

const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const accounts = await import(moduleUrl('../convex/urlAccounts.ts'));
const stale = refusal('WORK_STALE');

function trashed(t) {
  const f = invitationFixture(t);
  const project = () => f.tables.hostedProjects.get('project');
  const owner = () => f.caller('owner', 'owner@example.test');
  const move = (kind, extra = {}) => {
    owner();
    return lifecycle[kind]._handler(f.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      expectedRevision: project().revision,
      ...extra,
    });
  };
  return { ...f, project, owner, move };
}

test('a restore answers with its receipt, and a retried restore answers with the same one', async t => {
  const f = trashed(t);
  await f.move('trash');
  const op = { projectId: 'project', operationId: randomUUID(), expectedRevision: f.project().revision };
  f.owner();
  const receipt = await lifecycle.restore._handler(f.ctx, op);
  assert.deepEqual(receipt, { restoreId: op.operationId, revision: f.project().revision });
  assert.deepEqual(await lifecycle.restore._handler(f.ctx, op), receipt);
});

test('Undo with the receipt trashes the project it restored, and a replayed Undo is a no-op', async t => {
  const f = trashed(t);
  await f.move('trash');
  const receipt = await f.move('restore');
  const undo = {
    projectId: 'project',
    operationId: randomUUID(),
    expectedRevision: receipt.revision,
    afterRestore: receipt.restoreId,
  };
  f.owner();
  await lifecycle.trash._handler(f.ctx, undo);
  assert.equal(f.project().removal, 'trash');
  const settled = structuredClone(f.project());
  await lifecycle.trash._handler(f.ctx, undo);
  assert.deepEqual(f.project(), settled);
});

test('a stale tab restoring an already restored project gets no receipt, and a foreign restore id cannot Undo', async t => {
  const f = trashed(t);
  await f.move('trash');
  const stale1 = f.project().revision;
  const mine = await f.move('restore');
  // The second tab still holds the trashed revision: its restore changes nothing and offers no Undo.
  f.owner();
  assert.equal(
    await lifecycle.restore._handler(f.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      expectedRevision: stale1,
    }),
    null,
  );
  assert.equal(f.project().removal, undefined);
  // Even holding the current revision, an Undo that names another restore is refused and writes nothing.
  const before = structuredClone(f.project());
  await assert.rejects(
    lifecycle.trash._handler(f.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      expectedRevision: mine.revision,
      afterRestore: randomUUID(),
    }),
    stale,
  );
  assert.deepEqual(f.project(), before);
});

test('an invitation accepted after the restore closes its Undo: the shared project is never trashed', async t => {
  const f = trashed(t);
  await f.move('trash');
  const receipt = await f.move('restore');
  // Trash revokes pending invitations and restore never brings them back: this one is sent after the restore.
  const invitation = await f.invite('guest@example.test');
  f.caller('guest', 'guest@example.test');
  await accounts.ensure._handler(f.ctx, {});
  await f.answer(invitation, 'accept');
  assert.ok(f.tables.projectReaders.size + f.tables.projectContributors.size > 0, 'the guest joined');
  const before = structuredClone(f.project());
  f.owner();
  await assert.rejects(
    lifecycle.trash._handler(f.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      expectedRevision: receipt.revision,
      afterRestore: receipt.restoreId,
    }),
    stale,
  );
  assert.deepEqual(f.project(), before, 'a refused Undo writes nothing');
  assert.equal(f.project().removal, undefined);
});
