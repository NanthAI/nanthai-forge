// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMergeSource } from '../dist/hosted-source-memory.js';
import { savePin } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { streamingSync } from './source-stream-sync.mjs';
import { manifestFiles } from './source-stream-manifest.mjs';
const at = '2026-10-28T00:00:00.000Z';
const file = (path, blob = 'a', mode = 'file') => ({ path, blob: blob.repeat(64), mode });

function fixture(width = 65536) {
  const source = new MemoryMergeSource({});
  const base = source.writeState(
    [file('delete'), file('mode'), file('unchanged'), file('雪/"}.txt')],
    [],
    'base',
    at,
  );
  const left = source.writeState(
    [file('add'), file('mode', 'a', 'executable'), file('unchanged'), file('雪/"}.txt')],
    [base],
    'left',
    at,
  );
  const right = source.writeState(
    [file('delete'), file('mode'), file('unchanged', 'b'), file('雪/"}.txt', 'c')],
    [base],
    'right',
    at,
  );
  const pin = id => ({ sha256: id, size: source.object(id).length });
  const plan = {
    schema: 1,
    kind: 'forge-hosted-sync-input',
    algorithm: 'forge-native-sync-v1',
    work: {
      mode: 'sync',
      left: { object: pin(left), recipe: null },
      right: { object: pin(right), recipe: null },
    },
    message: 'sync',
    at,
  };
  const uploads = new Map();
  const io = {
    describeBatch: async ids => ids.map(id => ({ object: pin(id), recipe: null })),
    stateParents: id => source.state(id).parents,
    read: async ref =>
      (async function* () {
        const bytes = source.object(ref.sha256);
        for (let i = 0; i < bytes.length; i += width) yield bytes.subarray(i, i + width);
      })(),
    upload: async (ref, stream) => {
      const parts = [];
      for await (const part of stream) parts.push(part);
      const bytes = Buffer.concat(parts);
      assert.equal(digest(bytes), ref.sha256);
      assert.equal(bytes.length, ref.size);
      uploads.set(ref.sha256, bytes);
    },
  };
  return { source, plan, io, uploads, left, right, pin };
}

for (const width of [1, 7, 65536])
  test(`streaming metadata sync preserves native State bytes across ${width}-byte chunks, additions, deletions, modes and escaped Unicode paths`, async () => {
    const f = fixture(width),
      expected = f.source.compose(f.left, f.right, 'sync', at);
    assert(expected.head);
    const output = await streamingSync(savePin(f.plan), f.plan, f.io);
    const result = JSON.parse(f.uploads.get(output.sha256));
    assert.equal(result.result.state.sha256, expected.head);
    assert(f.uploads.get(expected.head).equals(f.source.object(expected.head)));
    assert.equal(f.uploads.size, 2);
  });

test('corrupt manifest hash publishes no State or result', async () => {
  const f = fixture(7),
    original = f.io.read;
  f.io.read = async pin =>
    (async function* () {
      for await (const part of await original(pin)) yield part;
      if (pin.sha256 === f.left) yield Buffer.from(' ');
    })();
  await assert.rejects(streamingSync(savePin(f.plan), f.plan, f.io), /exceeds pin/);
  assert.equal(f.uploads.size, 0);
});

test('manifest reader rejects unordered entries', async () => {
  const f = fixture(),
    state = JSON.parse(f.source.object(f.left));
  state.files.reverse();
  const bytes = Buffer.from(JSON.stringify(state)),
    id = digest(bytes);
  f.source.objects.set(id, bytes);
  await assert.rejects(async () => {
    for await (const file of manifestFiles(await f.io.read(f.pin(id)), f.pin(id), {})) void file;
  }, /ordered uniquely/);
  assert.equal(f.uploads.size, 0);
});

test('unsupported legacy manifest field order fails explicitly before publication', async () => {
  const f = fixture(),
    state = f.source.state(f.left);
  const bytes = Buffer.from(JSON.stringify({ files: state.files, ...state })),
    id = digest(bytes);
  f.source.objects.set(id, bytes);
  f.plan.work.left.object = f.pin(id);
  await assert.rejects(streamingSync(savePin(f.plan), f.plan, f.io));
  assert.equal(f.uploads.size, 0);
});

test('unsupported ancestry fails explicitly before publication', async () => {
  const f = fixture();
  f.io.stateParents = id => (id === f.right ? ['f'.repeat(64)] : [f.source.state(id).parents[0]]);
  await assert.rejects(streamingSync(savePin(f.plan), f.plan, f.io), /sibling-only/);
  assert.equal(f.uploads.size, 0);
});

test('opposing additions needing content merge fail explicitly before publication', async () => {
  const f = fixture(),
    old = f.source.state(f.right);
  const right = f.source.writeState([...old.files, file('add', 'd')], old.parents, 'right2', at);
  f.plan.work.right.object = f.pin(right);
  await assert.rejects(streamingSync(savePin(f.plan), f.plan, f.io), /metadata-only/);
  assert.equal(f.uploads.size, 0);
});
