import { commitValidatedCheckpoint } from './project-exchange-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { restoreNativeWork } from '../dist/native-backup.js';
import { workSchema } from '../dist/work-types.js';
import { applyHostedEvent, metadataRequest } from '../dist/work-metadata.js';
import { fixture, checkpoint, preparedCheckpoint, modules } from './project-exchange-fixture.mjs';
import { readHosted } from './hosted-read.mjs';

function prepare(store) {
  const data = store.load(),
    head = data.nativeHead,
    intentId = randomUUID(),
    viewId = randomUUID();
  data.intents.push({
    id: intentId,
    outcome: 'Review synthetic source',
    constraints: '',
    base: head,
    status: 'active',
    notes: [],
    createdAt: 'now',
  });
  data.views.push({
    id: viewId,
    intentId,
    base: head,
    head,
    inputs: [],
    status: 'clean',
    details: 'Synthetic exact View',
    at: 'now',
  });
  data.revision++;
  store.save(data);
  const source = new NativeSource(store.root),
    file = source.state(head).files[0];
  return {
    action: 'note',
    intentId,
    kind: 'comment',
    text: 'Explain this line',
    anchor: { viewId, base: head, head, file: file.path, side: 'after', line: 1, blob: file.blob },
  };
}
test('line comments retain exact source through narrow appends, lifecycle, export/restore and journal replay', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-anchors-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'const value = 1;\n');
  initNative(root);
  const work = new WorkService(root),
    command = prepare(work.store),
    before = work.store.load();
  const act = c => work.execute(c, work.store.revision()).result;
  act(command);
  assert.deepEqual(work.store.load().intents[0].notes[0].anchor, command.anchor);
  assert.equal(work.store.load().schema, 24);
  act({ action: 'intent-status', intentId: command.intentId, status: 'completed' });
  assert.equal(work.store.load().schema, 24);
  act({ action: 'note', intentId: command.intentId, kind: 'comment', text: 'Ordinary notes still work' });
  const older = work.store.load();
  older.schema = 7;
  assert.throws(() => work.store.save(older), { code: 'WORK_UPGRADE_REQUIRED' });
  assert.equal(work.store.load().schema, 24);
  const exported = (await work.dispatch({ action: 'export-work', archive: true }, work.store.revision()))
      .result,
    target = root + '-restored';
  t.after(() => rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await restoreNativeWork(exported.archive.path, target);
  assert.deepEqual(new WorkService(target).store.load().intents[0].notes[0].anchor, command.anchor);
  const event = {
    projectKey: randomUUID(),
    archiveSha256: 'a'.repeat(64),
    id: randomUUID(),
    actor: 'owner',
    at: 'now',
    request: metadataRequest(command),
    previousRevision: before.revision,
    command,
  };
  applyHostedEvent(before, event);
  assert.equal(before.schema, 24);
  assert.deepEqual(before.intents[0].notes[0].anchor, command.anchor);
  for (const patch of [
    { line: 99 },
    { blob: 'f'.repeat(64) },
    { file: '../outside' },
    { head: 'e'.repeat(64) },
    { viewId: randomUUID() },
  ])
    assert.throws(() => act({ ...command, anchor: { ...command.anchor, ...patch } }));
  assert.equal(work.store.load().intents[0].notes.length, 2);
});
test('hosted line comments validate current source, preserve one retry and reject mismatched anchors without writing', async t => {
  const s = fixture(),
    first = await checkpoint(t, s),
    command = prepare(first.store),
    source = await preparedCheckpoint(s, first.store),
    backupId = await commitValidatedCheckpoint(s, source);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const read = async () => JSON.parse(await readHosted(s.ctx, { projectId: 'project' })),
    before = await read(),
    operationId = randomUUID(),
    input = {
      projectId: 'project',
      operationId,
      revision: before.data.revision,
      command: JSON.stringify(command),
    };
  const result = await modules.projectWorkActions.command._handler(s.ctx, input);
  assert.equal((await modules.projectWorkActions.command._handler(s.ctx, input))._id, result._id);
  let after = await read();
  assert.equal(after.data.schema, 24); // policy-bearing owners cannot be downgraded by anchors
  assert.deepEqual(after.data.intents[0].notes[0].anchor, command.anchor);
  for (const patch of [
    { line: 99 },
    { blob: 'f'.repeat(64) },
    { file: '../outside' },
    { head: 'e'.repeat(64) },
    { viewId: randomUUID() },
  ])
    await assert.rejects(
      modules.projectWorkActions.command._handler(s.ctx, {
        ...input,
        operationId: randomUUID(),
        revision: after.data.revision,
        command: JSON.stringify({ ...command, anchor: { ...command.anchor, ...patch } }),
      }),
    );
  after = await read();
  assert.equal(after.data.intents[0].notes.length, 1);
  s.caller('stranger');
  await assert.rejects(
    modules.projectWorkActions.command._handler(s.ctx, {
      ...input,
      operationId: randomUUID(),
      revision: after.data.revision,
    }),
  );
});
