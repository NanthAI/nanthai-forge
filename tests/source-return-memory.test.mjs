// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jsonChunks } from '../dist/json-chunks.js';
import { workBytes, workDigest } from '../dist/work-metadata.js';
import { digest } from '../dist/hash.js';
import { firstIndexBatch } from '../dist/work-hosted-index.js';
import { buildByteTree, byteTreeChunks, readByteTree } from '../dist/native-exchange-tree.js';

export function syntheticHistory() {
  return {
    revision: 12000,
    checkpoints: Array.from({ length: 12000 }, (_, i) => ({
      head: digest(`state-${i}`),
      parent: digest(`state-${i - 1}`),
      at: '2026-01-01T00:00:00.000Z',
      message: `Synthetic save ${i}: ${'history '.repeat(80)}`,
    })),
    files: Array.from({ length: 1425 }, (_, i) => ({
      path: `file-${i}.ts`,
      sha256: digest(`file-${i}`),
      size: i < 3 ? 32 * 1024 * 1024 : 1000,
    })),
    extension: { text: 'é😀\n'.repeat(10000), absent: undefined, array: [undefined, null, 'quote"'] },
  };
}

test('12k-revision metadata hashes in bounded JSON chunks with exact historical bytes', () => {
  const data = syntheticHistory();
  let largest = 0,
    count = 0;
  for (const chunk of jsonChunks(data, 2)) {
    largest = Math.max(largest, Buffer.byteLength(chunk));
    count++;
  }
  assert(count > 100);
  assert(largest <= 65536);
  assert.equal([...jsonChunks(data, 2)].join(''), workBytes(data));
  assert.equal(workDigest(data), digest(workBytes(data)));
  for (const space of [0, 2])
    assert.equal([...jsonChunks(data, space)].join(''), JSON.stringify(data, null, space));
});

test('12k-revision metadata traverses a bounded tree frontier without retaining decoded history', async t => {
  const data = syntheticHistory(),
    bytes = Buffer.from(workBytes(data)),
    objects = new Map();
  const recipe = buildByteTree(bytes, objects);
  let readBytes = 0,
    batches = 0,
    chunks = 0,
    total = 0,
    sampledPeakHeap = 0;
  const read = async pins => {
    batches++;
    sampledPeakHeap = Math.max(sampledPeakHeap, process.memoryUsage().heapUsed);
    readBytes = Math.max(
      readBytes,
      pins.reduce((n, p) => n + p.size, 0),
    );
    assert(pins.length <= 8);
    return pins.map(pin => Buffer.from(objects.get(pin.sha256)));
  };
  // The consumer holds only a digest and counters, independent of history size.
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  for await (const chunk of byteTreeChunks(recipe, read)) {
    chunks++;
    total += chunk.length;
    hash.update(chunk);
  }
  assert(chunks > 100);
  assert(readBytes <= 2 * 1024 * 1024);
  assert(sampledPeakHeap < 256 * 1024 * 1024, `sampled heap ${sampledPeakHeap}`);
  assert.equal(total, bytes.length);
  assert.equal(hash.digest('hex'), digest(bytes));
  assert.deepEqual(await readByteTree(recipe, read), bytes);
  t.diagnostic(
    JSON.stringify({
      revisions: 12000,
      files: 1425,
      metadataBytes: bytes.length,
      batches,
      readBytes,
      chunks,
      sampledPeakHeap,
    }),
  );
});

test('a durable row step examines only the next batch, independently of retained revision count', () => {
  let examined = 0;
  const rows = Array.from({ length: 12000 }, (_, i) => ({
    collection: 'checkpoints',
    key: randomUUID(),
    parent: 'lane',
    position: i,
    get value() {
      examined++;
      return '{}';
    },
  }));
  const next = firstIndexBatch(rows, { rows: 100, bytes: 500000 });
  assert.equal(next.length, 100);
  assert.equal(examined, 100, 'later historical rows are not serialized by this step');
});

test('streaming JSON preserves supplementary characters at chunk boundaries', () => {
  for (let prefix = 32740; prefix < 32780; prefix++) {
    const value = { text: 'x'.repeat(prefix) + '😀'.repeat(10) };
    const bytes = Buffer.concat([...jsonChunks(value)].map(chunk => Buffer.from(chunk)));
    assert.equal(bytes.toString(), JSON.stringify(value));
  }
});

test('complete compatibility preparation measures fixture build and action RSS separately under a 384 MiB V8 heap', async t => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'forge-return-memory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = mode => {
    const child = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=384',
        new URL('./source-return-memory-fixture.mjs', import.meta.url).pathname,
        mode,
        directory,
      ],
      {
        env: {
          ...process.env,
          FORGE_TEST_MODULE_DIRECTORY: join(directory, 'modules'),
          FORGE_TEST_PRECOMPILED: mode === 'step' ? '1' : '0',
        },
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout.trim().split('\n').at(-1));
  };
  const build = run('build'),
    evidence = run('step');
  assert.equal(evidence.receiptRevision, 12002);
  assert.equal(evidence.revisions, 12000);
  assert.equal(evidence.files, 1425);
  assert.equal(evidence.largeFiles, 3);
  assert(evidence.sampledPeakHeap < 384 * 1024 * 1024);
  assert(evidence.maxRssKiB < 512 * 1024, `action RSS ${evidence.maxRssKiB} KiB`);
  t.diagnostic(JSON.stringify({ build, action: evidence }));
});

test('a selected View step builds one read model without mapping retained save histories', async () => {
  const { viewIndexEntries } = await import('../dist/view-hosted-index.js');
  const head = digest('selected-head'),
    checkpoints = Array.from({ length: 12000 }, () => ({ head, at: 'now' }));
  checkpoints.map = () => {
    assert.fail('selected save lookup must not allocate an all-history array');
  };
  let selected = 11999;
  const data = {
    intents: [{ id: 'intent', outcome: 'Synthetic' }],
    lanes: [{ id: 'lane', checkpoints }],
    channelMoves: [],
    views: Array.from({ length: 12000 }, (_, index) => ({
      id: `view-${index}`,
      intentId: 'intent',
      head,
      base: head,
      status: 'clean',
      inputs: [{ laneId: 'lane', head }],
      get at() {
        assert.equal(index, selected, 'another View read model was materialized');
        return 'now';
      },
    })),
  };
  for (selected of [11999, 0]) {
    const entries = viewIndexEntries(data, undefined, { index: selected, positions: new Map() });
    const details = JSON.parse(entries.find(row => row.collection === 'viewDetails').value);
    assert.equal(details.viewId, `view-${selected}`);
    assert.equal(details.inputs[0].saveIndex, 11999);
    assert.equal(details.supersededBy, selected === 11999 ? null : 'view-11999');
    assert.equal(entries.filter(row => row.collection === 'viewDetails').length, 1);
  }
});
