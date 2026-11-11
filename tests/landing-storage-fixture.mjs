// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { capsuleMaintenanceFixture } from './landing-capsule-maintenance-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
export function inflateDogfoodChecks(f) {
  const reports = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      `tests/hosted-${String(i).padStart(4, '0')}-${'synthetic-path-'.repeat(10)}.test.mjs`,
      { durationMs: 1234.567, failed: false, attempts: [{ durationMs: 1234.567, failed: false }] },
    ]),
  );
  let runBytes = 0;
  for (const row of f.tables.projectHostedCheckRuns.values()) {
    const run = JSON.parse(row.value);
    if (run.status !== 'passed') continue;
    run.contractReports = reports;
    run.plan.shardCount = 10;
    run.counts = { completed: 10, passed: 10, failed: 0 };
    const value = JSON.stringify(run);
    runBytes = Buffer.byteLength(value);
    f.patch('projectHostedCheckRuns', row._id, { value });
  }
  return runBytes;
}

// Net retained JSON document bytes, rather than cumulative write traffic. Identities retain their
// lengths; normalize only the synthetic creation clock. Index/system/R2 bytes are separate costs.
function storedBytes(f) {
  return Object.fromEntries(
    Object.entries(f.tables)
      .filter(([name]) => !name.startsWith('_'))
      .map(([name, rows]) => [
        name,
        [...rows.values()].reduce(
          (n, row) =>
            n +
            (name === 'projectFinishReadRows' && row.kind === 'projectLandingCapsuleIndex'
              ? 0
              : Buffer.byteLength(JSON.stringify({ ...row, _creationTime: 0 }))),
          0,
        ),
      ]),
  );
}
// These writers replace one current row per project; their whole rows (not deltas) and
// cardinality are ratcheted separately. Shared/mixed tables stay in the per-landing ledger.
const fixedProjectTables = new Set([
  'projectHostedChannels',
  'projectHostedLandingQueues',
  'projectHostedOverlapMain',
]);
export const storageBudgets = JSON.parse(
  readFileSync(new URL('./fixtures/landing-storage-budget.json', import.meta.url), 'utf8'),
);
export function fixedProjectStorage(f) {
  const bytes = storedBytes(f);
  return Object.fromEntries([
    ...[...fixedProjectTables].map(table => [table, { rows: f.tables[table].size, bytes: bytes[table] }]),
    [
      'projectLandingCapsuleIndex',
      {
        rows: [...f.tables.projectFinishReadRows.values()].filter(
          row => row.kind === 'projectLandingCapsuleIndex',
        ).length,
        bytes: [...f.tables.projectFinishReadRows.values()]
          .filter(row => row.kind === 'projectLandingCapsuleIndex')
          .reduce((n, row) => n + Buffer.byteLength(JSON.stringify({ ...row, _creationTime: 0 })), 0),
      },
    ],
  ]);
}
export function assertFixedProjectStorage(actual, budget, label) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(budget).sort(), `${label}: fixed tables`);
  for (const [table, stored] of Object.entries(actual))
    for (const metric of ['rows', 'bytes'])
      assert(
        stored[metric] <= budget[table][metric],
        `${label}/${table}: ${stored[metric]} > ${budget[table][metric]} ${metric} per project; fixed rows must not grow with landing history`,
      );
}
export async function landingStorage(t, dogfood, { fileCount = 4096, capsules = false, capsuleSample } = {}) {
  const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const f = await finishFixture(
    t,
    dogfood
      ? {
          fileCount,
          selectedFileCount: 128,
          beforeSourceMutation: (_name, args) => {
            // A synthetic input, like the fixture's fixed clock: real RPC timing digits must not
            // make byte storage depend on the host OS. New fields and step counts still ratchet.
            if (args.timing)
              for (const key of ['runMs', 'readMs', 'writeMs', 'callMs', 'bootMs']) {
                if (key in args.timing) args.timing[key] = 0;
              }
          },
        }
      : {},
  );
  const r2 = {
    source: { classA: 0, classB: 0, deletes: 0 },
    maintenance: { classA: 0, classB: 0, deletes: 0 },
  };
  let caller = 'source';
  const original = globalThis.fetch;
  const requestMeter = t.mock.method(globalThis, 'fetch', async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname.includes('.r2.')) {
      const key =
        init?.method === 'DELETE'
          ? 'deletes'
          : init?.method === 'PUT' || parsed.searchParams.has('list-type')
            ? 'classA'
            : 'classB';
      r2[caller][key]++;
    }
    return original(url, init);
  });
  const before = storedBytes(f);
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  if (dogfood) {
    inflateDogfoodChecks(f);
    f.moveMain();
  }
  await f.drain();
  if (dogfood) {
    await f.passChecks();
    inflateDogfoodChecks(f);
    await f.drain();
  }
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const delta = () =>
    Object.fromEntries(
      Object.entries(storedBytes(f))
        .filter(([table]) => !fixedProjectTables.has(table))
        .map(([table, size]) => [table, Math.max(0, size - before[table])]),
    );
  const immediate = delta();
  const fixedImmediate = fixedProjectStorage(f);
  caller = 'maintenance';
  let capsule = null;
  if (capsules) {
    const previous = process.env.FORGE_LANDING_CAPSULES;
    const maintenance = await capsuleMaintenanceFixture(t, { f, state });
    const packed = await maintenance.pack().finally(() => {
      if (previous === undefined) delete process.env.FORGE_LANDING_CAPSULES;
      else process.env.FORGE_LANDING_CAPSULES = previous;
    });
    if (capsuleSample) await capsuleSample(maintenance, packed);
    capsule = {
      ...packed.metrics,
      classA: maintenance.requests.filter(method => method === 'PUT').length,
      classB: maintenance.requests.filter(method => method === 'GET').length,
    };
    r2.maintenance.classA += capsule.classA;
    r2.maintenance.classB += capsule.classB;
  }
  const expiry = await import(moduleUrl('../convex/projectOperationalExpiry.ts'));
  const checks = [...f.tables.projectHostedCheckRuns.values()];
  // Controlled clock, no sleeps: maintenance is due after the landing has completed.
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 86_400_000;
  try {
    for (const row of checks)
      for (const phase of capsules ? ['detail'] : ['callbacks', 'detail']) {
        let more = true;
        for (let i = 0; more && i < 100; i++)
          more = (
            await f.c.transaction('storageExpiry', expiry.check, {
              projectId: f.projectId,
              runId: row.runId,
              phase,
              operationId: `exhaust:${row.runId}:${phase}`,
              part: i,
              dueAt: 0,
              continue: false,
            })
          ).more;
        assert.equal(more, false);
      }
    for (const row of f.tables.projectSourceSteps.values()) {
      let more = true;
      for (let part = 0; more && part < 100; part++)
        more = (
          await f.c.transaction('storageSourceExpiry', expiry.source, {
            projectId: f.projectId,
            jobId: row.jobId,
            dueAt: 0,
            continue: false,
            operationId: `exhaust:${row.jobId}:source`,
            part,
          })
        ).more;
      assert.equal(more, false);
    }
  } finally {
    Date.now = realNow;
  }
  const retained = delta();
  requestMeter.mock.restore();
  return {
    perLanding: { immediate, retained },
    perProject: { immediate: fixedImmediate, retained: fixedProjectStorage(f) },
    r2,
    ...(capsule ? { capsule } : {}),
  };
}
