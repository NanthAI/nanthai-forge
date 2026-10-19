// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';

const archivedSource = [
  'convex/secrets.ts',
  'src/secret-crypto.ts',
  'tests/secrets.test.mjs',
  'web/src/Secrets.tsx',
];
const content = 'export const synthetic = 1;\n';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-capture-omission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, path, bytes = content) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

test('native init captures secret-named source and reports excluded config on replay', t => {
  const root = fixture(t);
  for (const path of archivedSource) put(root, path);
  put(root, '.env.example', 'SYNTHETIC=example\n');
  put(root, '.env', 'SYNTHETIC=local\n');
  put(root, 'credentials.json', '{"synthetic":true}');
  put(root, '.gitignore', 'src/secret-ignored.ts\n');
  put(root, 'src/secret-ignored.ts');
  const initial = initNative(root),
    source = new NativeSource(root);
  assert.deepEqual(
    source.state(initial.head).files.map(f => f.path),
    ['.gitignore', ...archivedSource],
  );
  assert.equal(initial.captureCoverage.included, 5);
  assert.deepEqual(initial.captureCoverage.excluded, [
    { path: '.env', reason: 'sensitive-name' },
    { path: '.env.example', reason: 'sensitive-name' },
    { path: 'credentials.json', reason: 'sensitive-name' },
    { path: 'src/secret-ignored.ts', reason: 'gitignored' },
  ]);
  assert.deepEqual(initNative(root), initial);
});

test('interrupted init preserves exact original capture coverage', t => {
  const root = fixture(t);
  put(root, 'src/secret-crypto.ts');
  put(root, '.env.example', 'SYNTHETIC=example\n');
  const save = WorkStore.prototype.save;
  WorkStore.prototype.save = () => {
    throw Error('synthetic interrupted save');
  };
  try {
    assert.throws(() => initNative(root), /synthetic interrupted save/);
  } finally {
    WorkStore.prototype.save = save;
  }
  const receipt = JSON.parse(readFileSync(join(root, '.forge/work/init.json'), 'utf8'));
  put(root, 'src/new.ts');
  const recovered = initNative(root);
  assert.equal(recovered.head, receipt.head);
  assert.deepEqual(recovered.captureCoverage, receipt.captureCoverage);
  assert.equal(recovered.captureCoverage.included, 1);
});

test('new secret-named Lane modules survive checkpoint, acceptance and materialization', t => {
  const root = fixture(t);
  initNative(root);
  const work = new WorkService(root),
    source = new NativeSource(root),
    act = command => work.execute(command, work.store.load().revision).result,
    intent = act({ action: 'intent', outcome: 'Synthetic source capture' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Capture source' }),
    path = work.store.path(lane.id),
    names = [...archivedSource, 'src/credentials.py', 'src/secrets.rs', 'src/secret.java'];
  for (const name of names) put(path, name);
  put(path, '.env', 'SYNTHETIC=local\n');
  const report = source.captureReport(path, false, lane.head),
    saved = act({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: lane.head,
      expectedTree: source.tree(report.files),
      message: 'Retain modules',
    });
  assert.deepEqual(
    source.state(saved.head).files.map(f => f.path),
    [...names].sort(),
  );
  assert(saved.checkpoints.at(-1).captureCoverage.excluded.some(f => f.path === '.env'));
  const view = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: saved.head }],
  });
  act({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  });
  const accepted = work.store.load().channelMoves.at(-1);
  assert.equal(accepted.status, 'accepted');
  source.materialize(accepted.head, join(root, 'materialized'), false);
  for (const name of names) assert.equal(readFileSync(join(root, 'materialized', name), 'utf8'), content);
});
