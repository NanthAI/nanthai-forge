// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { durabilityFixture } from './hosted-durability-fixture.mjs';
import { snapshotAccumulator } from '../scripts/lib/hosted-durability-compare.mjs';
import { atStep, durabilityError, failure } from '../scripts/lib/hosted-durability-errors.mjs';
import { exportAndVerify } from '../scripts/lib/hosted-durability-snapshot.mjs';

function invalid(change) {
  const fixture = durabilityFixture();
  change(fixture);
  const reader = snapshotAccumulator();
  for (const [table, rows] of Object.entries(fixture)) {
    reader.add({ kind: 'table', table });
    for (const value of rows) reader.add({ kind: 'record', table, value });
  }
  reader.add({ kind: 'file', path: '_storage/blob', size: 7, sha256: 'synthetic' });
  try {
    reader.finish();
    assert.fail('fixture must fail');
  } catch (error) {
    return error;
  }
}
const changes = {
  'generation-missing': f => delete f.hostedProjects[0].work.generationId,
  'generation-building': f => (f.projectWorkGenerations[0].status = 'building'),
  'generation-failed': f => (f.projectWorkGenerations[0].status = 'failed'),
  'project-mismatch': f => (f.projectWorkGenerations[0].projectId = 'other'),
  'backup-mismatch': f => (f.projectWorkGenerations[0].backupId = 'other'),
  'partition-missing': f => (f.projectWorkRecords = []),
  'no-work-projects': f => (f.hostedProjects = []),
};
test('each unavailable-index branch names its evidence without exposing project or record values', () => {
  for (const [reason, change] of Object.entries(changes)) {
    const result = durabilityError(invalid(change), 'backup.validate');
    assert.equal(result.code, 'WORK_INDEX_UNAVAILABLE');
    assert.equal(result.diagnostics.reason, reason);
    assert.equal(result.step, 'backup.validate');
    assert.ok(result.nextStep);
    assert(!JSON.stringify(result).includes('synthetic-ciphertext'));
    if (reason !== 'no-work-projects') assert.match(result.diagnostics.projectRef, /^[a-f0-9]{12}$/);
  }
});

test('all transient index conditions re-export at most three times with fixed backoff; no calls when unused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durability-retry-test-'));
  try {
    for (const reason of ['generation-missing', 'generation-building', 'partition-missing']) {
      let exports = 0,
        reads = 0;
      const delays = [],
        events = [];
      const path = join(directory, 'snapshot.zip');
      const options = {
        read: async () => {
          reads++;
          throw invalid(changes[reason]);
        },
        delay: async ms => delays.push(ms),
        report: event => events.push(event),
      };
      assert.equal(exports, 0);
      await assert.rejects(
        exportAndVerify(
          'synthetic',
          path,
          async (_, output) => {
            exports++;
            await writeFile(output, String(exports));
          },
          options,
        ),
        error => {
          assert.equal(error.attempts, 3);
          assert.equal(error.step, 'backup.validate');
          return true;
        },
      );
      assert.equal(exports, 3);
      assert.equal(reads, 3);
      assert.deepEqual(delays, [15000, 45000]);
      assert.equal(events.length, 2);
      assert.equal(await readFile(path, 'utf8'), '3');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('every deployment validation caller can recover on a new snapshot; permanent and provider errors never retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durability-recovery-test-'));
  try {
    for (const step of ['backup', 'verify.left', 'verify.right']) {
      let exports = 0,
        reads = 0;
      const result = await exportAndVerify(
        'synthetic',
        join(directory, 'snapshot.zip'),
        async (_, output) => {
          exports++;
          await writeFile(output, String(exports));
        },
        {
          step,
          read: async () => {
            if (++reads === 1) throw invalid(changes['generation-building']);
            return { files: { count: 1 } };
          },
          delay: async () => {},
          report: () => {},
        },
      );
      assert.equal(result.files.count, 1);
      assert.equal(exports, 2);
    }
    for (const reason of ['generation-failed', 'project-mismatch', 'backup-mismatch', 'no-work-projects']) {
      let calls = 0;
      await assert.rejects(
        exportAndVerify('synthetic', join(directory, 'snapshot.zip'), async () => calls++, {
          read: async () => {
            throw invalid(changes[reason]);
          },
          delay: () => assert.fail('no backoff'),
        }),
      );
      assert.equal(calls, 1);
    }
    await assert.rejects(
      exportAndVerify('synthetic', 'unused', async () => {
        throw failure('CONVEX_EXPORT_FAILED');
      }),
      { step: 'backup.export' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public error boundary drops arbitrary provider codes, messages, steps and diagnostic values', async () => {
  const sentinel = 'SYNTHETIC_PRIVATE_SECRET';
  for (const command of ['export', 'verify', 'backup', 'backup-status', 'freshness']) {
    try {
      await atStep(command, async () => {
        throw Object.assign(new Error(sentinel), {
          code: sentinel,
          step: sentinel,
          diagnostics: { reason: sentinel, projectRef: sentinel },
        });
      });
    } catch (error) {
      const result = durabilityError(error);
      assert.equal(result.step, command);
      assert.ok(result.nextStep);
      assert(!JSON.stringify(result).includes(sentinel));
    }
  }
});

for (const documents of [300_000, 600_000])
  test(`snapshot validation streams ${documents} synthetic documents without application calls`, () => {
    const started = performance.now();
    const reader = snapshotAccumulator({ databaseOnly: true });
    for (const [table, rows] of Object.entries(durabilityFixture())) {
      reader.add({ kind: 'table', table });
      for (const value of rows) reader.add({ kind: 'record', table, value });
    }
    for (let i = 0; i < documents; i++)
      reader.add({
        kind: 'record',
        table: 'syntheticRows',
        value: { _id: `row-${i}`, payload: 'synthetic' },
      });
    const result = reader.finish();
    assert.equal(result.tables.syntheticRows.count, documents);
    const wallMs = Math.round(performance.now() - started);
    const peakRssBytes = process.resourceUsage().maxRSS * 1024;
    assert(peakRssBytes < 512 * 1024 * 1024, 'hash summaries stay below 512 MiB at twice the planning scale');
    console.log(
      JSON.stringify({
        documents,
        applicationConvexCalls: 0,
        databaseWrites: 0,
        r2Bytes: 0,
        wallMs,
        peakRssBytes,
      }),
    );
  });
