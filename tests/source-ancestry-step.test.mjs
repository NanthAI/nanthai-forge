// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initialSourceStep, runSourceStep } from '../dist/hosted-source-step.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { MemoryMergeSource } from '../dist/hosted-source-memory.js';
import { saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';

test('real stepped compose stops at the root-relative base after that base was prefetched', async t => {
  const objects = new Map(),
    parents = {},
    reads = [],
    describes = [];
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const json = value => put(saveBytes(value));
  const file = (path, text) => ({ path, blob: put(text).sha256, mode: 'file' });
  const at = '2026-01-01T00:00:00.000Z';
  const state = (files, edges = [], message = '') => {
    const pin = json({ schema: 1, kind: 'forge-source-state', files, parents: edges, message, at });
    parents[pin.sha256] = edges;
    return pin;
  };
  const oldA = state([], [], 'older A'),
    oldB = state([], [], 'older B');
  const baseFiles = [file('f', 'base\n')];
  const base = state(baseFiles, [oldA.sha256, oldB.sha256]);
  const aFiles = [...baseFiles, file('a', 'a')],
    bFiles = [...baseFiles, file('b', 'b')];
  let a = state(aFiles, [base.sha256]);
  for (let i = 0; i < 10; i++) a = state(aFiles, [a.sha256], String(i));
  const b = state(bFiles, [base.sha256]);
  const left = state([...aFiles, bFiles[1]], [a.sha256, b.sha256]);
  const right = state([...baseFiles, file('r', 'r')], [base.sha256]);
  const inputs = buildComposePages([
    {
      laneId: randomUUID(),
      head: right.sha256,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: right, recipe: null },
    },
  ]);
  const dependencies = buildComposePages([]);
  for (const page of [...inputs.pages, ...dependencies.pages]) json(page.value);
  const input = json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: left.sha256, receiptId: randomUUID() },
    main: { object: left, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'merge',
    at,
  });
  const io = {
    async describeBatch(ids) {
      describes.push(ids);
      assert(ids.length <= 100);
      return ids.map(id => ({ object: { sha256: id, size: objects.get(id).length }, recipe: null }));
    },
    async read(pin) {
      reads.push(pin.sha256);
      return (async function* () {
        yield objects.get(pin.sha256);
      })();
    },
    async upload(pin, stream) {
      const parts = [];
      for await (const part of stream) parts.push(part);
      assert.deepEqual(put(Buffer.concat(parts)), pin);
    },
  };
  let cursor = initialSourceStep(input),
    steps = 0;
  while (cursor.phase !== 'done') {
    assert(++steps < 30);
    cursor = (await runSourceStep(cursor, io)).cursor;
  }
  assert.equal(cursor.ancestryBoundary, base.sha256);
  assert(!reads.includes(oldA.sha256) && !reads.includes(oldB.sha256), 'no older manifest is transferred');
  const reference = new MemoryMergeSource(parents);
  for (const [id, bytes] of objects) reference.objects.set(id, bytes);
  assert.equal(cursor.head, reference.compose(left.sha256, right.sha256, 'merge', at).head);
  t.diagnostic(JSON.stringify({ steps, describeCalls: describes.length, olderReads: 0 }));
});
