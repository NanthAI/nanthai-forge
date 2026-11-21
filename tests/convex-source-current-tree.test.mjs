// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';

const ref = object => ({ object, recipe: null });
const stateBytes = (parents, files, message) =>
  Buffer.from(JSON.stringify({ schema: 1, kind: 'forge-source-state', parents, files, message, at }));

// Original implementation's call and document budgets, per main pin. The
// smaller States can publish chunked output and therefore touch extra rows.
const budgets = {
  29000: {
    compose: [
      [15, 184, 59],
      [17, 199, 62],
      [18, 207, 64],
    ],
    sync: [
      [8, 139, 49],
      [9, 147, 51],
      [10, 155, 53],
    ],
  },
  58000: {
    compose: [
      [15, 151, 48],
      [17, 166, 51],
      [18, 174, 53],
    ],
    sync: [
      [8, 106, 38],
      [9, 114, 40],
      [10, 122, 42],
    ],
  },
};

async function currentTree(s, count, move) {
  const original = await s.putSpec(Buffer.from('original\n')),
    laneContent = await s.putSpec(Buffer.from('lane edit\n')),
    mainContent = await s.putSpec(Buffer.from('main edit\n'));
  const files = Array.from({ length: count }, (_, i) => ({
    path: `src/deep/shared/components/features/generated/synthetic/module-${String(i).padStart(6, '0')}.ts`,
    blob: original.sha256,
    mode: 'file',
  }));
  const write = (parents, files, message, generation) =>
    s.putSpec(stateBytes(parents, files, message), undefined, generation, { parents });
  const base = await write([], files, 'base', 1),
    laneParent = await write([base.sha256], files, 'lane parent', 2),
    mainParent = await write([base.sha256], files, 'main parent', 2);
  const laneEdit = { ...files[0], blob: laneContent.sha256, mode: 'executable' };
  const laneFiles = files.with(0, laneEdit);
  const lane = await write([base.sha256, laneParent.sha256], laneFiles, 'lane', 3);
  const mainFiles = [...files];
  let main = mainParent;
  for (let i = 0; i <= move; i++) {
    const index = i + 1;
    mainFiles[index] = { ...files[index], blob: mainContent.sha256 };
    main = await write(i === 0 ? [base.sha256, main.sha256] : [main.sha256], mainFiles, `main-${i}`, 3 + i);
  }
  return { lane, main, files: mainFiles.with(0, laneEdit) };
}

async function plan(s, kind, lane, main, move) {
  if (kind === 'sync')
    return s.json({
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work: { mode: 'sync', left: ref(lane), right: ref(main) },
      message: 'merge',
      at,
    });
  const inputs = buildComposePages([
    {
      laneId: '10000000-0000-4000-8000-000000000001',
      head: lane.sha256,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: ref(lane),
    },
  ]);
  const dependencies = buildComposePages([]);
  for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
  return s.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: main.sha256, receiptId: `main-${move}` },
    main: ref(main),
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'merge',
    at,
  });
}

for (const count of [29000, 58000])
  for (const kind of ['compose', 'sync'])
    test(`${kind} with ${count} live files preserves exact merged State bytes as main moves`, async t => {
      for (let move = 0; move <= 2; move++) {
        // Rebuild the same immutable history in a fresh project. A first read of a
        // legacy State records dimensions, and the public sync envelope then
        // rejects 58,000-file States. This exercises the worker's legacy path.
        const s = await scaleFixture({ parallelism: 1, measureStateWork: true });
        try {
          const { lane, main, files } = await currentTree(s, count, move);
          const input = await plan(s, kind, lane, main, move);
          const id = await s.enqueue(input);
          const countsStart = s.counts.length;
          const report = await s.drain();
          const counts = s.counts.slice(countsStart);
          const job = await s.job(id);
          t.diagnostic(
            JSON.stringify({
              kind,
              count,
              move,
              input: input.sha256,
              manifestBytes: main.size,
              ...report,
              dbReadBytes: counts.reduce((sum, row) => sum + row.readBytes, 0),
              dbWriteBytes: counts.reduce((sum, row) => sum + row.writeBytes, 0),
            }),
          );
          assert.equal(job.status, 'completed', JSON.stringify(job.failure));
          const { result } = JSON.parse(await s.bytes(job.output));
          assert.equal(result.status, kind === 'compose' ? 'clean' : 'merged');
          const parents = kind === 'compose' ? [main.sha256, lane.sha256] : [lane.sha256, main.sha256];
          const expected = stateBytes(parents, files, 'merge');
          assert.deepEqual(result.state, { sha256: digest(expected), size: expected.length });
          assert.equal(digest(await s.bytes(result.state)), result.state.sha256);
          if (kind === 'compose') {
            const listing = JSON.parse(await s.bytes(result.candidateFiles));
            assert.deepEqual(result.paths, [files[0].path]);
            assert.deepEqual(
              listing.files.map(file => file.after),
              [files[0]],
            );
          }
          assert.equal(report.storageCalls, 0);
          const [maxCalls, maxReads, maxWrites] = budgets[count][kind][move];
          assert(report.functionCalls <= maxCalls, 'Convex function calls stay within the original budget');
          assert(report.documentsRead <= maxReads, 'Convex document reads stay within the original budget');
          assert(
            report.documentsWritten <= maxWrites,
            'Convex document writes stay within the original budget',
          );
          const calls = s.calls.length;
          await s.drain();
          assert.equal(s.calls.length, calls);
        } finally {
          s.restore();
        }
      }
    });
