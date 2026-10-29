// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptanceFixture, records, api, publish } from './hosted-acceptance-fixture.mjs';
import { checksFixture, code } from './hosted-checks-fixture.mjs';
import { hostedCheckRunSchema } from '../dist/hosted-check.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { hostedRecordSchema } from '../dist/hosted-records.js';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
import { stateSchema } from '../dist/native-state-format.js';
import { moduleUrl } from './convex-module.mjs';
const gate = await import(moduleUrl('../convex/projectHostedGate.ts'));
const at = '2026-01-01T00:00:00.000Z',
  hash = 'a'.repeat(64),
  leaf = 'tests/leaf.test.mjs';
async function seed(f, candidate, preset = 'trusted') {
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset(preset) });
  f.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    lastGreen: { sequence: 0, head: candidate.base.head, runId: randomUUID() },
  });
  const intent = hostedRecordSchema.options[0].parse({
    kind: 'intent',
    id: candidate.intentId,
    version: 0,
    at,
    outcome: 'Synthetic contract gate',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: candidate.base,
    status: 'active',
    testContracts: [
      {
        version: 1,
        operationId: randomUUID(),
        request: hash,
        candidateId: candidate.id,
        measuredOn: candidate.result.head,
        runId: randomUUID(),
        at,
        proposedTests: [leaf],
        tests: [{ path: leaf, durationMs: 10 }],
        totalMs: 10,
      },
    ],
  });
  await f.run('gateIntent', records.writeHostedRecord, { ...f.auth, expectedVersion: null, record: intent });
  return intent;
}
async function ready(preset = 'trusted', paths = ['src/leaf.ts'], agent = true) {
  const f = await acceptanceFixture();
  const item = await f.makeCandidate(
    [],
    [],
    paths === null ? {} : { governance: { version: 1, paths, ownerInputs: false } },
  );
  const intent = await seed(f, item.candidate, preset);
  const run = await f.rawChecks.enqueue(
    f.rawChecks.selection({ candidateId: item.candidate.id, expectedHead: item.candidate.result.head }),
  );
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === run.id);
  const value = JSON.parse(row.value);
  value.gate = { mode: 'contract', tests: [leaf], contractVersion: 1, effective: 'contract' };
  f.patch('projectHostedCheckRuns', row._id, { gate: value.gate, value: JSON.stringify(value) });
  const { state } = await f.ready(item, { agent, check: { kind: 'run', runId: run.id } });
  return { f, state, run: value, candidate: item.candidate, intent };
}
test('trusted contract acceptance has no extra calls and bounded audit bookkeeping over full evidence', async t => {
  const measured = [];
  for (const effective of ['full', 'contract']) {
    const { f, state } = await ready();
    const row = [...f.tables.projectHostedCheckRuns.values()][0],
      run = JSON.parse(row.value);
    run.gate.effective = effective;
    f.patch('projectHostedCheckRuns', row._id, { gate: run.gate, value: JSON.stringify(run) });
    const result = await f.commit(await f.claimAcceptance(state));
    assert.equal(result.status, 'landed');
    assert.equal(result.receipt.check.runId, run.id);
    const calls = f.counts.filter(c => c.name === 'acceptancePublish');
    assert.equal(calls.length, 1);
    measured.push({ calls: calls.length, reads: calls[0].documents, writes: calls[0].writes });
  }
  assert.equal(measured[1].calls, measured[0].calls);
  // Publication reads the live main gate; the landed audit also reads its
  // cadence setting for a counted contract landing instead of re-greening.
  assert.equal(measured[1].reads, measured[0].reads + 2);
  // B2.3 counts this landing and arms its one wake; gate decision itself is
  // read-only (separately measured below).
  assert.equal(measured[1].writes, measured[0].writes + 2);
  t.diagnostic(JSON.stringify({ full: measured[0], contract: measured[1] }));
});
test('supervised contract-only evidence cannot publish even with explicit person review', async () => {
  const { f, state } = await ready('supervised');
  const claim = await f.claimAcceptance(state);
  await assert.rejects(f.commit(claim), code('CHECK_NOT_PASSED'));
  await assert.rejects(
    f.runAcceptance(
      'reviewContract',
      ctx => publish.publishAcceptance(ctx, claim, Date.now(), { kind: 'person', id: 'owner' }),
      {},
    ),
    code('CHECK_NOT_PASSED'),
  );
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});
test('protected paths reject contract-only evidence and full evidence waits for owner acceptance', async () => {
  const { f, state } = await ready('trusted', ['.github/workflows/check.yml']);
  const claim = await f.claimAcceptance(state);
  await assert.rejects(f.commit(claim), code('CHECK_NOT_PASSED'));
  const row = [...f.tables.projectHostedCheckRuns.values()][0],
    run = JSON.parse(row.value);
  run.gate.effective = 'full';
  f.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(run), gate: run.gate });
  assert.equal((await f.commit(claim)).status, 'pending');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(
    JSON.parse(await f.transaction('ownerApprove', api.approve, f.select(state))).status,
    'landed',
  );
});
test('red main holds ready contract attempt and releases queue without polling or acceptance writes', async () => {
  const { f, state } = await ready();
  const audit = [...f.tables.projectHostedMainAudits.values()][0];
  f.patch('projectHostedMainAudits', audit._id, { red: { since: at, head: hash, runId: randomUUID() } });
  const result = await f.commit(await f.claimAcceptance(state));
  assert.equal(result.status, 'pending');
  assert.equal(result.request.phase, 'ready');
  assert.equal(result.request.observation.pendingReason, 'queued');
  assert.equal(result.request.error.code, 'MAIN_RED');
  const row = [...f.tables.projectHostedLandingRequests.values()][0];
  assert.equal(row.hold, 'main-red');
  assert.equal(row.runnable, false);
  assert.equal(row.alarm, null);
  assert.equal(f.pendingTasks().length, 0);
  assert.equal(f.queue().lease, null);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});
test('enqueue ignores client gate and stamps current contract from the already-read Intent', async () => {
  const f = await checksFixture();
  const candidate = {
    ...f.candidate,
    id: randomUUID(),
    governance: { version: 1, paths: ['src/leaf.ts'], ownerInputs: true },
  };
  await f.run('gateCandidate', records.writeHostedRecord, {
    ...f.auth,
    expectedVersion: null,
    record: candidate,
  });
  await seed(f, candidate);
  f.decorateContext(ctx => {
    ctx.scheduler = { runAfter: async () => 'synthetic-task' };
  });
  await f.bindRepository(f.projectId, { repository: 'synthetic/project', repoId: 42 });
  const configuration = await f.configure(
    {
      kind: 'runner',
      configuration: {
        provider: 'github-actions',
        repository: 'synthetic/project',
        runsOn: 'ubuntu-latest',
        runtime: hostedActionsRuntime,
        environmentFingerprint: f.runner.environmentFingerprint,
      },
    },
    f.configuration.digest,
  );
  const run = await f.enqueue(
    f.selection({
      candidateId: candidate.id,
      expectedConfiguration: configuration.digest,
      gate: { mode: 'probe', tests: ['tests/forged.test.mjs'] },
    }),
  );
  assert.equal(run.gate.mode, 'contract');
  assert.deepEqual(run.gate.tests, [leaf]);
  const intentRows = f.counts.filter(c => c.name === 'checkEnqueue').at(-1);
  assert(intentRows.documents < 40);
  assert.deepEqual(await f.enqueue(run.request), run);
});
test('strict gate exports validate args/documents and history adoption retains main-run provenance and CAS', async () => {
  const f = await checksFixture();
  await seed(f, f.candidate);
  const run = await f.enqueue(f.selection());
  const row = [...f.tables.projectHostedCheckRuns.values()][0];
  const value = {
    ...run,
    status: 'passed',
    endedAt: at,
    contractReports: { [leaf]: { durationMs: 12, failed: false } },
  };
  f.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(value), status: 'passed' });
  const audit = [...f.tables.projectHostedMainAudits.values()][0];
  f.patch('projectHostedMainAudits', audit._id, {
    lastGreen: { sequence: 0, head: run.request.expectedHead, runId: run.id },
  });
  f.insert('projectHostedTestTimings', {
    projectId: f.projectId,
    history: JSON.stringify({
      version: 1,
      files: { [leaf]: { durationMs: 11, updatedAt: at } },
      runs: [run.id],
    }),
  });
  const input = { projectId: f.projectId, candidateId: f.candidate.id };
  const basis = JSON.parse(await f.call('gateHistory', gate.history, input));
  assert.equal(basis.runId, run.id);
  assert.equal(basis.timings[leaf], 11);
  const intent = JSON.parse(
    (
      await f.run('readIntent', records.readHostedRecord, {
        ...f.auth,
        kind: 'intent',
        key: f.candidate.intentId,
      })
    ).value,
  );
  const contract = {
    ...intent.testContracts[0],
    timingBasis: 'history',
    version: 2,
    operationId: randomUUID(),
    runId: run.id,
    measuredOn: basis.measuredOn,
    tests: [{ path: leaf, durationMs: 11 }],
    totalMs: 11,
  };
  const args = { ...input, authorityEpoch: 1, contract: JSON.stringify(contract) };
  const result = await f.call('historyConfirm', gate.confirmHistory, args);
  assert.equal(JSON.parse(result).contract.timingBasis, 'history');
  assert.equal(await f.call('historyReplay', gate.confirmHistory, args), result);
  await assert.rejects(
    f.call('historyChangedReplay', gate.confirmHistory, {
      ...args,
      contract: JSON.stringify({ ...contract, request: 'b'.repeat(64) }),
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  await assert.rejects(
    f.call('historyStaleVersion', gate.confirmHistory, {
      ...args,
      contract: JSON.stringify({ ...contract, operationId: randomUUID() }),
    }),
    code('WORK_STALE'),
  );
  await assert.rejects(f.call('historyDenied', gate.history, input, 'outsider'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(f.call('badArgs', gate.history, { ...input, extra: true }), /ArgumentValidationError/);
  assert.throws(
    () => f.insert('projectHostedMainAudits', { projectId: f.projectId, red: {} }),
    /DocumentValidationError/,
  );
});
test('dogfood-size selected gate read is constant: 600 Intents, 575 receipts and a validated 3k-file tree', async t => {
  const { f, state, run, candidate, intent: template } = await ready();
  for (let i = 1; i < 600; i++) {
    const record = hostedRecordSchema.parse({ ...template, id: randomUUID() });
    await f.runAcceptance('scaleSeed', records.writeHostedRecord, {
      ...f.auth,
      expectedVersion: null,
      record,
    });
  }
  stateSchema.parse({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    at,
    message: 'Synthetic 3k tree',
    files: Array.from({ length: 3000 }, (_, i) => ({ path: `src/file-${i}.ts`, blob: hash, mode: 'file' })),
  });
  const receipt = (await f.commit(await f.claimAcceptance(state))).receipt;
  for (let i = 1; i < 575; i++) {
    const r = hostedAcceptanceSchema.parse({
      ...receipt,
      id: randomUUID(),
      snapshot: { ...receipt.snapshot, revision: i + 1 },
    });
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: r.id,
      submissionId: r.submissionId,
      attemptId: r.attemptId,
      sequence: i + 1,
      value: JSON.stringify(r),
    });
  }
  const started = performance.now();
  const value = await f.runAcceptance(
    'gateBudget',
    ctx =>
      gate.hostedAcceptGate(
        ctx,
        f.tables.hostedProjects.get(f.projectId),
        candidate,
        { kind: 'agent', id: 'owner' },
        run,
      ),
    {},
  );
  assert.equal(value, 'pass');
  const count = f.counts.filter(c => c.name === 'gateBudget').at(-1);
  assert.equal(count.writes, 0);
  assert.equal(count.documents, 2);
  assert.equal(count.ranges, 2);
  t.diagnostic(
    JSON.stringify({
      calls: 0,
      reads: count.documents,
      writes: count.writes,
      wallMs: performance.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});

test('hosted batch selector reads main once for 600 Candidates and unions their contracts', async t => {
  const { f, candidate, intent } = await ready();
  const contract = intent.testContracts.at(-1);
  const candidates = Array.from({ length: 600 }, (_, index) => ({
    candidate,
    actor: { kind: 'agent', id: 'owner' },
    contract: {
      ...contract,
      version: index + 1,
      tests: [{ path: `tests/member-${index}.test.mjs`, durationMs: 1 }],
    },
  }));
  const started = performance.now();
  const value = await f.runAcceptance(
    'batchGateBudget',
    ctx => gate.hostedGateForCandidates(ctx, f.tables.hostedProjects.get(f.projectId), candidates),
    {},
  );
  assert.equal(value.mode, 'contract');
  assert.equal(value.tests.length, 600);
  assert.equal(value.contractVersion, 600);
  const count = f.counts.filter(c => c.name === 'batchGateBudget').at(-1);
  assert.equal(count.documents, 1);
  assert.equal(count.ranges, 1);
  assert.equal(count.writes, 0);
  t.diagnostic(
    JSON.stringify({
      candidates: 600,
      calls: 0,
      reads: count.documents,
      writes: 0,
      wallMs: performance.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});

test('owner person keeps explicit reviewed acceptance with a reduced run selected', async () => {
  const { f, state } = await ready('trusted', ['src/leaf.ts'], false);
  assert.equal((await f.commit(await f.claimAcceptance(state))).status, 'landed');
});

test('finish driver sleeps on a red-main hold with no ready wake or stall alarm left', async t => {
  const synthetic = {
    FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
    FORGE_SOURCE_PROVIDER: 'modal',
    FORGE_SOURCE_WORKER: 'fixed-worker',
    FORGE_SOURCE_RUNTIME: hash,
    FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  };
  const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const { finishFixture } = await import('./hosted-finish-fixture.mjs');
  const f = await finishFixture(t),
    state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  const row = [...f.tables.projectHostedCheckRuns.values()][0],
    run = JSON.parse(row.value);
  run.gate = { mode: 'contract', tests: [leaf], contractVersion: 1, effective: 'contract' };
  f.patch('projectHostedCheckRuns', row._id, { gate: run.gate, value: JSON.stringify(run) });
  f.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    red: { since: at, head: f.currentMain().head, runId: randomUUID() },
  });
  await f.drain();
  const held = (await f.current(state.id)).submission;
  assert.equal(held.phase, 'ready');
  assert.equal(held.error.code, 'MAIN_RED');
  assert.equal(f.row(state.id).wake, null);
  assert.equal(f.pending().length, 0);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('new server keeps strict legacy controller run shapes full under every preset', async () => {
  for (const preset of ['supervised', 'trusted', 'autonomous']) {
    const f = await checksFixture();
    f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset(preset) });
    const run = await f.enqueue(f.selection());
    assert.equal(run.gate, undefined);
    assert.deepEqual(hostedCheckRunSchema.omit({ gate: true }).strict().parse(run), run);
  }
});

test('owner-person contract selections still need full evidence when supervised or protected', async () => {
  for (const [preset, paths] of [
    ['supervised', ['src/leaf.ts']],
    ['trusted', ['.github/workflows/check.yml']],
  ]) {
    const { f, state } = await ready(preset, paths, false);
    await assert.rejects(f.commit(await f.claimAcceptance(state)), code('CHECK_NOT_PASSED'));
    assert.equal(f.tables.projectHostedAcceptances.size, 0);
  }
});

test('unknown private path coverage requires full evidence and explicit owner acceptance after opt-in', async () => {
  const { f, state } = await ready('trusted', null);
  const row = [...f.tables.projectHostedCheckRuns.values()][0],
    run = JSON.parse(row.value);
  run.gate.effective = 'full';
  f.patch('projectHostedCheckRuns', row._id, { gate: run.gate, value: JSON.stringify(run) });
  assert.equal((await f.commit(await f.claimAcceptance(state))).status, 'pending');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(
    JSON.parse(await f.transaction('ownerApproveUnknown', api.approve, f.select(state))).status,
    'landed',
  );
});

test('private contributors cannot use person authority to bypass full checks or protected-path owner acceptance', async t => {
  for (const [name, paths, checked] of [
    ['unchecked', ['src/leaf.ts'], false],
    ['unprotected full', ['src/leaf.ts'], true],
    ['protected full', ['.github/workflows/check.yml'], true],
  ])
    await t.test(name, async () => {
      const f = await acceptanceFixture();
      f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
      f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
      const item = await f.makeCandidate([], [], { governance: { version: 1, paths, ownerInputs: false } });
      let run;
      if (checked) {
        run = await f.rawChecks.enqueue(
          f.rawChecks.selection({ candidateId: item.candidate.id, expectedHead: item.candidate.result.head }),
          'contributor',
        );
        await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      }
      const state = await f.enqueue(
        f.request({
          candidateId: item.candidate.id,
          expectedHead: item.candidate.result.head,
          agent: false,
          check: run ? { kind: 'run', runId: run.id } : null,
        }),
        'contributor',
      );
      await f.drain();
      const selection = f.select(state);
      await f.transaction('contributorPrepare', api.prepare, selection, 'contributor');
      for (const kind of ['inputs', 'dependencies'])
        for (const [index, page] of item.pages[kind].entries())
          await f.transaction(
            'contributorStage',
            api.stage,
            { ...selection, kind, index, page: JSON.stringify(page.value) },
            'contributor',
          );
      const claim = await f.claimAcceptance(state);
      if (!checked) {
        await assert.rejects(f.commit(claim), code('CHECK_NOT_PASSED'));
        assert.equal(f.tables.projectHostedAcceptances.size, 0);
      } else if (name === 'protected full') {
        assert.equal((await f.commit(claim)).status, 'pending');
        assert.equal(f.tables.projectHostedAcceptances.size, 0);
        assert.equal(
          JSON.parse(await f.transaction('ownerApproveContributor', api.approve, selection)).status,
          'landed',
        );
      } else assert.equal((await f.commit(claim)).status, 'landed');
    });
});

test('explicit owner review can accept the owner agent unprotected contract while red main holds automation', async () => {
  const { f, state } = await ready();
  const audit = [...f.tables.projectHostedMainAudits.values()][0];
  f.patch('projectHostedMainAudits', audit._id, { red: { since: at, head: hash, runId: randomUUID() } });
  assert.equal((await f.commit(await f.claimAcceptance(state))).status, 'pending');
  const reviewed = JSON.parse(await f.transaction('reviewOwnerContract', api.approve, f.select(state)));
  assert.equal(reviewed.status, 'landed');
  assert.deepEqual(reviewed.receipt.actor, { kind: 'person', id: 'owner' });
});
