// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeState, parseNativeStateValue } from '../dist/state/format.js';
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
