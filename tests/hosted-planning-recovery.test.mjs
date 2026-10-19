// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { restoreWork } from '../dist/work-backup.js';
import { digest } from '../dist/hash.js';
import { setup, actions } from './hosted-planning-fixture.mjs';
const code = name => error => error.code === name;
async function journal(s) {
  const text = await actions.exportJournal._handler(s.ctx, { projectId: s.projectId }),
    path = join(s.directory, randomUUID() + '.json');
  writeFileSync(path, text, { mode: 0o600 });
  return { text, path, value: JSON.parse(text) };
}
const command = (s, j) => ({
  action: 'reconcile-hosted-work',
  operationId: randomUUID(),
  projectKey: j.value.projectKey,
  archivePath: s.exported.archive.path,
  archiveSha256: digest(s.bytes),
  journalPath: j.path,
  journalSha256: digest(j.text),
});
const dispatch = (local, input) => local.dispatch(input, local.status().revision);

test('whole planning history, historical Intent links and original actor observations survive native/Git archive journals and fresh native backups', async t => {
  for (const native of [true, false]) {
    const s = await setup(t, native),
      head = (await s.read()).sourceHead;
    const created = await s.send({
      action: 'intent',
      outcome: 'Optional existing work',
      constraints: '',
      base: head,
    });
    const initiative = s.item({ kind: 'initiative' });
    await s.send(initiative);
    const issue = s.item({ initiativeId: initiative.itemId, intentIds: [created.operationId] });
    await s.send(issue);
    await s.send(
      s.item({ ...issue, operationId: randomUUID(), expectedVersion: 1, status: 'closed', intentIds: [] }),
    );
    await s.send({
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId: issue.itemId,
      authorLabel: 'Offline supplied alias',
      text: 'History stays literal.',
    });
    const hosted = (await s.read()).data,
      exported = JSON.parse(await actions.exportPlanning._handler(s.ctx, { projectId: s.projectId }));
    assert.deepEqual(
      JSON.parse(exported.json).linkedIntents,
      hosted.intents,
      'Historical links remain in JSON after latest version unlinks.',
    );
    const j = await journal(s),
      target = join(s.directory, 'fresh-recovery');
    await (native ? restoreNativeWork : restoreWork)(s.exported.archive.path, target, j.path);
    const recovered = new WorkService(target).store.load();
    for (const field of [
      'intents',
      'planningItems',
      'planningComments',
      'hostedEvents',
      'channelMoves',
      'views',
      'lanes',
    ])
      assert.deepEqual(recovered[field], hosted[field]);
    assert.equal(readFileSync(join(target, 'a.ts'), 'utf8'), readFileSync(join(s.root, 'a.ts'), 'utf8'));
    if (native) {
      const w = new WorkService(target),
        full = (await dispatch(w, { action: 'export-work', archive: true })).result,
        next = join(s.directory, 'second-native-recovery');
      await restoreNativeWork(full.archive.path, next);
      assert.deepEqual(
        readWorkBytes(join(next, '.forge/work/work.json')),
        readWorkBytes(join(target, '.forge/work/work.json')),
        'Complete native backup retains original Work bytes.',
      );
      assert.equal(readFileSync(join(next, 'a.ts'), 'utf8'), readFileSync(join(target, 'a.ts'), 'utf8'));
    }
    const altered = JSON.parse(j.text);
    altered.events[0].request = '0'.repeat(64);
    const bad = join(s.directory, 'bad.json');
    writeFileSync(bad, JSON.stringify(altered));
    const rejected = join(s.directory, 'rejected-recovery');
    await assert.rejects(
      (native ? restoreNativeWork : restoreWork)(s.exported.archive.path, rejected, bad),
      code('INVALID_WORK_JOURNAL'),
    );
    assert.equal(existsSync(rejected), false, 'Malformed journal creates no restore owner.');
  }
});

test('native companion retains independent local planning/source and reconciles same original reply, while divergent item versions never overwrite', async t => {
  const s = await setup(t),
    local = s.local,
    original = local.store.load(),
    commonSource = readFileSync(join(s.root, 'a.ts'));
  const independent = s.item({ title: 'Independent local Issue' });
  await dispatch(local, independent);
  const remote = s.item({ title: 'Hosted Issue' });
  await s.send(remote);
  await s.send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: remote.itemId,
    authorLabel: 'Owner alias',
    text: 'Original discussion',
  });
  writeFileSync(join(s.root, 'a.ts'), 'uncheckpointed local source remains exact\n');
  const dirty = readFileSync(join(s.root, 'a.ts')),
    j = await journal(s),
    input = command(s, j);
  const result = await dispatch(local, input);
  assert.equal(result.result.status, 'reconciled');
  assert.deepEqual(
    local.store.load().planningItems.map(item => item.title),
    ['Hosted Issue', 'Independent local Issue'],
  );
  assert.equal(local.store.load().planningComments[0].authorLabel, 'Owner alias');
  assert.deepEqual(local.store.load().hostedEvents, (await s.read()).data.hostedEvents);
  assert.deepEqual(readFileSync(join(s.root, 'a.ts')), dirty);
  for (const field of ['nativeHead', 'channelMoves', 'views', 'lanes', 'runs'])
    assert.deepEqual(local.store.load()[field], original[field]);
  const once = readWorkBytes(join(local.store.directory, 'work.json'));
  const retry = await local.dispatch(
    { ...input, archivePath: '/missing/original', journalPath: '/missing/original' },
    0,
  );
  assert.deepEqual(retry.result.receipt, result.result.receipt);
  assert.deepEqual(readWorkBytes(join(local.store.directory, 'work.json')), once);
  await assert.rejects(
    local.dispatch({ ...input, journalSha256: '0'.repeat(64) }, 0),
    code('WORK_OPERATION_CHANGED'),
  );
  await dispatch(
    local,
    s.item({ ...remote, operationId: randomUUID(), expectedVersion: 1, title: 'Local competing version' }),
  );
  await s.send(
    s.item({ ...remote, operationId: randomUUID(), expectedVersion: 1, title: 'Hosted competing version' }),
  );
  const next = command(s, await journal(s)),
    before = readWorkBytes(join(local.store.directory, 'work.json'));
  const conflict = await dispatch(local, next);
  assert.equal(conflict.result.status, 'conflict');
  assert.ok(
    conflict.result.conflicts.some(item => item.collection === 'planningItems' && item.id === remote.itemId),
    JSON.stringify(conflict.result.conflicts),
  );
  assert.deepEqual(readWorkBytes(join(local.store.directory, 'work.json')), before);
  assert.deepEqual(readFileSync(join(s.root, 'a.ts')), dirty);
  assert.notDeepEqual(dirty, commonSource);
});

test('source return retains every original planning version/comment, appends local history and recovers a second exact journal', async t => {
  const { returns } = await import('./hosted-planning-fixture.mjs');
  const { workArchiveMetadata } = await import('../dist/work-archive-metadata.js');
  const { workBytes } = await import('../dist/work-metadata.js');
  const { withWorkArchive, packWorkArchive } = await import('../dist/work-backup-archive.js');
  const s = await setup(t),
    issue = s.item();
  await s.send(issue);
  await s.send(s.item({ ...issue, operationId: randomUUID(), expectedVersion: 1, status: 'closed' }));
  await s.send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: issue.itemId,
    authorLabel: 'Declared alias',
    text: 'Original discussion',
  });
  await dispatch(s.local, command(s, await journal(s)));
  await dispatch(
    s.local,
    s.item({
      ...issue,
      operationId: randomUUID(),
      expectedVersion: 2,
      status: 'open',
      title: 'Appended locally',
    }),
  );
  await dispatch(s.local, {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: issue.itemId,
    authorLabel: 'Local alias',
    text: 'Appended local discussion',
  });
  const exported = (await dispatch(s.local, { action: 'export-work', archive: true })).result;
  async function stored(bytes, id) {
    const metadata = await workArchiveMetadata(new Blob([bytes])),
      manifest = JSON.parse(Buffer.from(metadata.manifest)),
      data = JSON.parse(Buffer.from(metadata.work));
    s.tables.projectBackups.set(id, {
      _id: id,
      _creationTime: 1,
      projectId: s.projectId,
      operationId: randomUUID(),
      request: 'a'.repeat(64),
      nonce: randomUUID(),
      previous: s.backupId,
      digest: digest(bytes),
      size: bytes.length,
      preview: {
        manifestDigest: digest(metadata.manifest),
        head: manifest.head,
        format: 'native',
        revision: data.revision,
        intents: data.intents.length,
        lanes: data.lanes.length,
        views: data.views.length,
        runs: data.runs.length,
        files: manifest.files.length,
        unavailable: manifest.unavailable.length,
        channels: [],
      },
      status: 'stored',
      storageId: id,
    });
    s.files.set(id, { blob: new Blob([bytes], { type: 'application/gzip' }) });
  }
  const valid = readFileSync(exported.archive.path);
  await stored(valid, 'returned');
  const before = await s.read(),
    input = {
      projectId: s.projectId,
      backupId: 'returned',
      expectedBackupId: s.backupId,
      revision: before.data.revision,
      operationId: randomUUID(),
    };
  for (const alteration of ['drop-version', 'change-version', 'change-comment']) {
    const altered = await withWorkArchive(exported.archive.path, async directory => {
      const data = JSON.parse(readWorkBytes(join(directory, 'work.json')));
      if (alteration === 'drop-version')
        data.planningItems = data.planningItems.filter(item => item.version !== 1);
      if (alteration === 'change-version') data.planningItems[0].body = 'Changed original details';
      if (alteration === 'change-comment') data.planningComments[0].authorLabel = 'Changed original alias';
      const text = workBytes(data);
      writeFileSync(join(directory, 'work.json'), text);
      const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
      Object.assign(
        manifest.files.find(file => file.path === 'work.json'),
        { size: Buffer.byteLength(text), sha256: digest(text) },
      );
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
      return readFileSync(
        (
          await packWorkArchive(
            directory,
            manifest.files.map(file => file.path),
          )
        ).path,
      );
    });
    await stored(altered, alteration);
    await assert.rejects(
      returns.returnSource._handler(s.ctx, { ...input, backupId: alteration, operationId: randomUUID() }),
      error => error.data?.code === 'INVALID_WORK_JOURNAL',
    );
    assert.deepEqual(await s.read(), before);
  }
  const receipt = await returns.returnSource._handler(s.ctx, input),
    again = await returns.returnSource._handler(s.ctx, input);
  assert.deepEqual(again, receipt);
  const hosted = (await s.read()).data;
  assert.equal(hosted.planningItems.length, 3);
  assert.equal(hosted.planningComments.length, 2);
  assert.equal(
    s.tables.hostedProjects.get(s.projectId).currentBackup,
    s.backupId,
    'Work source selection retains existing separately managed source pointer.',
  );
  assert.equal(s.tables.hostedProjects.get(s.projectId).work.backupId, 'returned');
  const j = await journal(s),
    target = join(s.directory, 'second-journal-recovery');
  await restoreNativeWork(exported.archive.path, target, j.path);
  const recovered = new WorkService(target).store.load();
  for (const key of [
    'planningItems',
    'planningComments',
    'hostedEvents',
    'nativeCompanionReceipts',
    'nativeHead',
    'lanes',
    'views',
    'channelMoves',
  ])
    assert.deepEqual(recovered[key], hosted[key]);
  assert.equal(readFileSync(join(target, 'a.ts'), 'utf8'), readFileSync(join(s.root, 'a.ts'), 'utf8'));
});
