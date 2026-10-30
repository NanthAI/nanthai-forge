// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checkGateSchema, mainGateSchema } from '../dist/bet2-gate.js';
import { hostedCheckRequestSchema, hostedCheckRunSchema } from '../dist/hosted-check.js';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
import { hostedRecordSchema } from '../dist/hosted-records.js';
import { stateSchema } from '../dist/native-state-format.js';
import { semanticPayload } from '../dist/semantic-payload.js';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { checkArgs, checkDocument } from './convex-args.mjs';
import { moduleUrl } from './convex-module.mjs';

const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const state = await import(moduleUrl('../convex/projectHostedMainAuditState.ts'));
const { insertHostedCheckRun } = await import(moduleUrl('../convex/projectHostedChecks.ts'));
const gate = await import(moduleUrl('../convex/projectHostedGate.ts'));
const culprit = await import(moduleUrl('../convex/projectHostedCulprit.ts'));
const forbiddenContext = new Proxy(
  {},
  { get: (_, name) => assert.fail(`unexpected context access: ${String(name)}`) },
);
const at = '2026-01-01T00:00:00.000Z';
const hash = 'a'.repeat(64);
const unknown = { status: 'unknown', unaudited: { count: 0, firstAt: null }, debt: false, hold: null };
const plainRow = row => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')));
function receiptFor(run, sequence = 1) {
  const id = randomUUID();
  return hostedAcceptanceSchema.parse({
    schema: 1,
    id,
    projectId: run.projectId,
    channel: 'main',
    submissionId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    at,
    authorityEpoch: 1,
    previous: { head: hash, receiptId: 'main-0' },
    candidate: {
      id: run.request.candidateId,
      digest: run.candidate.digest,
      head: run.request.expectedHead,
      inputs: run.candidate.inputs,
      dependencies: run.candidate.dependencies,
      algorithm: run.candidate.algorithm,
    },
    actor: { id: 'owner', kind: 'person' },
    policyDigest: hash,
    check: null,
    snapshot: { id, previousId: 'main-0', revision: sequence },
    completion: { root: hash, pages: 0, lanes: 0, enabled: false },
    automatic: false,
    undo: { kind: 'revert', receiptId: id },
  });
}

test('gate metadata validates all five modes without changing old requests or runs', async () => {
  const f = await checksFixture(),
    request = f.selection(),
    run = await f.enqueue(request);
  assert.deepEqual(hostedCheckRequestSchema.parse(request), request);
  assert.deepEqual(hostedCheckRunSchema.parse(run), run);
  assert.equal(Object.hasOwn(run, 'gate'), false);
  for (const mode of ['contract', 'scoped', 'audit', 'probe', 'full']) {
    const metadata = {
      mode,
      tests: ['tests/example.test.mjs'],
      contractVersion: 1,
      reason: 'synthetic',
      effective: 'full',
    };
    assert.deepEqual(checkGateSchema.parse(metadata), metadata);
    assert.deepEqual(hostedCheckRequestSchema.parse({ ...request, gate: metadata }).gate, metadata);
    assert.deepEqual(hostedCheckRunSchema.parse({ ...run, gate: metadata }).gate, metadata);
  }
  for (const metadata of [
    { mode: 'other' },
    { mode: 'contract', contractVersion: -1 },
    { mode: 'full', effective: 'probe' },
  ])
    assert.equal(checkGateSchema.safeParse(metadata).success, false);
  assert.deepEqual(mainGateSchema.parse(unknown), unknown);
});

test('old check and landing documents remain valid; additive metadata is validated', async () => {
  const f = await checksFixture(),
    run = await f.enqueue(f.selection());
  const oldRun = [...f.tables.projectHostedCheckRuns.values()][0];
  assert.deepEqual(checkDocument(schema, 'projectHostedCheckRuns', oldRun), oldRun);
  const oldLanding = {
    _id: 'landing',
    _creationTime: 1,
    projectId: f.projectId,
    channel: 'main',
    submissionId: randomUUID(),
    operationId: randomUUID(),
    actor: 'owner',
    sequence: 1,
    runnable: true,
    phase: 'ready',
    runId: run.id,
    attemptId: randomUUID(),
    value: '{}',
  };
  assert.deepEqual(checkDocument(schema, 'projectHostedLandingRequests', oldLanding), oldLanding);
  checkDocument(schema, 'projectHostedLandingRequests', { ...oldLanding, hold: 'main-red' });
  assert.throws(
    () => checkDocument(schema, 'projectHostedLandingRequests', { ...oldLanding, hold: 'other' }),
    /DocumentValidationError/,
  );
  checkDocument(schema, 'projectHostedCheckRuns', { ...oldRun, gate: { mode: 'audit' } });
  assert.throws(
    () => checkDocument(schema, 'projectHostedCheckRuns', { ...oldRun, gate: { mode: 'other' } }),
    /DocumentValidationError/,
  );
  const names = schema.tables.projectHostedCheckRuns.export().indexes.map(i => i.indexDescriptor);
  assert.deepEqual(names, [
    'by_project',
    'by_run',
    'by_project_and_run',
    'by_project_and_candidate',
    'by_project_and_status',
    'by_project_and_machine_and_status',
  ]);
  assert(
    schema.tables.projectHostedLandingRequests
      .export()
      .indexes.some(i => i.indexDescriptor === 'by_project_and_hold'),
  );
});

test('insertHostedCheckRun preserves the exact old inserted document and dispatch hooks', async () => {
  const f = await checksFixture(),
    original = await f.enqueue(f.selection());
  for (const provider of ['modal', 'mac', 'self-hosted', 'github-actions']) {
    const configuration =
      provider === 'modal'
        ? {
            provider,
            app: 'synthetic',
            function: 'check',
            runtime: hash,
            environmentFingerprint: hash,
            credential: { secretId: 'synthetic', version: 1, operation: 'check' },
          }
        : provider === 'github-actions'
          ? {
              provider,
              repository: 'synthetic/checks',
              runsOn: 'ubuntu-latest',
              runtime: hash,
              environmentFingerprint: hash,
            }
          : { provider, machineId: randomUUID(), runtime: hash, environmentFingerprint: hash };
    const machine = provider === 'mac' || provider === 'self-hosted';
    const run = hostedCheckRunSchema.parse({
      ...original,
      id: randomUUID(),
      configuration,
      ...(machine ? { ownerDeadline: Date.now() + 60_000 } : {}),
    });
    const s = lanesFixture(),
      scheduled = [];
    s.decorateContext(ctx => {
      ctx.scheduler = {
        runAfter: async (...args) => {
          scheduled.push(args);
          return 'task';
        },
      };
    });
    assert.deepEqual(await s.call('insertRun', { _handler: insertHostedCheckRun }, run), run);
    const row = [...s.tables.projectHostedCheckRuns.values()][0];
    assert.deepEqual(plainRow(row), {
      projectId: run.projectId,
      runId: run.id,
      candidateId: run.request.candidateId,
      ...(machine ? { machineId: configuration.machineId } : {}),
      status: run.status,
      value: semanticPayload(run, true),
    });
    assert.equal(s.counts[0].ranges, 0);
    assert.equal(s.counts[0].writes, 1);
    assert.equal(scheduled.length, provider === 'modal' ? 0 : 1);
  }
});

test('prepared audit metadata can be inserted without changing legacy run bytes', async () => {
  const f = await checksFixture(),
    run = await f.enqueue(f.selection());
  const next = hostedCheckRunSchema.parse({ ...run, id: randomUUID(), gate: { mode: 'audit' } });
  await f.run('insertAudit', insertHostedCheckRun, next);
  const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === next.id);
  assert.deepEqual(row.gate, next.gate);
  assert.deepEqual(JSON.parse(row.value), next);
});

test('mainGate performs one indexed read and reports absent, green and red rows', async () => {
  const f = lanesFixture(),
    projectId = 'synthetic-project';
  const read = () => f.call('mainGate', { _handler: ctx => state.mainGate(ctx, projectId) }, {});
  assert.deepEqual(await read(), unknown);
  const id = f.insert('projectHostedMainAudits', { projectId });
  assert.deepEqual(await read(), unknown);
  f.patch('projectHostedMainAudits', id, {
    lastGreen: { sequence: 10, head: hash, runId: randomUUID() },
    unaudited: { count: 2, firstAt: at },
    debt: true,
  });
  assert.deepEqual(await read(), {
    ...unknown,
    status: 'green',
    unaudited: { count: 2, firstAt: at },
    debt: true,
  });
  f.patch('projectHostedMainAudits', id, {
    red: { since: at, head: hash, runId: randomUUID(), culprit: randomUUID() },
  });
  assert.equal((await read()).hold, 'main-red');
  assert.equal((await read()).status, 'red');
  for (const count of f.counts) {
    assert.equal(count.ranges, 1);
    assert.equal(count.documents, 1);
    assert.equal(count.writes, 0);
  }
});

test('remaining internal placeholder validates real arguments and never accesses context', async () => {
  for (const [fn, args] of [[gate.noop, { projectId: 'project' }]]) {
    checkArgs(fn, args, 'stub');
    assert.equal(await fn._handler(forbiddenContext, args), null);
    assert.throws(() => checkArgs(fn, {}, 'stub'), /ArgumentValidationError/);
    assert.equal(fn.isInternal, true);
  }
});

test('culprit classification validates arguments and no-ops for an absent project', async () => {
  const f = lanesFixture();
  const args = { projectId: 'missing-project', runId: randomUUID() };
  checkArgs(culprit.startRedClassification, args, 'classification');
  assert.throws(
    () => checkArgs(culprit.startRedClassification, {}, 'classification'),
    /ArgumentValidationError/,
  );
  assert.equal(culprit.startRedClassification.isInternal, true);
  assert.equal(await f.call('classification', culprit.startRedClassification, args), null);
  assert.equal(f.counts.at(-1).documents, 1);
  assert.equal(f.counts.at(-1).writes, 0);
});

test('600 Intents, 575 receipts and a 3k-file tree add zero IO at either no-op seam', async t => {
  const f = await checksFixture(),
    run = await f.enqueue(f.selection());
  const project = f.tables.hostedProjects.get(f.projectId);
  checkDocument(schema, 'hostedProjects', project);
  const intents = Array.from({ length: 600 }, () =>
    hostedRecordSchema.parse({
      kind: 'intent',
      id: randomUUID(),
      version: 0,
      at,
      outcome: 'Synthetic seam fixture',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: hash, receiptId: 'main-0' },
      status: 'active',
    }),
  );
  const files = Array.from({ length: 3000 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    blob: hash,
    mode: 'file',
  }));
  stateSchema.parse({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files,
    message: 'Synthetic 3k-file tree',
    at,
  });
  const receipts = Array.from({ length: 575 }, (_, i) => receiptFor(run, i + 1));
  const before = structuredClone({ run, project, receipts });
  const started = performance.now();
  for (const receipt of receipts) {
    assert.equal(await state.noteMainLanding(forbiddenContext, { project, receipt, run }), undefined);
    assert.equal(await state.noteMainLanding(forbiddenContext, { project, receipt, run: null }), undefined);
    for (const status of ['passed', 'failed', 'cancelled', 'interrupted', 'runner-unavailable']) {
      const terminal = hostedCheckRunSchema.parse({ ...run, status, endedAt: at });
      assert.equal(await state.onGateRunTerminal(forbiddenContext, terminal), undefined);
    }
  }
  assert.deepEqual({ run, project, receipts }, before);
  assert.equal(intents.length, 600);
  assert.equal(files.length, 3000);
  t.diagnostic(
    JSON.stringify({
      intents: intents.length,
      receipts: receipts.length,
      files: files.length,
      seamInvocations: receipts.length * 7,
      addedFunctionCalls: 0,
      documentReads: 0,
      documentWrites: 0,
      scheduledTasks: 0,
      elapsedMs: performance.now() - started,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});
