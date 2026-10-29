// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { digest } from '../dist/hash.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { prepareNativeExchange, pushNativeExchange } from '../dist/native-exchange.js';
import { reconcileHostedWork } from '../dist/native-companion.js';
import { pushAttemptId } from '../dist/bound-exchange.js';
import { fixture, modules, upload } from './project-exchange-fixture.mjs';

function owner(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pinned-push-')),
    root = join(dir, 'owner');
  mkdirSync(root);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  return { dir, store: new WorkStore(root) };
}
// A concurrent local writer, such as a post-accept audit recording its run.
function localWrite(store, outcome = 'Concurrent local write') {
  const id = randomUUID();
  store.locked(() => {
    const tx = store.records();
    tx.append('intents', {
      id,
      outcome,
      constraints: '',
      base: tx.data().nativeHead,
      status: 'active',
      createdAt: new Date().toISOString(),
      notes: [],
    });
    store.commitRecords(tx);
  });
  return id;
}

test('pinned push snapshot takes the current revision once; retries reuse the retained snapshot', async t => {
  const { store } = owner(t),
    floor = store.revision();
  localWrite(store);
  const pinnedRevision = store.revision(),
    operationId = randomUUID();
  const first = await prepareNativeExchange(store, floor, operationId, true, undefined, undefined, {
    pinCurrent: true,
  });
  assert.equal(first.manifest.revision, pinnedRevision);
  localWrite(store);
  const retry = await prepareNativeExchange(store, floor, operationId, true, undefined, undefined, {
    pinCurrent: true,
  });
  assert.equal(retry.json, first.json, 'same operation never recaptures newer Work');
  await assert.rejects(
    prepareNativeExchange(store, floor, randomUUID(), true),
    error => error.code === 'WORK_STALE',
    'exact-revision callers keep their contract',
  );
  await assert.rejects(
    prepareNativeExchange(store, store.revision() + 1, randomUUID(), true, undefined, undefined, {
      pinCurrent: true,
    }),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
});

test('reconcile for a push merges hosted metadata into local Work written during validation', async t => {
  const s = fixture(),
    { dir, store } = owner(t);
  const transport = {
    missing: pins =>
      modules.projectObjects.missing._handler(s.ctx, {
        projectId: 'project',
        objects: pins.map(p => ({ digest: p.sha256, size: p.size })),
      }),
    upload: async (_pin, bytes) => {
      await upload(s, bytes);
    },
    publish: (p, _metadataOnly, ownerDerived) =>
      modules.projectExchangeActions.publish._handler(s.ctx, {
        displayProtocol: 3,
        ownerDerived,
        projectId: 'project',
        operationId: randomUUID(),
        previous: null,
        digest: p.sha256,
        size: p.size,
      }),
  };
  const firstOperation = randomUUID(),
    first = await pushNativeExchange(store, store.revision(), firstOperation, transport);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId: first.backupId,
    operationId: randomUUID(),
  });
  const hostedIntent = randomUUID();
  await modules.projectWorkActions.command._handler(s.ctx, {
    projectId: 'project',
    operationId: hostedIntent,
    revision: s.tables.hostedProjects.get('project').work.revision,
    command: JSON.stringify({
      action: 'intent',
      outcome: 'Hosted task',
      constraints: '',
      base: store.load().nativeHead,
    }),
  });
  const journal = await modules.projectWorkActions.exportJournal._handler(s.ctx, { projectId: 'project' }),
    journalPath = join(dir, 'journal.json');
  writeFileSync(journalPath, journal);
  const command = () => ({
    action: 'reconcile-hosted-work',
    transport: 'objects',
    operationId: randomUUID(),
    projectKey: JSON.parse(journal).projectKey,
    archivePath: join(store.directory, `exchange-${firstOperation}`),
    archiveSha256: first.digest,
    journalPath,
    journalSha256: digest(journal),
  });
  // Inject a local write between validation (outside the lock) and publication.
  const racing = new WorkStore(store.root),
    locked = racing.locked.bind(racing);
  let calls = 0,
    concurrent;
  racing.locked = (run, options) => {
    if (++calls === 2) concurrent = localWrite(new WorkStore(store.root), 'Audit run record');
    return locked(run, options);
  };
  const floor = store.revision();
  await assert.rejects(
    reconcileHostedWork(racing, command(), floor),
    error => error.code === 'WORK_STALE',
    'standalone reconcile keeps its exact-revision CAS',
  );
  calls = 0;
  const captured = store.load(),
    pushCommand = command();
  let candidate;
  const options = {
    followLocal: true,
    candidate: captured,
    onCandidate: data => {
      candidate = data;
    },
  };
  const merged = await reconcileHostedWork(racing, pushCommand, floor, options);
  assert.equal(merged.result.status, 'reconciled');
  const ids = store.load().intents.map(intent => intent.id);
  assert(ids.includes(hostedIntent), 'hosted metadata merged');
  assert(ids.includes(concurrent), 'the later local write is preserved');
  assert.equal(merged.revision, store.revision());
  assert.deepEqual(merged.result.receipt.eventIds, [hostedIntent]);
  assert(candidate.intents.some(intent => intent.id === hostedIntent));
  assert(
    !candidate.intents.some(intent => intent.id === concurrent),
    'the original candidate excludes later local writes',
  );
  const firstCandidate = structuredClone(candidate);
  localWrite(store, 'Work written after a lost reconciliation reply');
  await reconcileHostedWork(racing, pushCommand, floor, options);
  assert.deepEqual(candidate, firstCandidate, 'replaying the receipt reproduces the same candidate');
});

test('rebase attempt IDs are deterministic UUIDs per parent, attempt and phase', () => {
  const parent = randomUUID(),
    ids = [1, 2, 3].flatMap(attempt =>
      ['push', 'reconcile', 'return', 'capture'].map(phase => pushAttemptId(parent, attempt, phase)),
    );
  assert.deepEqual(
    ids,
    [1, 2, 3].flatMap(attempt =>
      ['push', 'reconcile', 'return', 'capture'].map(phase => pushAttemptId(parent, attempt, phase)),
    ),
  );
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert(z.uuid().safeParse(id).success, id);
  assert.notEqual(pushAttemptId(randomUUID(), 1, 'push'), ids[0]);
});
