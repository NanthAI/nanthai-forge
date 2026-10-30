// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { autonomyPolicySchema, editedPolicy, policyPreset } from '../dist/autonomy-policy.js';
import { checkRoute, checkBackendSchema } from '../dist/check-backend.js';
import { sourceWorkerPlan } from '../dist/convex-source-provider.js';
import { validateRemoteCheckPlan } from '../dist/remote-check-plan.js';
import { digest } from '../dist/hash.js';
import { checksFixture, code } from './hosted-checks-fixture.mjs';

test('persisted Modal policies and credential references remain readable; new selection is refused', () => {
  for (const credentialsRef of [
    { kind: 'env', tokenId: 'PROJECT_ID', tokenSecret: 'PROJECT_SECRET' },
    { kind: 'file', path: '/synthetic/external-credentials.json' },
  ]) {
    const legacy = { ...policyPreset('trusted'), checks: { runner: 'modal', credentialsRef } };
    assert.deepEqual(autonomyPolicySchema.parse(legacy), legacy);
    assert.equal(editedPolicy(legacy, { notify: { awaySummary: false } }).checks.runner, 'modal');
    assert.equal(editedPolicy(legacy, { checks: { runner: 'local' } }).checks.runner, 'local');
    assert.throws(
      () => editedPolicy(policyPreset('trusted'), { checks: { runner: 'modal' } }),
      e => e.code === 'BAD_ARGUMENT' && /retired.*local or github-actions/.test(e.message),
    );
    assert.deepEqual(checkBackendSchema.parse({ requested: 'modal', actual: 'modal', credentialsRef }), {
      requested: 'modal',
      actual: 'modal',
      credentialsRef,
    });
  }
});

test('retired routes never silently become local or another source provider', () => {
  assert.throws(() => checkRoute('modal', { env: ['INPUT'] }, false), { code: 'RUNNER_UNAVAILABLE' });
  assert.throws(() => sourceWorkerPlan({ FORGE_SOURCE_PROVIDER: 'modal' }), {
    code: 'SOURCE_PROVIDER_CHANGED',
  });
  assert.equal(sourceWorkerPlan({}).provider, 'convex');
});

test('legacy Actions plan cost pin remains digest-bound and optional for new plans', () => {
  const pins = {
    runId: randomUUID(),
    viewId: randomUUID(),
    head: 'a'.repeat(64),
    definition: 'b'.repeat(64),
    selection: { scope: 'full', tests: [] },
    lockfile: 'c'.repeat(64),
    runtime: 'synthetic-actions',
    costSafetyMargin: 1.15,
    groups: [],
    standard: true,
    artifacts: [],
    interaction: false,
    command: ['node'],
  };
  for (const legacy of [true, false]) {
    const fields = { ...pins };
    if (!legacy) delete fields.costSafetyMargin;
    const pin = digest(JSON.stringify(fields));
    const plan = { ...fields, pin, source: '/synthetic', output: '/synthetic' };
    const run = {
      id: fields.runId,
      viewId: fields.viewId,
      head: fields.head,
      check: { definition: fields.definition },
      backend: { pin },
    };
    validateRemoteCheckPlan(plan, run);
    assert.throws(() => validateRemoteCheckPlan({ ...plan, costSafetyMargin: 2 }, run), /digest changed/);
  }
});

test('hosted Modal refusal stays constant-size across dogfood configuration history', async () => {
  const s = await checksFixture();
  const legacy = {
    provider: 'modal',
    app: 'synthetic',
    function: 'check',
    runtime: 'a'.repeat(64),
    environmentFingerprint: 'b'.repeat(64),
    credential: { secretId: 'synthetic', version: 1, operation: 'check' },
  };
  const { hostedCheckRunnerSchema } = await import('../dist/hosted-check.js');
  assert.deepEqual(hostedCheckRunnerSchema.parse(legacy), legacy);
  // Retained histories must remain readable without being loaded by a new selection.
  for (let version = 1; version <= 2800; version++)
    s.insert('projectHostedCheckSettingVersions', {
      projectId: s.projectId,
      kind: 'runner',
      key: 'runner',
      version,
      digest: s.checkPin(legacy),
      value: JSON.stringify(legacy),
    });
  const before = s.counts.length;
  const started = performance.now();
  await assert.rejects(
    s.configure({ kind: 'runner', configuration: legacy }, s.configuration.digest),
    code('BAD_ARGUMENT'),
  );
  const wallMs = performance.now() - started;
  const calls = s.counts.slice(before);
  assert.equal(calls.length, 1, 'one configuration operation, no history-page calls');
  const reads = calls.reduce((n, call) => n + call.documents, 0);
  const writes = calls.reduce((n, call) => n + call.writes, 0);
  assert(reads <= 12, `bounded point reads: ${reads}`);
  assert(writes <= 5, `bounded operation reservation writes: ${writes}`);
  assert(calls.every(call => !call.touched.includes('projectHostedCheckSettingVersions')));
  const current = [...s.tables.projectHostedCheckSettings.values()].find(row => row.kind === 'runner');
  const legacyDigest = s.checkPin(legacy);
  s.patch('projectHostedCheckSettings', current._id, {
    digest: legacyDigest,
    value: JSON.stringify(legacy),
  });
  const runs = s.tables.projectHostedCheckRuns.size;
  await assert.rejects(
    s.enqueue(
      s.selection({
        expectedConfiguration: legacyDigest,
        expectedEnvironment: legacy.environmentFingerprint,
      }),
    ),
    code('RUNNER_UNAVAILABLE'),
  );
  assert.equal(s.tables.projectHostedCheckRuns.size, runs, 'no replacement runner or check is created');
  assert.equal(s.tables.projectHostedCheckSettings.get(current._id).value, JSON.stringify(legacy));
  console.log(
    JSON.stringify({
      retiredModalHistory: 2800,
      calls: calls.length,
      reads,
      writes,
      wallMs,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});
