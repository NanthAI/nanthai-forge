// SPDX-License-Identifier: Apache-2.0
// Isolated synthetic object store: a separate process generates State bytes
// on disk, rather than preloading a GiB fixture into the measured process.
// Hardware flushes are faked; existing recovery tests exercise real durability.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getFunctionName } from 'convex/server';
import { ConvexExchange } from '../dist/exchange-client.js';
import { RecoveryObjects } from '../dist/recovery-hosted-objects.js';
import { hostedRecoveryObjects } from '../dist/recovery-hosted-read.js';
import { digest } from '../dist/hash.js';

// This is a call/RSS benchmark against a fake durable device. Small integration
// tests use the real fsync path; thousands of hardware flushes are not its metric.
fs.fsyncSync = () => {};
syncBuiltinESMExports();
const depth = 2500,
  files = 3000,
  uniqueBlobs = 29500;
const fixtureOnly = process.argv[2] === '--fixture';
const directory = fixtureOnly ? process.argv[3] : mkdtempSync(join(tmpdir(), 'forge-recovery-scale-'));
const started = performance.now();
try {
  const receipts = join(directory, 'receipts'),
    objects = join(directory, 'objects');
  mkdirSync(receipts, { recursive: true });
  mkdirSync(objects, { recursive: true });
  const remoteStates = join(directory, 'remote');
  mkdirSync(remoteStates, { recursive: true });
  const blobs = Array.from({ length: uniqueBlobs }, (_, i) => Buffer.from(`synthetic source ${i}\n`)),
    blobPins = blobs.map(bytes => ({ sha256: digest(bytes), size: bytes.length })),
    blobIndex = new Map(blobPins.map((pin, i) => [pin.sha256, i])),
    states = [],
    stateIndex = new Map();
  const stateBytes = i =>
    Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: i ? [states[i - 1].sha256] : [],
        files: Array.from({ length: files }, (_, j) => ({
          path: `source/${String(j).padStart(4, '0')}.ts`,
          blob: blobPins[(i * 13 + j) % uniqueBlobs].sha256,
          mode: 'file',
        })),
        message: `State ${i}`,
        at: '2026-10-27T00:00:00.000Z',
      }),
    );
  // Generate input in a separate process so fixture construction is excluded
  // from recovery RSS, just as remote storage is outside the recovering process.
  if (fixtureOnly) {
    for (let i = 0; i < depth; i++) {
      const bytes = stateBytes(i),
        pin = { sha256: digest(bytes), size: bytes.length };
      writeFileSync(join(remoteStates, pin.sha256), bytes);
      states.push(pin);
    }
    writeFileSync(join(directory, 'states.json'), JSON.stringify(states));
    process.exit(0);
  }
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--fixture', directory]);
  states.push(...JSON.parse(readFileSync(join(directory, 'states.json'), 'utf8')));
  states.forEach((pin, index) => stateIndex.set(pin.sha256, index));
  const remote = id => {
    if (stateIndex.has(id)) return readFileSync(join(remoteStates, id));
    assert(blobIndex.has(id));
    return blobs[blobIndex.get(id)];
  };
  const source = {
    directory: objects,
    put(bytes) {
      const id = digest(bytes);
      if (stateIndex.has(id)) writeFileSync(join(objects, id), 'retained', { mode: 0o600 });
      else writeFileSync(join(objects, id), bytes, { mode: 0o600 });
      return id;
    },
    object(id) {
      return stateIndex.has(id) || blobIndex.has(id) ? remote(id) : readFileSync(join(objects, id));
    },
  };
  const sizes = new Map([...states, ...blobPins].map(pin => [pin.sha256, pin.size]));
  let lookupCalls = 0,
    signCalls = 0,
    documentReads = 0,
    downloads = 0,
    largestBatch = 0;
  const exchange = new ConvexExchange(
    'https://synthetic.convex.cloud',
    'synthetic-token',
    'project',
    'operation',
    null,
  );
  exchange.client.query = async (ref, { digests }) => {
    assert.equal(getFunctionName(ref), 'projectMain:objects');
    assert(digests.length <= 100);
    lookupCalls++;
    documentReads += 1 + digests.length;
    return digests.map(sha256 => ({ sha256, size: sizes.get(sha256) }));
  };
  exchange.client.mutation = async (ref, { digests }) => {
    assert.equal(getFunctionName(ref), 'projectObjectDownloads:signDownloads');
    assert(digests.length <= 100);
    await yieldIO();
    signCalls++;
    documentReads += 1 + digests.length;
    largestBatch = Math.max(largestBatch, digests.length);
    return digests.map(id => ({
      digest: id,
      size: sizes.get(id),
      url: `https://synthetic.invalid/${id}`,
    }));
  };
  globalThis.fetch = async url => {
    await yieldIO();
    assert.equal(new URL(url).hostname, 'synthetic.invalid');
    downloads++;
    return new Response(remote(new URL(url).pathname.slice(1)));
  };
  console.error(JSON.stringify({ stage: 'fixture', rss: process.memoryUsage().rss }));
  const coldStarted = performance.now();
  const root = await new RecoveryObjects(source, receipts, exchange).states([...states].reverse());
  const coldElapsedMs = Math.round(performance.now() - coldStarted);
  const coldPeakRssBytes = process.resourceUsage().maxRSS * 1024;
  console.error(JSON.stringify({ stage: 'cold', ...process.memoryUsage(), peak: coldPeakRssBytes }));
  const expected = new Set([...states, ...blobPins].map(pin => pin.sha256));
  let verified = 0;
  for (const id of hostedRecoveryObjects(source, { hostedRecovery: { objects: root, pages: null } })) {
    expected.delete(id);
    // Model a paged portable consumer, rather than allocating through a GiB
    // synchronous verification scan without giving Node an IO/GC turn. Every
    // inventory node and source pin is still visited under the same RSS budget.
    if (++verified % 100 === 0) await yieldIO();
  }
  assert.equal(expected.size, 0, 'every State and file is retained in the portable closure');
  assert.equal(lookupCalls, Math.ceil(uniqueBlobs / 100));
  assert(lookupCalls <= 400);
  assert.equal(downloads, depth + uniqueBlobs);
  assert(largestBatch > 1);
  assert.equal(
    JSON.parse(readFileSync(join(receipts, `state-${states.at(-1).sha256}.json`))).pin.sha256,
    states.at(-1).sha256,
  );
  console.error(JSON.stringify({ stage: 'validated', ...process.memoryUsage() }));
  const callsBeforeReplay = lookupCalls + signCalls;
  assert.deepEqual(await new RecoveryObjects(source, receipts, exchange).states([...states].reverse()), root);
  assert.equal(lookupCalls + signCalls, callsBeforeReplay, 'completed closure performs no network reads');
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  console.error(JSON.stringify({ stage: 'finished', rss: process.memoryUsage().rss, peakRssBytes }));
  assert(peakRssBytes < 300 * 1024 * 1024, `RSS ${peakRssBytes} exceeds the 300 MiB budget`);
  console.log(
    JSON.stringify({
      depth,
      files,
      heapLimitMiB: process.execArgv.includes('--max-old-space-size=128') ? 128 : null,
      semiSpaceMiB: process.execArgv.includes('--max-semi-space-size=4') ? 4 : null,
      uniqueObjects: depth + uniqueBlobs,
      legacyFileLookupCallsEstimated: depth * files,
      lookupCalls,
      signCalls,
      totalSourceControlCalls: lookupCalls + signCalls,
      documentReads,
      documentWrites: 0,
      downloads,
      largestBatch,
      peakRssBytes,
      coldElapsedMs,
      coldPeakRssBytes,
      elapsedMs: Math.round(performance.now() - started),
      storage:
        'synthetic disk State store, hardware flushes faked; real exchange batching; fake owner-path document accounting',
    }),
  );
} finally {
  if (!fixtureOnly) rmSync(directory, { recursive: true, force: true });
}
