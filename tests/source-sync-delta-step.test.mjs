// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSourceStep, runSourceStep } from '../dist/hosted-source-step.js';
import { saveBytes } from '../dist/hosted-save.js';
import { applySyncStateDelta } from '../dist/hosted-sync-delta.js';
import { parseNativeState } from '../dist/state/format.js';
import { digest } from '../dist/hash.js';

const at = '2026-01-01T00:00:00.000Z';

function memory() {
  const objects = new Map();
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const json = value => put(saveBytes(value));
  const file = (path, text) => ({ path, blob: put(text).sha256, mode: 'file' });
  const state = (files, parents = [], message = '') =>
    json({ schema: 1, kind: 'forge-source-state', files, parents, message, at });
  const io = {
    async describeBatch(ids) {
      return ids.map(id => ({ object: { sha256: id, size: objects.get(id).length }, recipe: null }));
    },
    async read(pin) {
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
  return { objects, put, json, file, state, io };
}

async function sync(m, left, right) {
  const input = m.json({
    schema: 1,
    kind: 'forge-hosted-sync-input',
    algorithm: 'forge-native-sync-v1',
    work: { mode: 'sync', left: { object: left, recipe: null }, right: { object: right, recipe: null } },
    message: 'sync',
    at,
  });
  let cursor = initialSourceStep(input),
    steps = 0;
  while (cursor.phase !== 'done') {
    assert(++steps < 30);
    cursor = (await runSourceStep(cursor, m.io)).cursor;
  }
  return cursor;
}

test('a merged sync step returns its State as a delta from the Lane head that rebuilds the exact head (fea47345 B)', async () => {
  const m = memory();
  const shared = m.file('shared', 'base\n'),
    gone = m.file('gone', 'old\n');
  const base = m.state([gone, shared]);
  const lane = m.state([gone, m.file('lane', 'lane\n'), shared], [base.sha256], 'lane');
  const main = m.state([m.file('main', 'main\n'), shared], [base.sha256], 'main');
  const cursor = await sync(m, lane, main);
  assert(cursor.head && cursor.head !== lane.sha256, 'the sync made a new State');
  const delta = cursor.syncDelta;
  assert(delta, 'the step carries a delta for the client');
  assert.equal(delta.from, lane.sha256);
  assert.equal(delta.head, cursor.head);
  assert.deepEqual(delta.removed, ['gone']);
  assert.deepEqual(
    delta.files.map(f => f.path),
    ['main'],
    'only what changed from the Lane head',
  );
  const from = parseNativeState(m.objects.get(lane.sha256));
  const rebuilt = applySyncStateDelta(from, lane.sha256, delta);
  assert(rebuilt, 'the delta rebuilds');
  assert.equal(rebuilt.id, cursor.head);
  assert.deepEqual(Buffer.from(rebuilt.bytes), m.objects.get(cursor.head), 'byte-exact State');
});

test('an up-to-date or fast-forward sync step carries no delta it does not need', async () => {
  const m = memory();
  const base = m.state([m.file('a', 'a\n')]);
  const lane = m.state([m.file('a', 'a\n'), m.file('b', 'b\n')], [base.sha256], 'lane');
  const cursor = await sync(m, lane, base);
  assert.equal(cursor.head, lane.sha256, 'Lane already contains main');
  assert.equal(cursor.syncDelta, undefined);
});

test('durable source progress never stores the reply-only sync delta', async () => {
  const { saveSourceProgress } = await import('../dist/hosted-source-step-progress.js');
  const stored = [];
  const cursor = { ...initialSourceStep({ sha256: 'a'.repeat(64), size: 1 }), syncDelta: { schema: 1 } };
  const { value } = await saveSourceProgress(cursor, null, async bytes => {
    stored.push(Buffer.from(bytes).toString());
    return String(stored.length);
  });
  assert.equal('syncDelta' in value.cursor, false);
  assert(!stored.some(text => text.includes('syncDelta')));
});
