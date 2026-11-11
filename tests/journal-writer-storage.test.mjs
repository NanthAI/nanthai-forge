// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { childEnv } from '../scripts/child-env.mjs';
import { journalStorageInventory, journalStorageGrowth } from './landing-journal-storage.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import assert from 'node:assert/strict';
import { landingStorage, storageBudgets } from './landing-storage-fixture.mjs';
import { journalMaintenanceFixture } from './journal-maintenance-fixture.mjs';
for (const dogfood of [false, true])
  test(`S2 ${dogfood ? 'dogfood' : 'fresh'} retained bytes include every journal index, receipt and terminal result`, async t => {
    storageClock(t);
    let writer, results;
    const samples = {};
    const measured = await landingStorage(t, dogfood, {
      capsules: true,
      storageSample: (phase, f) => {
        samples[phase] = journalStorageInventory(f);
      },
      journalSample: async f => {
        writer = await journalMaintenanceFixture(t, { f });
        results = await writer.drain();
      },
    });
    const path = join(temporaryDirectory(t, 'forge-journal-profile-'), 'transcript.json');
    writeFileSync(
      path,
      JSON.stringify({ input: writer.input, transcript: writer.transcript, objects: writer.objects.size }),
    );
    const output = execFileSync(
      process.execPath,
      [new URL('./journal-writer-profile-probe.mjs', import.meta.url).pathname, path],
      {
        encoding: 'utf8',
        env: childEnv({
          allow: ['FORGE_TEST_MODULE_DIRECTORY'],
          extra: { ...synthetic, FORGE_JOURNAL_SEGMENTS: '1' },
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const isolated = JSON.parse(output.trim().split('\n').at(-1));
    const name = dogfood ? 'dogfood' : 'fresh';
    const budget = storageBudgets[name];
    const journalBudget = storageBudgets.journal[name];
    const firstCalls = writer.calls.length;
    const total = Object.values(measured.perLanding.retained).reduce((n, bytes) => n + bytes, 0);
    const controls = [...writer.f.tables.projectJournalReceipts.values()].filter(row =>
      row.operationId.startsWith('journal-control:'),
    );
    const fixedBytes = controls.reduce(
      (n, row) => n + Buffer.byteLength(JSON.stringify({ ...row, _creationTime: 0 })),
      0,
    );
    await writer.drain({ projectId: writer.f.projectId, operationId: `work:${'a'.repeat(36)}` });
    await writer.drain({
      projectId: writer.f.projectId,
      operationId: `recovery:${'p'.repeat(32)}:${'a'.repeat(64)}`,
      phase: 1,
    });
    const steady = [...writer.f.tables.projectJournalReceipts.values()].filter(row =>
      /^journal-control:[0-4]:(existing|live)$/.test(row.operationId),
    );
    const steadyControls = {
      rows: steady.length,
      bytes: steady.reduce(
        (n, row) => n + Buffer.byteLength(JSON.stringify({ ...row, _creationTime: 0 })),
        0,
      ),
    };
    assert(results.every(result => result.metrics.mutations <= 2));
    t.diagnostic(
      JSON.stringify({
        shape: dogfood ? 'dogfood' : 'fresh',
        kinds: journalStorageGrowth(samples.before, samples.retained),
        isolated,
        maxPageIo: {
          documents: Math.max(...writer.io.map(row => row.documents)),
          reads: Math.max(...writer.io.map(row => row.reads)),
          readBytes: Math.max(...writer.io.map(row => row.readBytes)),
          writes: Math.max(...writer.io.map(row => row.writes)),
          writeBytes: Math.max(...writer.io.map(row => row.writeBytes)),
        },
        retainedBytes: total,
        perLanding: measured.perLanding.retained,
        controls: { rows: controls.length, bytes: fixedBytes },
        steadyControls,
        pages: results.length,
        calls: firstCalls,
        objects: writer.objects.size,
        puts: writer.requests.filter(method => method === 'PUT').length,
        gets: writer.requests.filter(method => method === 'GET').length,
        rawBytes: results.reduce((n, result) => n + result.metrics.rawBytes, 0),
        compressedBytes: results.reduce((n, result) => n + result.metrics.compressedBytes, 0),
        sampledFixtureRss: Math.max(...results.map(result => result.metrics.sampledRss)),
        wallMs: results.reduce((n, result) => n + result.metrics.wallMs, 0),
      }),
    );
    assert(controls.length <= journalBudget.bootstrapControls.rows);
    assert(fixedBytes <= journalBudget.bootstrapControls.bytes);
    assert(steadyControls.rows <= budget.perProject.retained.projectJournalControls.rows);
    assert(steadyControls.bytes <= budget.perProject.retained.projectJournalControls.bytes);
    for (const [table, bytes] of Object.entries(measured.perLanding.retained))
      assert(bytes <= budget.retained[table], `${table}: ${bytes} > ${budget.retained[table]}`);
  });
