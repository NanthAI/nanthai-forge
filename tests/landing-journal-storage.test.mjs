// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { landingStorage } from './landing-storage-fixture.mjs';
import { journalStorageInventory, journalStorageGrowth } from './landing-journal-storage.mjs';

for (const dogfood of [false, true])
  test(`S2 ${dogfood ? 'dogfood' : 'fresh'} storage accounts for current versions separately from superseded history`, async t => {
    storageClock(t);
    const samples = {};
    let finishProjections;
    const started = performance.now();
    const measured = await landingStorage(t, dogfood, {
      capsules: true,
      storageSample: (phase, f) => {
        samples[phase] = journalStorageInventory(f);
        if (phase === 'retained') {
          finishProjections = {};
          for (const row of f.tables.projectFinishReadRows.values()) {
            finishProjections[row.kind] ??= { rows: 0, bytes: 0 };
            finishProjections[row.kind].rows++;
            finishProjections[row.kind].bytes += Buffer.byteLength(
              JSON.stringify({ ...row, _creationTime: 0 }),
            );
          }
        }
      },
    });
    const growth = journalStorageGrowth(samples.before, samples.retained);
    for (const [table, classes] of Object.entries(growth)) {
      const total = Object.values(classes).reduce((n, row) => n + row.bytes, 0);
      assert.equal(Math.max(0, total), measured.perLanding.retained[table], `${table}: whole-row accounting`);
    }
    const initial = new Set(samples.before.currentCandidates.map(row => row.id));
    const newCurrentCandidates = samples.retained.currentCandidates.filter(row => !initial.has(row.id));
    assert.equal(
      newCurrentCandidates.length,
      dogfood ? 1 : 0,
      'recomposition adds an immutable current Candidate',
    );
    const currentCandidateFloorBytes = newCurrentCandidates.reduce((n, row) => n + row.bodyBytes, 0);
    assert(
      currentCandidateFloorBytes <= measured.perLanding.retained.projectHostedRecordBodies,
      'the current Candidate body belongs to this landing, not the seeded baseline',
    );
    const monthly = Object.fromEntries(
      Object.entries(growth).map(([table, kinds]) => [
        table,
        Object.fromEntries(
          Object.entries(kinds).map(([kind, row]) => [kind, { rows: row.rows * 30, bytes: row.bytes * 30 }]),
        ),
      ]),
    );
    const movableUpperBoundBytes = Object.entries(growth).reduce(
      (total, [table, classes]) =>
        total +
        Object.entries(classes)
          .filter(
            ([kind]) =>
              kind.startsWith('superseded:') ||
              (table === 'projectHostedOperations' && kind === 'terminal') ||
              (table === 'projectHostedSavePages' && kind === 'closed') ||
              (table === 'projectHostedDisplayRecords' && kind === 'derived') ||
              (table === 'projectCoordinationEvents' && kind.startsWith('archive:')),
          )
          .reduce((n, [, row]) => n + row.bytes, 0),
      0,
    );
    const totalRetainedBytes = Object.values(measured.perLanding.retained).reduce((n, b) => n + b, 0);
    t.diagnostic(
      JSON.stringify({
        shape: dogfood ? 'dogfood' : 'fresh',
        growth,
        // Explicit scenario normalization, not a measured month or a full planning workload.
        thirtyIssuesOneLandingEach: monthly,
        currentCandidateFloorBytes,
        movableUpperBoundBytes,
        // Gives terminal receipts and the future segment index zero bytes: deliberately optimistic.
        optimisticRetainedBytes: totalRetainedBytes - movableUpperBoundBytes,
        newCurrentCandidates: newCurrentCandidates.map(({ bodyBytes, governanceBytes, paths }) => ({
          bodyBytes,
          governanceBytes,
          paths,
        })),
        totalRetainedBytes,
        finishProjections,
        remainingOutsideJournalBytes: Object.entries(measured.perLanding.retained)
          .filter(([table]) => !Object.hasOwn(growth, table))
          .reduce((n, [, b]) => n + b, 0),
        wallMs: performance.now() - started,
        peakProcessRssBytes: process.resourceUsage().maxRSS * 1024,
        scope: 'in-process fixture including DB fake and imports; not provider memory or billed usage',
      }),
    );
  });
