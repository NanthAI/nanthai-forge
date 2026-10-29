// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { updateHostState } from '../dist/host-binding.js';
import { importBoundRecords } from '../dist/hosted-record-import.js';
import { recordsFixture } from './hosted-context-records-fixture.mjs';

for (const scale of [1, 2])
  test(`${300 * scale} native friction + ${20 * scale} decisions: paged dry-run, apply and replay preserve exact bytes`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-record-import-'));
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    writeFileSync(join(directory, 'synthetic.txt'), 'synthetic\n');
    initNative(directory);
    const store = new WorkStore(directory),
      s = recordsFixture(),
      at = '2026-10-24T00:00:00.000Z';
    updateHostState(store, state => {
      state.binding = {
        projectId: 'project',
        operationId: randomUUID(),
        deployment: 'https://fixture.invalid',
        projectUrl: 'https://fixture.invalid/project',
        name: 'Fixture',
        visibility: 'private',
        backupId: 'backup',
        autoSync: false,
        sourceAuthority: { mode: 'server', epoch: 1 },
      };
    });
    const expected = { friction: [], decisions: [] };
    store.locked(() => {
      const tx = store.records();
      for (let i = 0; i < 300 * scale; i++) {
        const id = randomUUID(),
          row = {
            kind: 'capture',
            id,
            operationId: id,
            request: `native-request-${i}`,
            at,
            count: 1,
            title: `Synthetic ${i}`,
            detail: 'x'.repeat(2048),
            area: 'import',
          };
        tx.append('frictionEvents', row);
        expected.friction.push(row);
      }
      for (let i = 0; i < 20 * scale; i++) {
        const id = randomUUID(),
          row = {
            schema: 1,
            kind: 'decision',
            id,
            operationId: id,
            request: 'a'.repeat(64),
            at,
            decidedAt: at,
            target: { kind: 'project' },
            decidedBy: 'Owner',
            what: `Synthetic decision ${i}`,
            why: 'Retain native bytes',
            actor: { kind: 'agent', name: 'fixture' },
            requester: { kind: 'agent', name: 'fixture' },
            ...(i ? { supersedes: expected.decisions[i - 1].id } : {}),
          };
        tx.append('decisions', row);
        expected.decisions.push(row);
      }
      store.commitRecords(tx);
    });
    const transport = Object.fromEntries(
      ['query', 'mutation'].map(kind => [
        kind,
        (name, args) => s.invoke(name, { projectId: 'project', ...args }),
      ]),
    );
    const revision = store.revision(),
      started = performance.now(),
      memoryBefore = process.memoryUsage().heapUsed;
    const previewBefore = s.counts(),
      preview = await importBoundRecords(store, false, transport);
    assert.equal(preview.calls, 3 * scale + 1);
    assert.equal(preview.records, 320 * scale);
    assert.equal(preview.added, 320 * scale);
    assert.equal(preview.maxBufferedRecords, 100);
    assert.equal(s.counts().writes, 0);
    const applyBefore = s.counts(),
      applied = await importBoundRecords(store, true, transport);
    const appliedCost = {
      calls: s.counts().calls - applyBefore.calls,
      reads: s.counts().reads - applyBefore.reads,
      writes: s.counts().writes - applyBefore.writes,
    };
    assert.ok(applied.maxBufferedBytes < 512 * 1024);
    assert.equal(applied.calls, 3 * scale + 1);
    assert.equal(applied.added, 320 * scale);
    assert.equal(appliedCost.writes, 320 * scale);
    assert.ok(appliedCost.reads <= 30);
    const repeated = await importBoundRecords(store, true, transport);
    assert.equal(repeated.existing, 320 * scale);
    assert.equal(repeated.added, 0);
    assert.equal(store.revision(), revision);
    assert.deepEqual(
      [...s.tables.projectHostedFriction.values()].map(r => JSON.parse(r.value)),
      expected.friction,
    );
    assert.deepEqual(
      [...s.tables.projectHostedDecisions.values()].map(r => JSON.parse(r.value)),
      expected.decisions,
    );
    t.diagnostic(
      JSON.stringify({
        importRecords: {
          records: 320 * scale,
          previewCalls: applyBefore.calls - previewBefore.calls,
          apply: appliedCost,
          maxBufferedRecords: applied.maxBufferedRecords,
          maxBufferedBytes: applied.maxBufferedBytes,
          heapDeltaBytes: process.memoryUsage().heapUsed - memoryBefore,
          durationMs: Math.round(performance.now() - started),
          rssBytes: process.memoryUsage().rss,
        },
      }),
    );
    const collision = { ...expected.decisions[0], why: 'Different record' };
    await assert.rejects(
      s.request('projectHostedFrictionImport:apply', { decisions: [collision] }),
      error => error.data?.code === 'WORK_OPERATION_CHANGED',
    );
    assert.equal(s.scheduled.length, 0);
  });

test('imported native operations replay with original native request hashes', async t => {
  const { captureFriction } = await import('../dist/friction.js');
  const { recordDecision } = await import('../dist/decisions.js');
  const directory = mkdtempSync(join(tmpdir(), 'forge-record-import-replay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(directory, 'synthetic.txt'), 'synthetic\n');
  initNative(directory);
  const store = new WorkStore(directory),
    s = recordsFixture();
  const friction = {
    operationId: randomUUID(),
    title: 'Native capture',
    detail: 'Original request',
    area: 'import',
  };
  const decision = {
    operationId: randomUUID(),
    target: { kind: 'project' },
    decidedBy: 'Owner',
    what: 'Native decision',
    why: 'Preserve the original hash',
  };
  const originalFriction = captureFriction(store, friction).result,
    originalDecision = recordDecision(store, decision, {
      agent: 'codex',
      sessionId: 'synthetic-session',
      turnId: 'synthetic-turn',
    }).result;
  updateHostState(store, state => {
    state.binding = {
      projectId: 'project',
      operationId: randomUUID(),
      deployment: 'https://fixture.invalid',
      projectUrl: 'https://fixture.invalid/project',
      name: 'Fixture',
      visibility: 'private',
      backupId: 'backup',
      autoSync: false,
      sourceAuthority: { mode: 'server', epoch: 1 },
    };
  });
  await importBoundRecords(store, true, {
    mutation: (name, args) => s.invoke(name, { projectId: 'project', ...args }),
  });
  assert.deepEqual(await s.request('projectHostedFriction:capture', friction), originalFriction);
  assert.deepEqual(
    await s.request('projectHostedDecisions:decide', decision),
    JSON.parse(JSON.stringify(originalDecision)),
  );
});
