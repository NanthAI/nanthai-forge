// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { NativeSource } from '../dist/native-source.js';
import { originalValidation, countValidation } from '../scripts/measure-snapshot-validation.mjs';
// Qualification can bind an independently built worker candidate before composition.
// Normal repository verification always uses its own compiled runtime.
const runtime = resolve(process.env.FORGE_QUALIFY_RUNTIME ?? fileURLToPath(new URL('..', import.meta.url)));
const { NativeClosureValidation } = await import(
  pathToFileURL(join(runtime, 'dist/native-closure-validation.js'))
);
function scoped(source, roots) {
  const closure = new NativeClosureValidation(source),
    conflicts = [];
  for (const head of roots)
    try {
      closure.validate(head);
    } catch (error) {
      if (error?.name !== 'ForgeError') throw error;
      conflicts.push({ collection: 'source', field: 'retainedState', hosted: head });
    }
  return conflicts;
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-validation-qualification-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new NativeSource(root),
    blob = source.put(Buffer.from('shared source bytes\n')),
    other = source.put(Buffer.from('independent source bytes\n'));
  const files = [{ path: 'a.ts', blob, mode: 'file' }],
    states = [];
  for (let index = 0; index < 12; index++)
    states.push(
      source.writeState(files, index ? [states.at(-1)] : [], `State ${index}`, '2026-01-01T00:00:00.000Z'),
    );
  const independent = source.writeState(
    [{ path: 'b.ts', blob: other, mode: 'file' }],
    [],
    'Independent',
    '2026-01-01T00:00:00.000Z',
  );
  return { source, blob, states, independent, roots: [states[11], states[8], independent, states[4]] };
}

test('same retained roots preserve validation results while reading each successful shared object once per scope', t => {
  const f = fixture(t),
    before = countValidation(f.source, source => originalValidation(source, f.roots));
  const after = countValidation(f.source, source => scoped(source, f.roots));
  assert.deepEqual(after.conflicts, before.conflicts);
  assert.deepEqual(after.conflicts, []);
  assert.equal(after.distinctStates, 13);
  assert.equal(after.distinctObjects, 15);
  assert.equal(after.objectCalls, 15);
  assert.equal(after.stateCalls, 13);
  assert(before.objectCalls > after.objectCalls * 3);
  assert.equal(after.distinctObjectBytes, before.distinctObjectBytes);
  assert(after.objectBytes < before.objectBytes);
});

test('missing states and corrupt shared blobs retain original per-root conflict order and independent successes', t => {
  const f = fixture(t),
    blobPath = join(f.source.directory, f.blob),
    bytes = readFileSync(blobPath);
  writeFileSync(blobPath, Buffer.from('corrupt bytes'));
  assert.deepEqual(scoped(f.source, f.roots), originalValidation(f.source, f.roots));
  assert.deepEqual(
    scoped(f.source, f.roots).map(row => row.hosted),
    [f.states[11], f.states[8], f.states[4]],
  );
  writeFileSync(blobPath, bytes);
  const statePath = join(f.source.directory, f.states[8]),
    stateBytes = readFileSync(statePath);
  unlinkSync(statePath);
  assert.deepEqual(scoped(f.source, f.roots), originalValidation(f.source, f.roots));
  assert.deepEqual(
    scoped(f.source, f.roots).map(row => row.hosted),
    [f.states[11], f.states[8]],
  );
  writeFileSync(statePath, stateBytes);
  assert.deepEqual(scoped(f.source, f.roots), []);
});

test('a fresh validation boundary detects corruption after a previous successful scope and propagates unrelated errors', t => {
  const f = fixture(t);
  assert.deepEqual(scoped(f.source, f.roots), []);
  writeFileSync(join(f.source.directory, f.blob), Buffer.from('changed between boundaries'));
  assert.deepEqual(scoped(f.source, f.roots), originalValidation(f.source, f.roots));
  const error = new Error('unexpected device failure'),
    source = {
      state() {
        throw error;
      },
      object() {
        throw error;
      },
      ancestors() {
        throw error;
      },
    };
  assert.throws(
    () => scoped(source, ['root']),
    value => value === error,
  );
  assert.throws(
    () => originalValidation(source, ['root']),
    value => value === error,
  );
});
