// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { exportNativeWork, restoreNativeWork } from '../dist/native-backup.js';
import { prepareNativeExchange, pushNativeExchange, pullNativeExchange } from '../dist/native-exchange.js';
import { reconcileHostedWork } from '../dist/native-companion.js';
import { applyHostedEvent, metadataRequest, parseWorkBytes, workBytes } from '../dist/work-metadata.js';
import { migrateHostedIntents } from '../dist/work-hosted-intents.js';
import { digest } from '../dist/hash.js';

function journalFixture(base, archiveSha256, manifestBytes, original) {
  const projectKey = randomUUID(),
    at = '2026-01-01T00:00:00Z',
    events = [];
  const append = (data, command) => {
    const event = {
      id: randomUUID(),
      projectKey,
      archiveSha256,
      actor: 'synthetic-owner',
      at,
      previousRevision: data.revision,
      request: metadataRequest(command),
      command,
    };
    applyHostedEvent(data, event);
    events.push(event);
  };
  let hosted = structuredClone(base);
  append(hosted, {
    action: 'source-return',
    archiveSha256,
    workSha256: digest(workBytes(hosted)),
    previousArchiveSha256: 'b'.repeat(64),
    previousRevision: base.revision,
  });
  const intentMigration = { operationId: randomUUID(), revision: hosted.revision };
  hosted = migrateHostedIntents(hosted, intentMigration);
  append(hosted, {
    action: 'note',
    intentId: base.intents[0].id,
    text: 'Already received after cutover',
    kind: 'comment',
  });
  // A later source return pins unified bytes and proves conversion happened at
  // the marker, rather than being deferred until the prefix finished replaying.
  append(hosted, {
    action: 'source-return',
    archiveSha256,
    workSha256: digest(workBytes(hosted)),
    previousArchiveSha256: 'b'.repeat(64),
    previousRevision: base.revision,
  });
  const local = structuredClone(hosted);
  local.revision += 4; // Independent owner writes do not change hosted event identities.
  append(hosted, { action: 'note', intentId: base.intents[0].id, text: 'New hosted note', kind: 'comment' });
  return {
    local,
    hosted,
    journal: {
      schema: 1,
      kind: 'forge-hosted-work-journal',
      projectKey,
      name: 'Synthetic cutover',
      base: { archiveSha256, manifestSha256: digest(manifestBytes), workSha256: digest(original) },
      intentMigration,
      events,
      revision: hosted.revision,
      workSha256: digest(workBytes(hosted)),
      coverage: 'Synthetic fixture',
    },
  };
}

test('push reconciliation, object pull and archive restore replay legacy source returns before the cutover', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-exchange-cutover-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'source.ts'), 'export const synthetic = true;\n');
  initNative(root);
  const service = new WorkService(root),
    store = service.store;
  service.execute({ action: 'intent', outcome: 'Synthetic legacy execution' }, store.load().revision);
  const initial = store.load();
  initial.schema = 15;
  store.save(initial);
  const objects = new Map();
  const transport = {
    missing: async pins => pins.filter(pin => !objects.has(pin.sha256)).map(pin => pin.sha256),
    upload: async (pin, bytes) => {
      objects.set(pin.sha256, Buffer.from(bytes));
    },
    publish: async pin => pin.sha256,
    manifest: async id => ({ json: objects.get(id).toString(), digest: id, size: objects.get(id).length }),
    download: async pin => Buffer.from(objects.get(pin.sha256)),
  };
  const checkpoint = await pushNativeExchange(store, initial.revision, randomUUID(), transport);
  const manifestBytes = objects.get(checkpoint.backupId),
    manifest = JSON.parse(manifestBytes);
  const original = objects.get(manifest.files.find(pin => pin.path === 'work.json').sha256);
  const base = parseWorkBytes(original);
  const f = journalFixture(base, checkpoint.backupId, manifestBytes, original);
  const directory = join(dir, 'received');
  mkdirSync(directory);
  writeFileSync(join(directory, 'manifest.json'), manifestBytes);
  writeFileSync(join(directory, 'work.json'), original);
  const journalPath = join(directory, 'journal.json'),
    journalBytes = JSON.stringify(f.journal);
  writeFileSync(journalPath, journalBytes);
  const exported = await exportNativeWork(store, initial.revision, true);
  store.save(f.local);
  let candidate;
  const command = {
    action: 'reconcile-hosted-work',
    transport: 'objects',
    preserveLocalSource: true,
    operationId: randomUUID(),
    projectKey: f.journal.projectKey,
    archivePath: directory,
    archiveSha256: checkpoint.backupId,
    manifestSha256: digest(manifestBytes),
    journalPath,
    journalSha256: digest(journalBytes),
  };
  const result = await reconcileHostedWork(store, command, f.local.revision, {
    candidate: structuredClone(f.local),
    onCandidate: data => {
      candidate = data;
    },
  });
  assert.equal(result.result.status, 'reconciled');
  for (const data of [store.load(), candidate]) {
    assert.equal(data.schema, 18);
    assert.deepEqual(data.hostedEvents, f.hosted.hostedEvents);
    assert.deepEqual(data.intents[0].notes, f.hosted.intents[0].notes);
    assert.deepEqual(data.intents[0].conversation, f.hosted.intents[0].conversation);
  }
  const prepared = await prepareNativeExchange(
    store,
    candidate.revision,
    randomUUID(),
    false,
    undefined,
    undefined,
    { captured: { directory, data: candidate } },
  );
  assert.equal(parseWorkBytes(readFileSync(join(prepared.directory, 'work.json'))).schema, 18);
  const pulled = join(dir, 'pulled');
  await pullNativeExchange(checkpoint.backupId, pulled, transport, { journalPath });
  assert.deepEqual(new WorkStore(pulled).load().intents, f.hosted.intents);
  assert.equal(
    (await reconcileHostedWork(store, command, store.load().revision)).result.status,
    'reconciled',
  );

  // Independent archive transport uses the same event sequence and cutover rules.

  const archiveManifest = readFileSync(join(exported.result.path, 'manifest.json'));
  const archiveWork = readFileSync(join(exported.result.path, 'work.json'));
  const archive = journalFixture(
    parseWorkBytes(archiveWork),
    exported.result.archive.sha256,
    archiveManifest,
    archiveWork,
  );
  const archiveJournal = join(dir, 'archive-journal.json');
  writeFileSync(archiveJournal, JSON.stringify(archive.journal));
  const restored = join(dir, 'restored');
  await restoreNativeWork(exported.result.archive.path, restored, archiveJournal);
  const restoredData = new WorkStore(restored).load();
  assert.equal(restoredData.schema, 18);
  assert.deepEqual(restoredData.hostedEvents, archive.hosted.hostedEvents);
  assert.deepEqual(restoredData.intents, archive.hosted.intents);
});

test('source-return digest errors identify the exact event and original pins', () => {
  const data = parseWorkBytes(
    Buffer.from(JSON.stringify({ schema: 15, revision: 4, intents: [], lanes: [], views: [] })),
  );
  const actual = digest(workBytes(data)),
    expected = 'a'.repeat(64);
  const command = {
    action: 'source-return',
    archiveSha256: 'b'.repeat(64),
    workSha256: expected,
    previousArchiveSha256: 'c'.repeat(64),
    previousRevision: 4,
  };
  const event = {
    id: randomUUID(),
    projectKey: randomUUID(),
    archiveSha256: command.archiveSha256,
    actor: 'synthetic',
    at: 'synthetic',
    previousRevision: 4,
    command,
    request: metadataRequest(command),
  };
  assert.throws(
    () => applyHostedEvent(data, event),
    error => {
      assert.equal(error.code, 'INVALID_WORK_JOURNAL');
      for (const part of [
        event.id,
        'revision 5',
        'action source-return',
        expected.slice(0, 12),
        actual.slice(0, 12),
      ])
        assert.ok(error.message.includes(part), error.message);
      return true;
    },
  );
  assert.equal(data.revision, 4);
  assert.deepEqual(data.hostedEvents, []);
});
