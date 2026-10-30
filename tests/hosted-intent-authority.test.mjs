// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
import { intentHeader } from '../dist/work-hosted-index.js';
const { intentAuthority } = await import(moduleUrl('../convex/projectContributors.ts'));
const proposals = await import(moduleUrl('../convex/projectProposals.ts'));
const denied = error => error.code === 'PROJECT_UNAVAILABLE' || error.data?.code === 'PROJECT_UNAVAILABLE';
function setup() {
  const s = state([]),
    intentId = randomUUID();
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    visibility: 'private',
    work: { backupId: 'backup', generationId: 'generation', revision: 1, initialRevision: 0 },
  });
  s.tables.projectWorkGenerations.set('generation', {
    _id: 'generation',
    projectId: 'project',
    backupId: 'backup',
    status: 'ready',
    format: HOSTED_WORK_INDEX_FORMAT,
  });
  for (const contributor of ['creator', 'assigned', 'other'])
    s.tables.projectContributors.set(contributor, { _id: contributor, projectId: 'project', contributor });
  const intent = {
    id: intentId,
    outcome: 'Synthetic Intent',
    constraints: '',
    base: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00Z',
    status: 'active',
    notes: [],
    creatorAccountId: 'creator',
    assigneeAccountIds: ['assigned'],
  };
  const header = {
    _id: 'header',
    generationId: 'generation',
    collection: 'intents',
    key: intentId,
    value: JSON.stringify(intentHeader(intent)),
  };
  s.tables.projectWorkRecords.set('header', header);
  const check = actor => intentAuthority(s.ctx, 'project', actor, intentId);
  return { ...s, intent, header, intentId, check };
}
for (const actor of ['owner', 'creator', 'assigned'])
  test(`Intent authority permits ${actor} using current indexed account identities`, async () => {
    const s = setup();
    assert.equal((await s.check(actor)).project._id, 'project');
  });
for (const actor of ['other', 'stranger', 'reader', 'session-label'])
  test(`Intent authority rejects ${actor}`, async () => {
    const s = setup();
    s.tables.projectReaders.set('reader', { _id: 'reader', projectId: 'project', reader: 'reader' });
    await assert.rejects(s.check(actor), denied);
  });
test('assignment removal and contributor revocation take effect on the next read', async () => {
  const s = setup();
  await s.check('assigned');
  s.header.value = JSON.stringify(intentHeader({ ...s.intent, assigneeAccountIds: [] }));
  await assert.rejects(s.check('assigned'), denied);
  s.tables.projectContributors.delete('creator');
  await assert.rejects(s.check('creator'), denied);
});
test('a retained creation event remains authoritative before indexed identity enrichment', async () => {
  const s = setup();
  s.tables.projectWorkRecords.clear();
  s.tables.projectWorkEvents.set('event', {
    _id: 'event',
    projectId: 'project',
    operationId: s.intentId,
    actor: 'creator',
    command: JSON.stringify({ action: 'intent', base: s.intent.base }),
  });
  await s.check('creator');
  await assert.rejects(s.check('other'), denied);
});
test('a superseded partition cannot retain assignment authority', async () => {
  const s = setup();
  s.tables.projectWorkGenerations.get('generation').recordsGenerationId = 'replacement';
  await assert.rejects(s.check('assigned'), denied);
});
test('proposal details follow private reader and public project visibility; writes retain contributor checks', async () => {
  const s = setup(),
    proposal = { _id: 'proposal', projectId: 'project', actor: 'creator' };
  s.tables.projectProposals.set('proposal', proposal);
  s.tables.projectReaders.set('reader', { _id: 'reader', projectId: 'project', reader: 'reader' });
  assert.deepEqual(await proposals.get._handler(s.ctx, { id: 'proposal', actor: 'reader' }), proposal);
  await assert.rejects(proposals.get._handler(s.ctx, { id: 'proposal', actor: 'stranger' }), denied);
  s.tables.hostedProjects.get('project').visibility = 'public';
  assert.deepEqual(await proposals.get._handler(s.ctx, { id: 'proposal', actor: 'stranger' }), proposal);
  await assert.rejects(s.check('stranger'), denied);
  s.tables.hostedProjects.get('project').removal = 'trash';
  await assert.rejects(proposals.get._handler(s.ctx, { id: 'proposal', actor: 'reader' }), denied);
});

test('indexed Intent detail advertises current assignment rights without requiring a creation event', async () => {
  const s = setup();
  const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
  s.tables.projectBackups.set('backup', { _id: 'backup', projectId: 'project' });
  s.caller('assigned');
  const detail = await index.detail._handler(s.ctx, {
    projectId: 'project',
    collection: 'intents',
    id: s.intentId,
  });
  assert.equal(detail.editable, true);
  s.tables.projectContributors.delete('assigned');
  s.tables.projectReaders.set('assigned-reader', {
    _id: 'assigned-reader',
    projectId: 'project',
    reader: 'assigned',
  });
  assert.equal(
    (await index.detail._handler(s.ctx, { projectId: 'project', collection: 'intents', id: s.intentId }))
      .editable,
    false,
  );
});

test('a retained issue alias resolves to the current Intent assignment authority', async () => {
  const s = setup(),
    aliasId = randomUUID();
  s.tables.projectWorkRecords.set('alias', {
    _id: 'alias',
    generationId: 'generation',
    collection: 'intentAliases',
    key: aliasId,
    value: JSON.stringify({ aliasId, intentId: s.intentId }),
  });
  await intentAuthority(s.ctx, 'project', 'assigned', aliasId);
  await assert.rejects(intentAuthority(s.ctx, 'project', 'other', aliasId), denied);
});

test('assigned contributors can append notes and status atomically; revocation also blocks retries', async t => {
  const { setup: projectFixture } = await import('./hosted-planning-fixture.mjs');
  const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
  const s = await projectFixture(t);
  const creation = await s.send({
    action: 'intent',
    outcome: 'Assigned execution',
    constraints: '',
    base: s.preview.head,
  });
  const selected = s.tables.hostedProjects.get(s.projectId).work.generationId;
  const row = [...s.tables.projectWorkRecords.values()].find(
    r => r.generationId === selected && r.collection === 'intents' && r.key === creation.operationId,
  );
  row.value = JSON.stringify({ ...JSON.parse(row.value), assigneeAccountIds: ['assigned'] });
  s.tables.projectContributors.set('assigned', {
    _id: 'assigned',
    projectId: s.projectId,
    contributor: 'assigned',
  });
  s.caller('assigned');
  const note = {
    projectId: s.projectId,
    operationId: randomUUID(),
    command: JSON.stringify({
      action: 'note',
      intentId: creation.operationId,
      text: 'Assigned account note',
      kind: 'comment',
    }),
  };
  const receipt = await commands.command._handler(s.ctx, note);
  assert.equal(receipt.actor, 'assigned');
  assert.equal((await commands.command._handler(s.ctx, note))._id, receipt._id);
  await commands.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId: randomUUID(),
    command: JSON.stringify({
      action: 'intent-status',
      intentId: creation.operationId,
      status: 'ready',
    }),
  });
  s.tables.projectContributors.delete('assigned');
  await assert.rejects(commands.command._handler(s.ctx, note), denied);
  s.caller('owner');
  const after = await s.read();
  const updated = after.data.intents.find(i => i.id === creation.operationId);
  assert.equal(updated.notes.at(-1).text, 'Assigned account note');
  assert.equal(updated.status, 'active');
});

test('per-account authority remains usable when an oversized summary omits assignment fields', async () => {
  const s = setup();
  s.header.value = JSON.stringify({
    id: s.intentId,
    status: 'active',
    payloadKey: 'attributes',
    payloadParts: 2,
  });
  s.tables.projectWorkRecords.set('authority', {
    _id: 'authority',
    generationId: 'generation',
    collection: 'intentAuthorities',
    key: `${s.intentId}:assigned`,
    value: JSON.stringify({ intentId: s.intentId, accountId: 'assigned' }),
  });
  await s.check('assigned');
  await assert.rejects(s.check('other'), denied);
  s.tables.projectContributors.delete('assigned');
  await assert.rejects(s.check('assigned'), denied);
});
