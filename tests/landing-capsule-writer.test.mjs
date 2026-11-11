// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { randomBytes } from 'node:crypto';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { digest } from '../dist/hash.js';
import {
  hostedLandingAttemptSchema,
  readLandingTransition,
  hostedLandingStateSchema,
} from '../dist/hosted-landing.js';
import assert from 'node:assert/strict';
import { capsuleMaintenanceFixture as fixture } from './landing-capsule-maintenance-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { decodeLandingCapsule } from '../dist/landing-capsule-bytes.js';
const run = await import(moduleUrl('../convex/projectLandingCapsuleRun.ts'));
const store = await import(moduleUrl('../convex/projectLandingCapsuleStore.ts'));
const capture = await import(moduleUrl('../convex/projectLandingCapsuleCapture.ts'));

test('S1 packs one verified complete object, removes bounded canonical copies and returns its original pointer on replay', async t => {
  const h = await fixture(t);
  const result = await h.pack();
  assert.equal(h.requests.filter(method => method === 'PUT').length, 1);
  const capsule = decodeLandingCapsule(
    h.objects.get(result.pointer.sha256),
    result.pointer,
    h.f.projectId,
    h.state.id,
  );
  assert(capsule.tables.projectHostedLandingObservations.length > 0);
  assert(capsule.tables.projectHostedLandingAttempts.length > 0);
  for (const table of [
    'projectHostedLandingObservations',
    'projectHostedLandingAttempts',
    'projectHostedAcceptancePlans',
    'projectHostedAcceptancePages',
    'projectHostedAcceptanceEvents',
    'projectHostedAcceptanceSnapshots',
    'projectHostedComposePages',
  ])
    assert.equal(h.f.tables[table].size, 0, table);
  assert([...h.f.tables.projectFinishReadRows.values()].some(row => row.kind === store.capsuleKind));
  assert(
    [...h.f.tables.projectFinishReadRows.values()].some(row => row.kind === 'projectHostedLandingAttempts'),
    'transactional metric/pin projection stays',
  );
  const replay = await h.pack();
  assert.equal(replay.pointer.sha256, result.pointer.sha256);
  assert.equal(h.requests.filter(method => method === 'PUT').length, 1);
  t.diagnostic(JSON.stringify({ calls: h.calls.length, requests: h.requests, ...result.metrics }));
});

test('S1 verification failure preserves every canonical history row and publishes no pointer', async t => {
  const h = await fixture(t);
  const before = Object.fromEntries(Object.entries(h.f.tables).map(([table, rows]) => [table, rows.size]));
  h.corrupt();
  await assert.rejects(h.pack(), error => (error.code ?? error.data?.code) === 'EVIDENCE_CHANGED');
  for (const table of [
    'projectHostedLandingObservations',
    'projectHostedLandingAttempts',
    'projectHostedAcceptancePlans',
    'projectHostedAcceptancePages',
  ])
    assert.equal(h.f.tables[table].size, before[table]);
  assert(![...h.f.tables.projectFinishReadRows.values()].some(row => row.kind === store.capsuleKind));
});

test('S1 lost publication response resumes the same verified object without repeating the PUT', async t => {
  const h = await fixture(t);
  h.losePublish();
  await assert.rejects(h.pack(), /Synthetic lost published response/);
  const pointer = JSON.parse(
    [...h.f.tables.projectFinishReadRows.values()].find(row => row.kind === store.capsuleKind).value,
  );
  const result = await h.pack();
  assert.equal(result.pointer.sha256, pointer.sha256);
  assert.equal(h.requests.filter(method => method === 'PUT').length, 1);
  assert.equal(h.f.tables.projectHostedLandingAttempts.size, 0);
});

test('S1 default-off packer performs no function or R2 calls', async () => {
  const previous = process.env.FORGE_LANDING_CAPSULES;
  delete process.env.FORGE_LANDING_CAPSULES;
  try {
    const result = JSON.parse(
      await run.pack._handler(
        { runMutation: () => assert.fail('no function call') },
        { projectId: 'synthetic', submissionId: 'synthetic', dueAt: 0 },
      ),
    );
    assert.equal(result.reason, 'disabled');
  } finally {
    if (previous === undefined) delete process.env.FORGE_LANDING_CAPSULES;
    else process.env.FORGE_LANDING_CAPSULES = previous;
  }
});

test('S1 mutable acceptance completion defers packing and its existing completion event supplies the wake', async t => {
  const h = await fixture(t);
  const plan = [...h.f.tables.projectHostedAcceptancePlans.values()][0];
  const tick = [...h.f.tables._scheduled_functions.keys()][0];
  h.f.patch('projectHostedAcceptancePlans', plan._id, { completion: { tick, guard: null } });
  const first = JSON.parse(await h.f.tx('capsuleDeferredCompletion', capture.begin, h.input));
  assert.equal(first.deferred, 'completion');
  assert.equal((await h.pack()).deferred, 'completion');
  assert.equal(h.requests.length, 0);
  const acceptance = await import(moduleUrl('../convex/projectHostedAcceptance.ts'));
  await h.f.tx('capsuleExistingCompletion', acceptance.complete, {
    projectId: h.f.projectId,
    receiptId: plan.receiptId,
  });
  const stored = h.f.tables.projectHostedAcceptancePlans.get(plan._id);
  assert.equal(stored.completion, undefined);
  assert.equal(stored.capsuleWake, undefined);
  const wakes = [...h.f.tables._scheduled_functions.values()].filter(
    row => row.name === 'projectLandingCapsuleRun:pack',
  );
  assert.equal(wakes.length, 1, 'completion event wakes once, without a poll or new user step');
});

test('S1 preserves landings evidence, original attempt metric timestamps and trusted acceptance costs after relocation', async t => {
  const h = await fixture(t);
  const landings = await import(moduleUrl('../convex/projectHostedLandings.ts'));
  const metrics = await import(moduleUrl('../convex/projectSelfMetrics.ts'));
  const window = {
    projectId: h.f.projectId,
    from: '1970-01-01T00:00:00.000Z',
    to: '2100-01-01T00:00:00.000Z',
  };
  const read = async () => ({
    landings: JSON.parse(await h.f.tx('capsuleLandingsParity', landings.read, window)),
    attempts: JSON.parse(
      await h.f.tx('capsuleAttemptMetricsParity', metrics.page, {
        ...window,
        stream: 'attempts',
        cursor: null,
      }),
    ),
    acceptances: JSON.parse(
      await h.f.tx('capsuleAcceptanceMetricsParity', metrics.page, {
        ...window,
        stream: 'acceptances',
        cursor: null,
      }),
    ),
  });
  const before = await read();
  await h.pack();
  const after = await read();
  for (const value of [before.attempts, after.attempts]) if (value.isDone) value.continueCursor = null; // Provider cursors are opaque and unused after done.
  assert.deepEqual(after, before);
});

test('S1 terminal transition arms exactly one seven-day wake without another controller call', async t => {
  const h = await fixture(t, { enabled: true, advance: false });
  const row = [...h.f.tables.projectHostedLandingRequests.values()][0];
  const state = JSON.parse(row.value);
  const wakes = [...h.f.tables._scheduled_functions.values()].filter(
    row => row.name === 'projectLandingCapsuleRun:pack',
  );
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].scheduledTime, Date.parse(state.timing.settledAt) + 7 * 86_400_000);
  assert.equal(wakes[0].args[0].submissionId, state.id);
  assert.equal((await h.pack()).reason, 'grace');
  assert.equal(h.requests.length, 0);
});

test('S1 lost removal response resumes the committed offset without another object write or duplicate ledger pages', async t => {
  const h = await fixture(t);
  h.loseRemove();
  await assert.rejects(h.pack(), /Synthetic lost removal response/);
  const pointer = JSON.parse(
    [...h.f.tables.projectFinishReadRows.values()].find(row => row.kind === store.capsuleKind).value,
  );
  const result = await h.pack();
  assert.equal(result.pointer.sha256, pointer.sha256);
  assert.equal(h.requests.filter(method => method === 'PUT').length, 1);
  assert.equal(h.f.tables.projectHostedLandingAttempts.size, 0);
  const pins = [...h.f.tables.projectFinishReadRows.values()].filter(
    row => row.kind === 'projectLandingCapsulePages',
  );
  assert.equal(new Set(pins.map(row => row.sourceId)).size, pins.length);
});

test('S1 retains a large original policy in automatically continued transaction-pin pages', async t => {
  const h = await fixture(t);
  const row = [...h.f.tables.projectHostedLandingAttempts.values()][0];
  const attempt = JSON.parse(row.value);
  attempt.policy.acceptance.protectedPaths = ['synthetic/' + 'x'.repeat(100_000)];
  attempt.policyDigest = digest(canonicalPayload(attempt.policy));
  hostedLandingAttemptSchema.parse(attempt);
  h.f.patch('projectHostedLandingAttempts', row._id, { value: canonicalPayload(attempt) });
  await h.pack();
  const original = await h.f.tx(
    'capsuleLargeOriginalPins',
    { _handler: ctx => store.capsuleAttempt(ctx, { projectId: h.f.projectId, attemptId: attempt.id }) },
    {},
  );
  assert.deepEqual(original, attempt);
  assert(
    [...h.f.tables.projectFinishReadRows.values()].filter(
      row => row.kind === 'projectLandingCapsuleAttemptPins',
    ).length > 1,
  );
});

test('S1 carries a schema-valid incompressible historical error whole, beyond the dogfood expectation without a user limit', async t => {
  const h = await fixture(t);
  const row = [...h.f.tables.projectHostedLandingObservations.values()][0];
  const value = JSON.parse(row.value);
  value.transition.error = { code: 'SYNTHETIC_ERROR', message: randomBytes(270_000).toString('base64') };
  const text = canonicalPayload(value);
  const current = JSON.parse([...h.f.tables.projectHostedLandingRequests.values()][0].value);
  hostedLandingStateSchema.parse(readLandingTransition(text, current).submission);
  h.f.patch('projectHostedLandingObservations', row._id, { value: text });
  const result = await h.pack();
  const capsule = decodeLandingCapsule(
    h.objects.get(result.pointer.sha256),
    result.pointer,
    h.f.projectId,
    h.state.id,
  );
  assert(capsule.tables.projectHostedLandingObservations.includes(canonicalPayload({ ...row, value: text })));
  assert.equal(h.requests.filter(method => method === 'PUT').length, 1);
  const logicalBytes = Object.values(capsule.tables)
    .flat()
    .reduce((n, text) => n + Buffer.byteLength(text), 0);
  assert(result.pointer.size <= logicalBytes + 2 * 1024 * 1024);
  t.diagnostic(
    JSON.stringify({
      worstCaseCompressedBytes: result.pointer.size,
      relocatedBytes: logicalBytes,
      ...result.metrics,
    }),
  );
});

test('S1 callback replay uses its retained digest and reuse aliases remain transactional', async t => {
  const h = await fixture(t);
  const row = [...h.f.tables.projectHostedCheckCallbacks.values()].find(
    row => JSON.parse(row.value).kind === 'complete',
  );
  const run = JSON.parse(
    [...h.f.tables.projectHostedCheckRuns.values()].find(run => run.runId === row.runId).value,
  );
  const callback = { ...h.f.rawChecks.complete(run), eventId: row.eventId };
  assert.equal(h.f.rawChecks.checkPin(callback), row.digest);
  const alias = h.f.insert('projectHostedCheckCallbacks', {
    projectId: h.f.projectId,
    runId: row.runId,
    eventId: 'reuse:synthetic-alias',
    digest: 'a'.repeat(64),
    value: '{}',
  });
  await h.pack();
  assert(h.f.tables.projectHostedCheckCallbacks.has(alias));
  assert.deepEqual(await h.f.rawChecks.callback(callback), run);
  await assert.rejects(
    h.f.rawChecks.callback({ ...callback, result: { ...callback.result, status: 'failed', exitCode: 1 } }),
    error => (error.code ?? error.data?.code) === 'WORK_OPERATION_CHANGED',
  );
});

test('S1 receipt ledger splits full storage pages and keeps original replay identities without a history cap', async () => {
  const f = lanesFixture();
  const projectId = f.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
  });
  const ledger = await import(moduleUrl('../convex/projectLandingCapsuleLedger.ts'));
  const values = Array.from({ length: 1200 }, (_, i) => [
    `synthetic-event-${i}`,
    digest(String(i)).repeat(2),
  ]);
  const write = entries =>
    f.call(
      'capsuleReceiptTree',
      { _handler: ctx => ledger.retainCapsuleReceipts(ctx, projectId, 'check:synthetic', entries) },
      {},
    );
  await write(values);
  assert(f.tables.projectFinishReadRows.size > 1);
  for (const row of f.tables.projectFinishReadRows.values())
    assert(Buffer.byteLength(row.value) <= 64 * 1024);
  const count = f.tables.projectFinishReadRows.size;
  await write(values.slice(0, 8));
  assert.equal(f.tables.projectFinishReadRows.size, count);
  for (const [key, value] of values.filter((_, i) => i % 100 === 0))
    assert.equal(
      await f.call(
        'capsuleReceiptTreeRead',
        { _handler: ctx => ledger.capsuleReceiptDigest(ctx, projectId, 'check:synthetic', key) },
        {},
      ),
      value,
    );
  await assert.rejects(
    write([[values[0][0], 'changed']]),
    error => (error.code ?? error.data?.code) === 'EVIDENCE_CHANGED',
  );
});

test('S1 unknown PUT outcome reconciles the original complete content pin before attempting another write', async t => {
  const h = await fixture(t);
  h.losePut();
  await assert.rejects(h.pack());
  assert.equal(h.objects.size, 1);
  assert(![...h.f.tables.projectFinishReadRows.values()].some(row => row.kind === store.capsuleKind));
  const original = [...h.objects.keys()][0];
  const replay = await h.pack();
  assert.equal(replay.pointer.sha256, original);
  assert.equal(h.requests.filter(method => method === 'PUT').length, 1);
});
