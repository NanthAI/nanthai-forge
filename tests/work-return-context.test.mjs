// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workSchema } from '../dist/work-types.js';
import { buildWorkRecords } from '../dist/work-exchange-records.js';
import { buildWorkDelta } from '../dist/work-exchange-delta.js';
import { workDeltaSelection } from '../dist/work-exchange-context.js';
import { hostedPushWork } from '../dist/work-intent-local.js';
import { prepareRecordReturn, preservesParsedWorkBytes } from '../dist/work-return-context.js';
import { validateSourceReturn } from '../dist/work-source-return.js';

test('600 retained Intent bodies use bounded pages and preserve full source-return validation', async () => {
  const head = 'a'.repeat(64),
    before = workSchema.parse({
      schema: 23,
      revision: 7,
      nativeHead: head,
      lanes: [],
      views: [],
      intents: Array.from({ length: 600 }, () => ({
        id: randomUUID(),
        base: head,
        outcome: 'Synthetic',
        constraints: '',
        status: 'active',
        notes: Array.from({ length: 2 }, () => ({
          kind: 'comment',
          text: 'Synthetic history '.repeat(200),
          at: 'now',
        })),
        createdAt: 'now',
      })),
    });
  const after = structuredClone(before);
  after.revision++;
  for (const intent of after.intents) intent.notes.push({ kind: 'comment', text: 'Updated', at: 'later' });
  const old = buildWorkRecords(before),
    next = buildWorkRecords(after);
  const delta = buildWorkDelta(old.root, next.root, old.pin.sha256);
  const objects = new Map([...old.objects, ...next.objects]);
  const manifest = {
    schema: 1,
    kind: 'forge-native-work-backup',
    id: randomUUID(),
    head,
    revision: after.revision,
    coverage: 'Synthetic',
    unavailable: [],
    files: [{ path: `objects/${head}`, sha256: head, size: 0 }],
  };
  let pages = 0,
    maxPins = 0,
    maxBytes = 0;
  const read = async pin => objects.get(pin.sha256);
  const result = await prepareRecordReturn(
    old.root,
    next.root,
    delta,
    [],
    manifest,
    before.revision,
    'b'.repeat(64),
    read,
    async pins => {
      pages++;
      maxPins = Math.max(maxPins, pins.length);
      maxBytes = Math.max(
        maxBytes,
        pins.reduce((sum, pin) => sum + pin.size, 0),
      );
      return Promise.all(pins.map(read));
    },
  );
  assert.equal(result.validated.validated, 600);
  assert(workDeltaSelection(old.root, next.root, delta).bytes > 4 * 1024 * 1024);
  assert.equal(pages, 12);
  assert.equal(maxPins, 100);
  assert(maxBytes <= 2 * 1024 * 1024);
  validateSourceReturn(before, after, manifest);
  after.intents[0].constraints = 'Changed original constraint';
  const bad = buildWorkRecords(after),
    badDelta = buildWorkDelta(old.root, bad.root, old.pin.sha256);
  for (const [key, value] of bad.objects) objects.set(key, value);
  assert.throws(
    () => validateSourceReturn(before, after, manifest),
    error => error.code === 'INVALID_WORK_JOURNAL',
  );
  await assert.rejects(
    prepareRecordReturn(
      old.root,
      bad.root,
      badDelta,
      [],
      manifest,
      before.revision,
      'b'.repeat(64),
      read,
      pins => Promise.all(pins.map(read)),
    ),
    error => error.code === 'INVALID_WORK_JOURNAL',
  );
});

test('new captures order late optional collections like journal parsing without rewriting retained records', () => {
  const data = workSchema.parse({
    schema: 23,
    revision: 0,
    nativeHead: 'a'.repeat(64),
    intents: [],
    lanes: [],
    views: [],
  });
  data.nativeCompanionReceipts = [];
  data.extension = { private: 'Synthetic uninterpreted fields' };
  const keys = Object.keys(data),
    original = buildWorkRecords(data);
  assert.equal(preservesParsedWorkBytes(original.root), false);
  const pushed = hostedPushWork(data);
  assert.equal(preservesParsedWorkBytes(buildWorkRecords(pushed).root), true);
  assert.deepEqual(Object.keys(data), keys);
  assert.equal(pushed.intents, data.intents);
  assert.equal(pushed.nativeCompanionReceipts, data.nativeCompanionReceipts);
  assert.equal(pushed.extension, data.extension);
  assert.deepEqual(pushed, data);
});
