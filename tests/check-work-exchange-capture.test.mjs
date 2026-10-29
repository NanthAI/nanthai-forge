// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkWorkReturnCapture } from '../scripts/check-work-return-capture.mjs';
import { checkWorkExchangeCapture } from '../scripts/check-work-exchange-capture.mjs';
import { buildExchangeRoot } from '../dist/native-exchange-tree.js';
import { workSchema } from '../dist/work-types.js';
import { digest } from '../dist/hash.js';

function fixture(t, dangling = false) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-offline-capture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const head = 'a'.repeat(64),
    intentId = randomUUID(),
    laneId = randomUUID(),
    viewId = randomUUID();
  const before = workSchema.parse({
    nativeHead: head,
    schema: 23,
    revision: 7,
    intents: [
      {
        id: intentId,
        base: head,
        outcome: 'Synthetic',
        constraints: '',
        status: 'active',
        notes: [],
        createdAt: 'now',
      },
    ],
    lanes: [
      {
        id: laneId,
        intentId,
        name: 'Synthetic',
        base: head,
        head,
        assignment: '',
        target: '',
        state: 'active',
        checkpoints: [],
      },
    ],
    views: [
      {
        id: viewId,
        intentId,
        base: head,
        head,
        inputs: [{ laneId, head }],
        status: 'clean',
        at: 'now',
        details: '',
      },
    ],
    landingBatches: [],
  });
  const after = structuredClone(before),
    entryId = randomUUID();
  after.revision++;
  after.intents[0].notes.push({ kind: 'comment', text: 'New content', at: 'later' });
  after.landingBatches.push({
    id: randomUUID(),
    channel: 'main',
    base: head,
    previous: head,
    arrivedAt: 'now',
    entryIds: [entryId],
    mode: 'parallel',
    status: 'completed',
    prefixes: [{ entryIds: [entryId], viewId: dangling ? randomUUID() : viewId, head, runId: randomUUID() }],
    conflicts: [],
  });
  const save = (name, data, baseline) => {
    const path = join(directory, name);
    mkdirSync(path);
    const work = Buffer.from(JSON.stringify(data, null, 2));
    const manifest = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-native-work-backup',
        id: randomUUID(),
        head,
        coverage: 'Synthetic coverage',
        revision: data.revision,
        files: [
          { path: 'work.json', size: work.length, sha256: digest(work) },
          { path: `objects/${head}`, size: 0, sha256: head },
        ],
      }),
    );
    writeFileSync(join(path, 'work.json'), work);
    writeFileSync(join(path, 'manifest.json'), manifest);
    if (baseline) {
      const tree = buildExchangeRoot(manifest, work, { records: true, baseline });
      writeFileSync(join(path, 'exchange.json'), tree.bytes);
      writeFileSync(join(path, 'exchange-index.json'), JSON.stringify(tree.index));
    }
    return path;
  };
  return { base: save('base', before), capture: save('capture', after, before) };
}
const snapshot = path => readdirSync(path).map(name => [name, digest(readFileSync(join(path, name)))]);

test('offline capture harness validates the retained delta without writing either input', async t => {
  const { base, capture } = fixture(t),
    original = [snapshot(base), snapshot(capture)];
  const result = await checkWorkExchangeCapture(base, capture);
  assert.equal(result.status, 'PASS');
  assert.equal(result.baseRevision, 7);
  assert.equal(result.revision, 8);
  assert.equal(result.changedRecords, 2);
  assert.equal(result.convexCalls, 0);
  assert.equal(result.documentsRead, 0);
  assert.equal(result.documentsWritten, 0);
  assert(result.contextPages <= 2);
  assert.deepEqual([snapshot(base), snapshot(capture)], original);
});

test('offline capture harness reports the exact missing required target and authenticates input bytes', async t => {
  const { base, capture } = fixture(t, true);
  await assert.rejects(
    checkWorkExchangeCapture(base, capture),
    error =>
      error.code === 'INVALID_WORK_BACKUP' &&
      /landingBatches\/.+dangling reference to views\//.test(error.message),
  );
  writeFileSync(
    join(base, 'work.json'),
    readFileSync(join(base, 'work.json'), 'utf8').replace('Synthetic', 'Tampered!'),
  );
  await assert.rejects(checkWorkExchangeCapture(base, capture), /Work digest differs/);
  const valid = fixture(t);
  writeFileSync(
    join(valid.capture, 'manifest.json'),
    readFileSync(join(valid.capture, 'manifest.json'), 'utf8').replace(
      'Synthetic coverage',
      'Tampering coverage',
    ),
  );
  await assert.rejects(
    checkWorkExchangeCapture(valid.base, valid.capture),
    error => error.code === 'ERR_ASSERTION',
  );
});

test('offline return harness runs the same record and source-return checks without modifying captures', async t => {
  const { base, capture } = fixture(t),
    original = [snapshot(base), snapshot(capture)];
  const result = await checkWorkReturnCapture(base, capture);
  assert.equal(result.status, 'PASS');
  assert.equal(result.recordsValidated, 2);
  assert.equal(result.events, 0);
  assert.equal(result.convexCalls, 0);
  assert.deepEqual([snapshot(base), snapshot(capture)], original);
});
