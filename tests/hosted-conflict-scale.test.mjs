// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { finishSourceFingerprint } from '../dist/hosted-agent-finish-identity.js';
import { SourceFileReader } from '../dist/source-file-reader.js';
import { statEntry, writeCheckoutStatIndex } from '../dist/checkout-stat-index.js';
import { rememberConflictPaths } from '../dist/hosted-conflict-precheck.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hasConflictMarkers } from '../dist/conflict-markers.js';

for (const size of [3000, 29000])
  test(`local marker budget at ${size} files: only changed bytes; no network`, async t => {
    const base = mkdtempSync(join(tmpdir(), 'forge-conflict-scale-')),
      root = join(base, 'lane');
    t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    mkdirSync(join(root, '.forge'), { recursive: true });
    mkdirSync(root + '.forge-client');
    const bytes = Buffer.from('export const baseline = true;\n'),
      blob = digest(bytes),
      laneId = randomUUID();
    const files = [],
      entries = new Map();
    for (let i = 0; i < size; i++) {
      const path = `file-${i}.ts`;
      files.push({ path, blob, mode: 'file' });
      writeFileSync(join(root, path), bytes);
      entries.set(path, statEntry(lstatSync(join(root, path)), blob));
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const state = {
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files,
      message: 'Synthetic',
      at: '2026-01-01T00:00:00.000Z',
    };
    const head = digest(JSON.stringify(state));
    writeFileSync(
      join(root, '.forge/hosted-lane.json'),
      JSON.stringify({
        schema: 1,
        kind: 'forge-hosted-lane-checkout',
        url: 'https://fixture.invalid',
        operationId: randomUUID(),
        selection: {
          schema: 2,
          projectId: 'synthetic',
          laneId,
          intentId: randomUUID(),
          head,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: 'active',
          base: { head, receiptId: 'synthetic' },
          authority: { mode: 'server', epoch: 1 },
        },
        state,
        scope: null,
        materialized: files.map(f => f.path),
      }),
    );
    // Wait past the existing racy-stat margin; do not pretend recently written files are clean.
    await new Promise(resolve => setTimeout(resolve, 110));
    writeCheckoutStatIndex(root, Date.now(), entries);
    const changed = Buffer.from('export const updated = true;\n'.repeat(1024));
    for (let i = 0; i < 3; i++) writeFileSync(join(root, `file-${i}.ts`), changed);
    let scans = 0,
      scannedBytes = 0;
    const original = SourceFileReader.prototype.scan;
    SourceFileReader.prototype.scan = function (...args) {
      scans++;
      scannedBytes += this.size;
      return original.apply(this, args);
    };
    const started = performance.now();
    try {
      finishSourceFingerprint(root, { laneId });
    } finally {
      SourceFileReader.prototype.scan = original;
    }
    const elapsedMs = performance.now() - started;
    assert.equal(scans, 3);
    assert.equal(scannedBytes, changed.length * 3);
    const detectorTimes = [];
    for (let repeat = 0; repeat < 7; repeat++) {
      const start = performance.now();
      for (let i = 0; i < 3; i++) assert.equal(hasConflictMarkers(changed), false);
      detectorTimes.push(performance.now() - start);
    }
    rememberConflictPaths(root, laneId, ['file-0.ts']);
    writeFileSync(join(root, 'file-0.ts'), '<<<<<<< lane\nleft\n=======\nright\n>>>>>>> main\n');
    const refusal = performance.now();
    let calls = 0;
    const transport = new HostedAgentTransport(
      root,
      { url: 'https://fixture.invalid', projectId: 'synthetic' },
      {
        projectId: 'synthetic',
        client: {
          query() {
            calls++;
            throw Error('No network in a local refusal');
          },
        },
      },
    );
    await assert.rejects(transport.dispatch('finish', { laneId }), { code: 'CONFLICT_MARKERS' });
    assert.equal(calls, 0);
    t.diagnostic(
      JSON.stringify({
        laneFiles: size,
        scannedFiles: scans,
        scannedBytes,
        fingerprintMs: elapsedMs,
        markerCpuMedianMs: detectorTimes.sort((a, b) => a - b)[3],
        conflictRefusalMs: performance.now() - refusal,
        addedConvexCalls: 0,
        addedDbBytes: 0,
        scanBufferBytes: 65536,
        conflictSourceBytes: 45,
        localManifestBytes: lstatSync(join(root, '.forge/hosted-lane.json')).size,
      }),
    );
  });
