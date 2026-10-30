import { captureNativeArchive } from './native-archive-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeClosureValidation } from '../dist/native-closure-validation.js';
import { NativeSource } from '../dist/native-source.js';
import { ForgeError } from '../dist/errors.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { workSchema } from '../dist/work-types.js';
import { mergeCompanion, reconcileHostedWork } from '../dist/native-companion.js';

import { digest } from '../dist/hash.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-closure-validation-')),
    root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'source original\n');
  initNative(root);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { directory, store: new WorkStore(root), source: new NativeSource(root) };
}
test('shared roots validate each unique State and blob once, with fresh checks in a new scope', t => {
  const { store, source } = fixture(t),
    roots = [],
    data = store.load();
  let head = data.nativeHead;
  const files = source.state(head).files;
  for (let i = 0; i < 40; i++) {
    head = source.writeState(files, [head], `state-${i}`, 'time');
    roots.push(head);
  }
  const states = new Map(),
    blobs = new Map(),
    reader = {
      state(id) {
        states.set(id, (states.get(id) ?? 0) + 1);
        return source.state(id);
      },
      object(id) {
        blobs.set(id, (blobs.get(id) ?? 0) + 1);
        return source.object(id);
      },
    };
  const scope = new NativeClosureValidation(reader);
  for (const root of [...roots, ...roots.slice().reverse()]) scope.validate(root);
  assert.equal(states.size, 41);
  assert.ok([...states.values()].every(count => count === 1));
  assert.equal(blobs.size, new Set(files.map(file => file.blob)).size);
  assert.ok([...blobs.values()].every(count => count === 1));
  writeFileSync(join(source.directory, files[0].blob), 'corrupted');
  assert.throws(
    () => new NativeClosureValidation(reader).validate(head),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
});

test('failed roots keep per-root errors and do not certify unvalidated ancestors; non-Forge errors propagate', () => {
  const bad = new ForgeError('INVALID_NATIVE_SOURCE', 'Missing retained blob'),
    fatal = new TypeError('unexpected decoder error');
  const calls = [],
    states = {
      a: { parents: ['base'], files: [{ blob: 'missing' }] },
      b: { parents: ['base'], files: [{ blob: 'valid' }] },
      base: { parents: [], files: [{ blob: 'shared' }] },
    };
  const scope = new NativeClosureValidation({
    state(id) {
      calls.push(`state:${id}`);
      return states[id];
    },
    object(id) {
      calls.push(`blob:${id}`);
      if (id === 'missing') throw bad;
    },
  });
  const conflicts = [];
  for (const root of ['a', 'b', 'a']) {
    try {
      scope.validate(root);
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      conflicts.push(root);
    }
  }
  assert.deepEqual(conflicts, ['a', 'a']);
  assert.equal(calls.filter(value => value === 'blob:missing').length, 1);
  assert.ok(calls.includes('blob:shared'), 'failing descendant did not certify its unchecked ancestor');
  assert.throws(
    () =>
      new NativeClosureValidation({
        state() {
          throw fatal;
        },
        object() {},
      }).validate('a'),
    error => error === fatal,
  );
});

test('a State validation failure does not invalidate the same content used as an ordinary blob', () => {
  const failure = new ForgeError('INVALID_NATIVE_SOURCE', 'Invalid State paths');
  const scope = new NativeClosureValidation({
    state(id) {
      if (id === 'invalid-state') throw failure;
      return { parents: [], files: [{ blob: 'invalid-state' }] };
    },
    object() {},
  });
  assert.throws(
    () => scope.validate('invalid-state'),
    error => error === failure,
  );
  assert.doesNotThrow(() => scope.validate('valid-state'));
});

test('Intent maps preserve first-match duplicates and append collision semantics', () => {
  const intent = {
    id: randomUUID(),
    outcome: 'original',
    constraints: '',
    base: 'a'.repeat(64),
    status: 'active',
    notes: [],
    createdAt: 'time',
  };
  const base = workSchema.parse({
    schema: 8,
    revision: 1,
    nativeHead: intent.base,
    intents: [intent, { ...intent, outcome: 'second duplicate' }],
    lanes: [],
    views: [],
  });
  const local = structuredClone(base),
    hosted = structuredClone(base);
  hosted.intents = [{ ...hosted.intents[0], status: 'ready' }];
  const first = mergeCompanion(base, local, hosted);
  assert.deepEqual(first.conflicts, []);
  assert.equal(first.merged.intents[0].status, 'ready');
  assert.equal(first.merged.intents[1].status, 'active');
  const added = { ...intent, id: randomUUID(), futureExtension: { exact: true } };
  hosted.intents.push(added, structuredClone(added));
  const merged = mergeCompanion(base, local, hosted);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.merged.intents.filter(value => value.id === added.id).length, 1);
  assert.deepEqual(merged.merged.intents.at(-1).futureExtension, added.futureExtension);
  hosted.intents.at(-1).outcome = 'changed same ID';
  assert.deepEqual(
    mergeCompanion(base, local, hosted).conflicts.map(value => [value.id, value.field]),
    [[added.id, 'identity']],
  );
});

async function exchangeCommand(f) {
  const data = f.store.load(),
    head = data.nativeHead;
  data.intents.push({
    id: randomUUID(),
    outcome: 'retained source',
    constraints: '',
    base: head,
    status: 'active',
    notes: [],
    createdAt: 'time',
  });
  f.store.save(data);
  const operation = randomUUID(),
    prepared = await captureNativeArchive(f.store, data.revision, operation),
    manifestSha256 = digest(prepared.json);
  const original = readFileSync(join(prepared.directory, 'work.json')),
    projectKey = randomUUID();
  const journal = {
    schema: 1,
    kind: 'forge-hosted-work-journal',
    projectKey,
    name: 'fixture',
    base: { archiveSha256: manifestSha256, manifestSha256, workSha256: digest(original) },
    events: [],
    revision: data.revision,
    workSha256: digest(original),
    coverage: 'fixture',
  };
  const journalPath = join(f.directory, 'journal.json'),
    bytes = JSON.stringify(journal);
  writeFileSync(journalPath, bytes);
  return {
    command: {
      action: 'reconcile-hosted-work',
      operationId: randomUUID(),
      transport: 'objects',
      projectKey,
      archivePath: prepared.directory,
      archiveSha256: manifestSha256,
      manifestSha256,
      journalPath,
      journalSha256: digest(bytes),
    },
    revision: data.revision,
    head,
  };
}
test('final reconciliation lock revalidates after the unlocked validation and preserves Work on corruption', async t => {
  const f = fixture(t),
    { command, revision, head } = await exchangeCommand(f),
    original = f.store.snapshotBytes();
  const blob = f.source.state(head).files[0].blob,
    lock = f.store.locked.bind(f.store);
  let locks = 0;
  f.store.locked = callback =>
    lock(() => {
      if (++locks === 2) writeFileSync(join(f.source.directory, blob), 'changed in validation gap');
      return callback();
    });
  const result = await reconcileHostedWork(f.store, command, revision);
  assert.equal(result.result.status, 'conflict');
  assert.deepEqual(result.result.conflicts, [{ collection: 'source', field: 'retainedState', hosted: head }]);
  assert.deepEqual(f.store.snapshotBytes(), original);
});
test('successful reconciliation original receipt retry does not introduce fresh source validation', async t => {
  const f = fixture(t),
    { command, revision, head } = await exchangeCommand(f);
  const first = await reconcileHostedWork(f.store, command, revision);
  assert.equal(first.result.status, 'reconciled');
  writeFileSync(join(f.source.directory, f.source.state(head).files[0].blob), 'changed after commit');
  assert.deepEqual(await reconcileHostedWork(f.store, command, revision), first);
});
