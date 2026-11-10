// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeState, parseNativeStateValue, stateByteChunks } from '../dist/state/format.js';
import { digest } from '../dist/hash.js';
const state = {
  schema: 1,
  kind: 'forge-source-state',
  parents: [],
  files: [{ path: 'src/file.ts', blob: 'a'.repeat(64), mode: 'file' }],
  message: 'synthetic',
  at: '2026-01-01T00:00:00Z',
};
test('decoded marker and encoded source manifests retain identical validation', () => {
  assert.deepEqual(parseNativeStateValue(state), state);
  assert.deepEqual(parseNativeState(Buffer.from(JSON.stringify(state))), state);
  for (const value of [
    null,
    { ...state, extra: true },
    { ...state, parents: ['invalid'] },
    { ...state, files: [...state.files, ...state.files] },
    { ...state, files: [{ ...state.files[0], path: '.forge/private' }] },
    { ...state, files: [{ ...state.files[0], path: '../outside' }] },
    { ...state, files: [{ ...state.files[0], path: 'src' }, ...state.files] },
    { ...state, files: [{ ...state.files[0], mode: 'unknown' }] },
  ]) {
    for (const read of [
      () => parseNativeStateValue(value),
      () => parseNativeState(Buffer.from(JSON.stringify(value))),
    ])
      assert.throws(read, error => error.code === 'INVALID_NATIVE_SOURCE');
  }
});
test('malformed encoded manifests keep the typed encoding failure', () => {
  assert.throws(
    () => parseNativeState(Buffer.from('{')),
    error => error.code === 'INVALID_NATIVE_SOURCE' && /encoding/.test(error.message),
  );
});

test('cost 298f9675: State chunks preserve exact UTF-8 bytes and recover file boundaries after edits, insertion and deletion', () => {
  for (const prefix of ['src/f-', 'src/α😀-{]}-"f-']) {
    const files = Array.from({ length: 29000 }, (_, i) => ({
      path: `${prefix}${String(i).padStart(6, '0')}.ts`,
      blob: 'a'.repeat(64),
      mode: 'file',
    }));
    const before = Buffer.from(JSON.stringify({ ...state, files })),
      after = Buffer.from(
        JSON.stringify({
          ...state,
          parents: [digest(before)],
          files: [
            { ...files[0], blob: 'b'.repeat(64) },
            ...files.slice(1, 10),
            ...files.slice(11),
            { ...files[0], path: 'zz-new.ts' },
          ],
        }),
      );
    const old = stateByteChunks(before, digest),
      next = stateByteChunks(after, digest);
    assert(old && next);
    for (const [bytes, chunks] of [
      [before, old],
      [after, next],
    ]) {
      assert.deepEqual(
        Buffer.concat(chunks.map(pin => bytes.subarray(pin.offset, pin.offset + pin.size))),
        bytes,
      );
      assert(chunks.every(pin => pin.size <= 1024 * 1024));
      assert(chunks.every(pin => digest(bytes.subarray(pin.offset, pin.offset + pin.size)) === pin.sha256));
    }
    assert(
      next.some(pin => old.some(prior => prior.sha256 === pin.sha256 && prior.size > 256 * 1024)),
      'unchanged file-list spans survive offset and blob changes',
    );
  }
  assert.equal(
    stateByteChunks(Buffer.from(JSON.stringify(state)), digest),
    null,
    'small States keep the original flat representation',
  );
});

test('cost 298f9675: generated memory States retain native identity and semantic path validation', async () => {
  const { MemoryMergeSource } = await import('../dist/hosted-source-memory.js');
  const source = new MemoryMergeSource({}),
    id = source.writeState(state.files, [], state.message, state.at);
  const expected = Buffer.from(JSON.stringify(parseNativeStateValue(state)));
  assert.equal(id, digest(expected));
  assert.deepEqual(source.object(id), expected);
  assert.deepEqual(source.state(id).files, state.files);
  for (const files of [
    [...state.files, ...state.files],
    [
      { ...state.files[0], path: 'dir' },
      { ...state.files[0], path: 'dir/file' },
    ],
  ]) {
    assert.throws(() => source.writeState(files, [], 'invalid', state.at), { code: 'INVALID_NATIVE_SOURCE' });
  }
});
