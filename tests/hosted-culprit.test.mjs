// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { hostedRecordValue, hostedRecordSchema } from '../dist/hosted-records.js';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
import { hostedCheckRunSchema, checkPin } from '../dist/hosted-check.js';
import { stateSchema } from '../dist/native-state-format.js';
import {
  culpritId,
  culpritProbeBudget,
  culpritFailures,
  probeVerdict,
  fixBrief,
} from '../dist/culprit-bisect.js';
import { effectivePolicy } from '../dist/autonomy-policy.js';
const syntheticR2 = {
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const previousR2 = Object.fromEntries(Object.keys(syntheticR2).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, syntheticR2));
test.after(() => {
  for (const [key, value] of Object.entries(previousR2)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const culprit = await import(moduleUrl('../convex/projectHostedCulprit.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const agent = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const at = '2026-10-29T00:00:00.000Z',
  hash = 'a'.repeat(64);
function seedRecord(f, record) {
  const { value, ref } = hostedRecordValue(record);
  const bodyId = f.insert('projectHostedRecordBodies', { projectId: f.projectId, value });
  const parent =
    record.kind === 'intent'
      ? record.creatorAccountId
      : record.kind === 'lane'
        ? record.intentId
        : record.intentId;
  const indexed = {
    projectId: f.projectId,
    kind: record.kind,
    key: record.id,
    parent,
    status: record.status ?? record.state ?? record.result.status,
    version: record.version,
  };
  const recordId = f.insert('projectHostedRecords', {
    ...indexed,
    bodyId,
    digest: ref.digest,
    bytes: ref.bytes,
  });
  f.insert('projectHostedRecordHeads', { ...indexed, recordId });
}
async function fixture(k = 5, { noop = false, addedAt = null } = {}) {
  const f = await checksFixture();
  const original = await f.enqueue(f.selection());
  f.scheduled = [];
  f.tables._scheduled_functions = new Map();
  f.decorateContext(ctx => {
    ctx.scheduler = {
      runAfter: async (_, ref, args) => {
        f.scheduled.push({ name: getFunctionName(ref), args });
        return 'scheduled-task';
      },
      cancel: async () => {},
    };
  });
  await f.bindRepository(f.projectId, { repository: 'synthetic/checks', repoId: 123, installationId: 9 });
  const tree = stateSchema.parse({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: Array.from({ length: 3000 }, (_, i) => ({ path: `src/file-${i}.ts`, blob: hash, mode: 'file' })),
    message: 'scale',
    at,
  });
  const heads = Array.from(
    { length: k + 1 },
    (_, i) =>
      f.put(
        JSON.stringify({
          ...tree,
          files: [
            ...tree.files,
            ...(addedAt !== null && i >= addedAt
              ? [
                  {
                    path: 'tests/red.test.mjs',
                    blob: f.put(`failing test revision ${i}`).sha256,
                    mode: 'file',
                  },
                ]
              : []),
          ],
          message: `scale-${i}`,
        }),
      ).sha256,
  );
  if (noop) heads[1] = heads[0];
  const intents = Array.from({ length: 600 }, () => ({
    kind: 'intent',
    id: randomUUID(),
    version: 0,
    at,
    outcome: 'Synthetic work',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: { head: heads[0], receiptId: 'main-0' },
    status: 'active',
  }));
  intents.forEach(intent => seedRecord(f, intent));
  f.receipts = [];
  for (let sequence = 1; sequence <= 575; sequence++) {
    const index = Math.max(0, sequence - (575 - k)),
      id = randomUUID();
    const previousId = f.receipts.at(-1)?.id ?? 'main-0';
    const receipt = hostedAcceptanceSchema.parse({
      schema: 1,
      id,
      projectId: f.projectId,
      channel: 'main',
      submissionId: randomUUID(),
      operationId: randomUUID(),
      attemptId: randomUUID(),
      at,
      authorityEpoch: 1,
      previous: { head: heads[Math.max(0, index - 1)], receiptId: previousId },
      candidate: {
        id: randomUUID(),
        digest: hash,
        head: heads[index],
        inputs: original.candidate.inputs,
        dependencies: original.candidate.dependencies,
        algorithm: 'native@fixture',
      },
      actor: { id: 'owner', kind: 'agent' },
      policyDigest: hash,
      check: null,
      snapshot: { id, previousId, revision: sequence },
      completion: { root: hash, pages: 0, lanes: 0, enabled: false },
      automatic: true,
      undo: { kind: 'revert', receiptId: id },
    });
    if (index > 0) {
      const candidate = {
        kind: 'candidate',
        id: receipt.candidate.id,
        version: 0,
        at,
        intentId: intents[sequence - 1].id,
        base: receipt.previous,
        inputs: receipt.candidate.inputs,
        dependencies: receipt.candidate.dependencies,
        algorithm: receipt.candidate.algorithm,
        result: { status: 'clean', head: heads[index] },
      };
      const { ref } = hostedRecordValue(candidate);
      receipt.candidate.digest = ref.digest;
      seedRecord(f, candidate);
    }
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: id,
      submissionId: receipt.submissionId,
      attemptId: receipt.attemptId,
      sequence,
      value: JSON.stringify(receipt),
    });
    f.receipts.push(receipt);
  }
  f.heads = heads;
  f.intents = intents;
  f.audit = hostedCheckRunSchema.parse({
    ...original,
    id: randomUUID(),
    actor: 'owner',
    configuration: {
      provider: 'github-actions',
      repository: 'synthetic/checks',
      installationId: '9',
      runsOn: 'ubuntu-latest',
      runtime: original.configuration.runtime,
      environmentFingerprint: original.configuration.environmentFingerprint,
    },
    request: { ...original.request, expectedHead: heads[k], candidateId: f.receipts.at(-1).candidate.id },
    gate: { mode: 'audit' },
    status: 'failed',
    endedAt: at,
    terminalDigest: hash,
    contractReports: { 'tests/red.test.mjs': { failed: true, firstError: 'synthetic failure' } },
  });
  const green = hostedCheckRunSchema.parse({
    ...f.audit,
    id: randomUUID(),
    status: 'passed',
    gate: { mode: 'full', effective: 'full' },
    request: { ...f.audit.request, expectedHead: heads[0] },
    contractReports: addedAt === null ? { 'tests/red.test.mjs': { failed: false } } : {},
  });
  f.insert('projectHostedCheckRuns', {
    projectId: f.projectId,
    runId: green.id,
    candidateId: green.request.candidateId,
    status: green.status,
    gate: green.gate,
    value: JSON.stringify(green),
  });
  f.auditRow = f.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    lastGreen: { sequence: 575 - k, head: heads[0], runId: green.id },
    unaudited: { count: k, firstAt: at },
    audit: { runId: f.audit.id, head: heads[k], sequence: 575, status: 'failed' },
    red: { since: at, head: heads[k], runId: f.audit.id },
  });
  f.insert('projectHostedCheckRuns', {
    projectId: f.projectId,
    runId: f.audit.id,
    candidateId: f.audit.request.candidateId,
    status: 'failed',
    gate: f.audit.gate,
    value: JSON.stringify(f.audit),
  });
  f.insert('projectHostedChannels', {
    projectId: f.projectId,
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify({
      schema: 2,
      projectId: f.projectId,
      snapshotId: randomUUID(),
      sourceRevision: 575,
      authority: { mode: 'server', epoch: 1 },
      channel: 'main',
      head: heads[k],
      receipt: {
        id: f.receipts.at(-1).id,
        kind: 'server',
        previousHead: heads[k - 1],
        previousReceiptId: f.receipts.at(-2).id,
      },
    }),
  });
  f.runCulprit = () =>
    f.transaction('classify', culprit.startRedClassification, { projectId: f.projectId, runId: f.audit.id });
  f.probes = () =>
    [...f.tables.projectHostedCheckRuns.values()]
      .map(r => JSON.parse(r.value))
      .filter(r => r.gate?.mode === 'probe');
  f.complete = async (run, verdict) => {
    const terminal = hostedCheckRunSchema.parse({
      ...run,
      status: verdict ? 'failed' : 'passed',
      terminalDigest: hash,
      endedAt: at,
      contractReports: { 'tests/red.test.mjs': { failed: verdict } },
    });
    const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === run.id);
    f.patch('projectHostedCheckRuns', row._id, { status: terminal.status, value: JSON.stringify(terminal) });
    await f.transaction('probeTerminal', culprit.terminal, { projectId: f.projectId, runId: terminal.id });
  };
  f.readIntent = async id =>
    JSON.parse(
      (
        await f.transaction(
          'readIntent',
          {
            _handler: ctx =>
              records.readHostedRecord(ctx, {
                projectId: f.projectId,
                actor: 'owner',
                kind: 'intent',
                key: id,
              }),
          },
          {},
        )
      ).value,
    );
  f.recoveryId = () =>
    culpritId({ redEpisode: f.tables.projectHostedMainAudits.get(f.auditRow).red?.since ?? at });
  f.inspect = async () => {
    const source = await import(moduleUrl('../convex/projectHostedCulpritSource.ts'));
    const input = { projectId: f.projectId, runId: f.recoveryId() };
    return source.inspect._handler(
      {
        runQuery: async (_, args) => {
          if (!args.digests) return f.transaction('sourcePlan', culprit.source, args);
          const rows = JSON.parse(await f.transaction('sourceDescriptors', culprit.source, args));
          f.sourceReads ??= { windows: 0, bytes: 0 };
          f.sourceReads.windows++;
          return JSON.stringify(
            rows.map(row => ({ ...row, storageId: row.descriptor.object.sha256, url: null })),
          );
        },
        storage: {
          get: async id => {
            const bytes = f.objectBytes.get(id);
            f.sourceReads.bytes += bytes.length;
            return new Blob([bytes]);
          },
        },
        runMutation: (_, args) => f.transaction('sourceEvidence', culprit.sourceEvidence, args),
      },
      input,
    );
  };
  f.recovery = () => [...f.tables.projectHostedOperations.values()].find(r => r.recovery);
  return f;
}

async function laterAudit(f, minutes, extra = {}) {
  const current = f.tables.projectHostedMainAudits.get(f.auditRow);
  const original = f.audit.id;
  f.audit = hostedCheckRunSchema.parse({
    ...f.audit,
    id: randomUUID(),
    endedAt: new Date(Date.parse(at) + minutes * 60000).toISOString(),
    contractReports: { ...f.audit.contractReports, ...extra },
    request: { ...f.audit.request, operationId: randomUUID() },
  });
  f.insert('projectHostedCheckRuns', {
    projectId: f.projectId,
    runId: f.audit.id,
    candidateId: f.audit.request.candidateId,
    status: 'failed',
    gate: f.audit.gate,
    value: JSON.stringify(f.audit),
  });
  f.patch('projectHostedMainAudits', f.auditRow, {
    audit: { ...current.audit, runId: f.audit.id },
    red: { ...current.red, head: f.audit.request.expectedHead, runId: f.audit.id },
  });
  await f.runCulprit();
  assert.notEqual(original, f.audit.id);
}

test('new failing test attribution selects its adding landing before later edits to the same file', async t => {
  const f = await fixture(5, { addedAt: 2 });
  await f.runCulprit();
  assert.equal(f.probes().length, 0);
  await f.inspect();
  await f.complete(f.probes()[0], true);
  const state = JSON.parse(f.recovery().recovery);
  assert.equal(state.target.id, f.receipts[571].id);
  assert.equal(state.addition, 2);
  assert.equal(state.stage, 'sync');
  assert.equal(f.probes().length, 1);
  assert.equal(f.sourceReads.windows, 1);
  assert(f.sourceReads.bytes < 3 * 1024 * 1024);
  const sourceCalls = f.counts.filter(c => c.name.startsWith('source'));
  t.diagnostic(
    JSON.stringify({
      sourceBytes: f.sourceReads.bytes,
      sourceCalls: sourceCalls.length,
      sourceDocumentsRead: sourceCalls.reduce((n, c) => n + c.documents, 0),
      sourceDbReadBytes: sourceCalls.reduce((n, c) => n + c.readBytes, 0),
    }),
  );
});

test('source attribution pages the maximum accepted range without file-blob reads', async t => {
  const f = await fixture(100, { addedAt: 65 });
  await f.runCulprit();
  await f.inspect();
  assert.equal(f.sourceReads.windows, 2);
  assert(f.sourceReads.bytes < 50 * 1024 * 1024);
  const descriptors = f.counts.filter(c => c.name === 'sourceDescriptors');
  assert(descriptors.every(c => c.documents <= 104));
  await f.complete(f.probes()[0], true);
  assert.equal(JSON.parse(f.recovery().recovery).target.id, f.receipts[539].id);
  t.diagnostic(
    JSON.stringify({
      manifests: 101,
      sourceBytes: f.sourceReads.bytes,
      descriptorCalls: descriptors.length,
      maxDescriptorDocuments: Math.max(...descriptors.map(c => c.documents)),
    }),
  );
});

test('a later different failure is retained when the original probe passes', async () => {
  const f = await fixture(1);
  await f.runCulprit();
  await laterAudit(f, 2, { 'tests/other.test.mjs': { failed: true } });
  await f.complete(f.probes()[0], false);
  assert(f.tables.projectHostedMainAudits.get(f.auditRow).red);
  const state = JSON.parse(f.recovery().recovery);
  assert.equal(state.stage, 'done');
  assert(state.evidence.some(f => f.file === 'tests/other.test.mjs'));
  assert.equal(f.tables.projectHostedSyncs.size, 0);
});

test('a passing original probe cannot clear a later red audit on different source', async () => {
  const f = await fixture(1);
  await f.runCulprit();
  f.audit = { ...f.audit, request: { ...f.audit.request, expectedHead: 'e'.repeat(64) } };
  await laterAudit(f, 2);
  await f.complete(f.probes()[0], false);
  assert.equal(f.tables.projectHostedMainAudits.get(f.auditRow).red.head, 'e'.repeat(64));
  assert.equal(JSON.parse(f.recovery().recovery).stage, 'done');
  assert.equal(f.tables.projectHostedSyncs.size, 0);
});

test('a source hash mismatch falls back without naming or reverting a culprit', async () => {
  const f = await fixture(1, { addedAt: 1 });
  await f.runCulprit();
  f.objectBytes.set(f.heads[0], Buffer.from('corrupt synthetic source'));
  await f.inspect();
  const state = JSON.parse(f.recovery().recovery);
  assert.equal(state.stage, 'done');
  assert.equal(state.target, undefined);
  assert.match(state.reason, /SOURCE_HASH_MISMATCH/);
  assert.equal(f.tables.projectHostedSyncs.size, 0);
});

test('missing green reports without source absence never blame a landing', async () => {
  const f = await fixture(2, { addedAt: 0 });
  await f.runCulprit();
  await f.inspect();
  assert.equal(JSON.parse(f.recovery().recovery).stage, 'done');
  assert.equal(f.probes().length, 0);
  assert.equal(f.tables.projectHostedSyncs.size, 0);
});

test('one of five culprits is named; bounded probes and one range page at dogfood scale', async t => {
  const f = await fixture(),
    started = performance.now(),
    before = f.counts.length;
  await f.runCulprit();
  for (;;) {
    const queued = f.probes().find(r => r.status === 'queued');
    if (!queued) break;
    await f.complete(queued, f.heads.indexOf(queued.request.expectedHead) >= 3);
  }
  const state = JSON.parse(f.recovery().recovery);
  assert.equal(state.target.id, f.receipts[572].id);
  assert.equal(state.stage, 'sync');
  assert(f.probes().length <= 1 + Math.ceil(Math.log2(6)));
  assert.equal(f.counts.slice(before).filter(c => c.touched.includes('projectHostedAcceptances')).length, 2); // range plus exact prepareHostedRevert lookup
  assert.equal([...f.tables.projectHostedSyncs.values()].length, 1);
  const intent = await f.readIntent(f.intents[572].id);
  assert.equal(intent.status, 'active');
  assert.equal(intent.needsFix.state, 'needs-fix');
  assert.match(fixBrief(intent.needsFix), /synthetic failure/);
  const capabilities = JSON.parse(
    await f.transaction('capabilities', agent.capabilities, { projectId: f.projectId, noticeVersion: 1 }),
  );
  assert.equal(capabilities.needsFix[0].intentId, intent.id);
  assert.ok(
    Number.isFinite(Date.parse(capabilities.needsFix[0].at)),
    'workspace notice retains its actual publication time',
  );
  // W19: the failing tests travel as fields, so no reader parses the summary prose (old main: absent).
  assert.deepEqual(
    capabilities.needsFix[0].tests,
    intent.needsFix.failed.slice(0, 3).map(item => item.file),
  );
  assert.equal(capabilities.needsFix[0].moreTests, undefined);
  const metrics = f.counts.slice(before);
  t.diagnostic(
    JSON.stringify({
      intents: 600,
      receipts: 575,
      files: 3000,
      probes: f.probes().length,
      classificationCalls: metrics.length,
      documentsRead: metrics.reduce((n, c) => n + c.documents, 0),
      writes: metrics.reduce((n, c) => n + c.writes, 0),
      maxReadsPerCall: Math.max(...metrics.map(c => c.documents)),
      elapsedMs: performance.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      idleCalls: 0,
    }),
  );
  for (const count of metrics.filter(c => ['classify', 'probeTerminal'].includes(c.name)))
    assert(count.ranges < 50);
});

test('seeded flake never prepares a reverse and six replays reserve exactly one run', async () => {
  const f = await fixture();
  for (let i = 0; i < 6; i++) await f.runCulprit();
  assert.equal(f.probes().length, 1);
  await f.complete(f.probes()[0], false);
  for (let i = 0; i < 6; i++) await f.runCulprit();
  assert.equal(f.probes().length, 1);
  assert.equal(f.tables.projectHostedSyncs.size, 0);
  assert.equal(f.tables.projectHostedMainAudits.get(f.auditRow).red, undefined);
  const flakeReceipt = JSON.parse(f.recovery().value).terminal.outcome.result;
  assert.match(flakeReceipt.reason, /recorded a flake/);
  assert.equal(flakeReceipt.undo, 'No source was changed; no reverse is needed.');
  assert.equal([...f.tables.projectHostedMainAuditEvents.values()].filter(r => r.kind === 'flake').length, 1);
  const shared = await fixture();
  await shared.runCulprit();
  const origin = shared.audit.id,
    current = shared.tables.projectHostedMainAudits.get(shared.auditRow);
  shared.audit = hostedCheckRunSchema.parse({
    ...shared.audit,
    id: randomUUID(),
    request: { ...shared.audit.request, operationId: randomUUID() },
  });
  shared.insert('projectHostedCheckRuns', {
    projectId: shared.projectId,
    runId: shared.audit.id,
    candidateId: shared.audit.request.candidateId,
    status: shared.audit.status,
    gate: shared.audit.gate,
    value: JSON.stringify(shared.audit),
  });
  shared.patch('projectHostedMainAudits', shared.auditRow, {
    audit: { ...current.audit, runId: shared.audit.id },
    red: { ...current.red, runId: shared.audit.id },
  });
  await shared.runCulprit();
  assert.equal(shared.probes().length, 1);
  await shared.complete(shared.probes()[0], false);
  assert.equal(shared.tables.projectHostedMainAudits.get(shared.auditRow).red, undefined);
  assert.equal(shared.probes().length, 1);
  const states = [...shared.tables.projectHostedOperations.values()]
    .filter(row => row.recovery)
    .map(row => JSON.parse(row.recovery));
  assert.deepEqual(new Set(states.map(state => state.audit.id)), new Set([origin]));
  assert(states.every(state => state.stage === 'done'));
  assert.equal(shared.tables.projectHostedSyncs.size, 0);
});

test('acceptance.autoRevert:false runs the flake guard, names no culprit and opens Fix main without bisecting', async () => {
  const f = await fixture();
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...effectivePolicy(f.tables.hostedProjects.get(f.projectId)),
      acceptance: { mode: 'auto-on-pass', gate: 'contract', protectedPaths: [], autoRevert: false },
    },
  });
  await f.runCulprit();
  assert.equal(f.probes().length, 1, 'only the flake guard probe is spent');
  await f.complete(f.probes()[0], true);
  assert.equal(f.probes().length, 1, 'no bisect probes after a reproduced failure');
  const state = JSON.parse(f.recovery().recovery);
  assert.equal(state.stage, 'done');
  assert.match(state.reason, /Automatic revert is off/);
  assert.equal(f.tables.projectHostedSyncs.size, 0);
  assert.equal(f.tables.projectHostedLandingRequests.size, 0);
  const fix = culprit.needsFix(f.tables.hostedProjects.get(f.projectId));
  assert.equal(fix.length, 1);
  assert.equal(fix[0].state, 'needs-fix');
  assert.match((await f.readIntent(fix[0].intentId)).needsFix.summary, /Automatic revert is off/);
});

test('acceptance.autoRevert:false still records a flake: the failed tests pass on the audited head', async () => {
  const f = await fixture();
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...effectivePolicy(f.tables.hostedProjects.get(f.projectId)),
      acceptance: { mode: 'auto-on-pass', gate: 'contract', protectedPaths: [], autoRevert: false },
    },
  });
  await f.runCulprit();
  await f.complete(f.probes()[0], false);
  assert.equal(f.tables.projectHostedMainAudits.get(f.auditRow).red, undefined);
  assert.equal(culprit.needsFix(f.tables.hostedProjects.get(f.projectId)).length, 0);
  assert.match(JSON.parse(f.recovery().value).terminal.outcome.result.reason, /recorded a flake/);
});

test('mixed or absent probe evidence creates one fix-forward and persistent notices', async () => {
  const f = await fixture();
  await f.runCulprit();
  const run = f.probes()[0],
    terminal = { ...run, status: 'failed', endedAt: at, terminalDigest: hash, contractReports: {} };
  await f.transaction('unclear', { _handler: ctx => culprit.onCulpritRunTerminal(ctx, terminal) }, {});
  await f.runCulprit();
  const state = JSON.parse(f.recovery().recovery);
  assert.equal(state.stage, 'done');
  assert.equal(f.tables.projectHostedSyncs.size, 0);
  assert.equal((await f.readIntent(state.intentId)).needsFix.state, 'needs-fix');
  assert.equal(culprit.needsFix(f.tables.hostedProjects.get(f.projectId)).length, 1);
});

test('start reverted Intent opens sibling from saved head and includes full fix brief; owner close clears notice', async () => {
  const f = await fixture(1);
  await f.runCulprit();
  await f.complete(f.probes()[0], true);
  const original = await f.readIntent(f.intents[574].id);
  const n = { ...original.needsFix, state: 'reverted', revertReceiptId: randomUUID() };
  await f.transaction(
    'markReverted',
    {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: f.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: original.version,
          record: { ...original, version: original.version + 1, needsFix: n },
        }),
    },
    {},
  );
  const main = JSON.parse([...f.tables.projectHostedChannels.values()][0].selection);
  const request = {
    projectId: f.projectId,
    operationId: randomUUID(),
    noticeVersion: 1,
    authorityEpoch: 1,
    expectedMain: { head: main.head, receiptId: main.receipt.id },
    intent: { kind: 'existing', intentId: original.id },
  };
  const started = JSON.parse(await f.transaction('start', start.start, request));
  assert.equal(started.lane.head, n.head);
  assert.match(started.fixBrief, /synthetic failure/);
  assert.deepEqual(culprit.fixGate(await f.readIntent(original.id)), {
    mode: 'full',
    reason: 'reverted Intent fix',
  });
  assert.equal(
    JSON.parse(await f.transaction('replayStart', start.start, request)).lane.laneId,
    started.lane.laneId,
  );
  const explicit = JSON.parse(
    await f.transaction('explicitRecoverySource', start.start, {
      ...request,
      operationId: randomUUID(),
      initialHead: f.heads[0],
    }),
  );
  assert.equal(explicit.lane.head, f.heads[0]);
  const current = await f.readIntent(original.id);
  await f.transaction(
    'close',
    {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: f.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: current.version,
          record: { ...current, version: current.version + 1, status: 'abandoned' },
        }),
    },
    {},
  );
  assert.equal(culprit.needsFix(f.tables.hostedProjects.get(f.projectId)).length, 0);
  const closed = await f.readIntent(original.id),
    nextAudit = randomUUID();
  const reopened = {
    ...closed,
    version: closed.version + 1,
    status: 'active',
    needsFix: { ...n, auditRunId: nextAudit },
  };
  await f.transaction(
    'newFailure',
    {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: f.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: closed.version,
          record: reopened,
        }),
    },
    {},
  );
  f.patch('hostedProjects', f.projectId, {
    needsFix: {
      [original.id]: JSON.stringify({
        state: 'needs-fix',
        auditRunId: nextAudit,
        summary: 'Newer failure',
        undo: 'reopen the Intent',
      }),
    },
  });
  await f.transaction(
    'replayOldClose',
    {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: f.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: current.version,
          record: { ...current, version: current.version + 1, status: 'abandoned' },
        }),
    },
    {},
  );
  assert.equal(culprit.needsFix(f.tables.hostedProjects.get(f.projectId))[0].auditRunId, nextAudit);
  assert.equal((await f.readIntent(original.id)).needsFix.auditRunId, nextAudit);
});

test('reports cap UTF-8 excerpts at 32 by 2048 bytes; incomplete/mixed evidence never proves a culprit', async () => {
  const f = await fixture(1);
  const reports = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      `tests/test-${i}.test.mjs`,
      { failed: true, firstError: '😀'.repeat(512) },
    ]),
  );
  const failed = culpritFailures({ ...f.audit, contractReports: reports });
  assert.equal(failed.length, 1000);
  assert.equal(failed.filter(f => f.excerpt).length, 32);
  assert.equal(
    failed.reduce((n, f) => n + Buffer.byteLength(f.excerpt ?? ''), 0),
    65536,
  );
  assert.equal(
    probeVerdict(
      {
        ...f.audit,
        contractReports: { 'tests/a.test.mjs': { failed: false }, 'tests/b.test.mjs': { failed: true } },
      },
      ['tests/a.test.mjs', 'tests/b.test.mjs'],
    ),
    'unclear',
  );
  for (let k = 1; k <= 100; k++) assert(culpritProbeBudget(k) <= 1 + Math.ceil(Math.log2(k + 1)));
  assert.equal(culpritId({ head: hash, tests: ['x'] }), culpritId({ tests: ['x'], head: hash }));
  assert.equal(culprit.fixGate(null), undefined);
  assert.equal(hostedRecordSchema.options[0].safeParse(f.intents[0]).success, true);
});

test('restoring original change plus fix preserves work accepted after the culprit', async () => {
  const { composeFixture } = await import('./hosted-compose-fixture.mjs');
  const s = await composeFixture();
  const original = s.file('original.txt', 'original'),
    later = s.file('later.txt', 'later'),
    fix = s.file('fix.txt', 'fixed');
  const accepted = s.state([s.baseFile, s.hidden, original], [s.baseline.sha256]);
  const newer = s.state([s.baseFile, s.hidden, original, later], [accepted.sha256]);
  const reverted = s.state([s.baseFile, s.hidden, later], [newer.sha256]);
  const fixed = s.state([s.baseFile, s.hidden, original, fix], [accepted.sha256]);
  const lane = await s.lane(fixed, { restoreBase: s.baseline.sha256 });
  for (const table of ['projectHostedRecords', 'projectHostedRecordHeads'])
    for (const row of s.tables[table].values())
      if (row.kind === 'lane' && row.key === lane.laneId) s.patch(table, row._id, { ownerOnly: true });
  s.register(reverted);
  s.moveMain(reverted.sha256, 'revert-receipt');
  const selected = s.selection([lane], [], {
    expectedMain: { head: reverted.sha256, receiptId: 'revert-receipt' },
  });
  await s.prepare(selected);
  await s.stage(selected);
  await s.submit(selected);
  const result = await s.work(selected);
  const candidate = (await s.publish(result)).outcome.result;
  assert.equal(candidate.result.status, 'clean');
  const tree = JSON.parse(s.objects.get(candidate.result.head));
  assert.deepEqual(
    tree.files.map(f => f.path),
    ['a.txt', 'fix.txt', 'hidden.bin', 'later.txt', 'original.txt'],
  );
  const plan = (await s.progress(selected)).input;
  assert.equal(plan.restoreBases[lane.laneId].object.sha256, s.baseline.sha256);
  const header = [...s.tables.projectHostedRecords.values()].find(r => r.key === candidate.id);
  assert.deepEqual(JSON.parse(header.restoreBases), plan.restoreBases);
  const checkFixture = await checksFixture({
    store: s,
    projectId: s.projectId,
    state: { sha256: candidate.result.head, size: s.objects.get(candidate.result.head).length },
    candidate,
  });
  const landing = await import(moduleUrl('../convex/projectHostedLanding.ts'));
  const enqueue = {
    exportArgs: landing.enqueue.exportArgs,
    _handler: (ctx, args) => {
      ctx.scheduler.cancel = async () => {};
      return landing.enqueue._handler(ctx, args);
    },
  };
  s.decorateContext(ctx => {
    ctx.db.system = { get: async () => null };
  });
  const previousKeyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
  let reviewed;
  try {
    const { policyPreset } = await import('../dist/autonomy-policy.js');
    const { batchEligible } = await import('../dist/hosted-landing-batch.js');
    // Server preflight gate (Issue 029138ef) has its own tests (hosted-landing-desired.test.mjs).
    const policy = { ...policyPreset('trusted'), agentDefaults: { preflight: 'advise' } };
    s.patch('hostedProjects', s.projectId, { autonomyPolicy: policy });
    assert(batchEligible({ owner: 'owner' }, policy, { kind: 'agent', id: 'owner' }, candidate));
    const fixed = JSON.parse(
      await s.call('agentRecoveryFinish', enqueue, {
        projectId: s.projectId,
        request: JSON.stringify({
          operationId: randomUUID(),
          authorityEpoch: 1,
          channel: 'main',
          expectedMain: selected.request.expectedMain,
          candidateId: candidate.id,
          expectedHead: candidate.result.head,
          agent: true,
          check: {
            kind: 'request',
            checkId: checkFixture.checkId,
            expectedDefinition: checkFixture.definition.digest,
            expectedConfiguration: checkFixture.configuration.digest,
            expectedEnvironment: checkFixture.runner.environmentFingerprint,
          },
          finish: { composeOperationId: selected.request.operationId, after: null },
        }),
      }),
    );
    const attempt = JSON.parse(
      [...s.tables.projectHostedLandingAttempts.values()].find(row => row.attemptId === fixed.attemptId)
        .value,
    );
    assert.equal(attempt.deferredCheck, undefined, 'fix Lanes reserve an exact full check before batching');
    const request = [...s.tables.projectHostedLandingRequests.values()].find(
      row => row.submissionId === fixed.id,
    );
    assert.notEqual(request.batchable, true);
    reviewed = JSON.parse(
      await s.call('reviewedRecoveryFinish', enqueue, {
        projectId: s.projectId,
        request: JSON.stringify({
          operationId: randomUUID(),
          authorityEpoch: 1,
          channel: 'main',
          expectedMain: selected.request.expectedMain,
          candidateId: candidate.id,
          expectedHead: candidate.result.head,
          agent: false,
          check: {
            kind: 'request',
            checkId: checkFixture.checkId,
            expectedDefinition: checkFixture.definition.digest,
            expectedConfiguration: checkFixture.configuration.digest,
            expectedEnvironment: checkFixture.runner.environmentFingerprint,
          },
          finish: { reviewedSource: selected.request, after: null },
        }),
      }),
    );
  } finally {
    if (previousKeyId === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
    else process.env.FORGE_HOSTED_CHECK_KEY_ID = previousKeyId;
  }
  const reviewedFinish = [...s.tables.projectHostedFinishes.values()].find(
    r => r.submissionId === reviewed.id,
  );
  assert.deepEqual(JSON.parse(reviewedFinish.value).restoreBases, plan.restoreBases);
  const fixRun = [...s.tables.projectHostedCheckRuns.values()].map(r => JSON.parse(r.value)).at(-1);
  assert.equal(fixRun.request.gate.mode, 'full');
});

test('accepted reverse writes reverted notice with undo receipt; re-landing clears it', async () => {
  const f = await fixture(1);
  await f.runCulprit();
  await f.complete(f.probes()[0], true);
  const recoveryRow = f.recovery(),
    state = JSON.parse(recoveryRow.recovery);
  state.stage = 'landing';
  state.landingOperationId = randomUUID();
  f.patch('projectHostedOperations', recoveryRow._id, { recovery: JSON.stringify(state) });
  const reverseCandidate = {
    kind: 'candidate',
    id: randomUUID(),
    version: 0,
    at,
    intentId: state.intentId,
    base: { head: f.heads[1], receiptId: f.receipts.at(-1).id },
    inputs: f.audit.candidate.inputs,
    dependencies: f.audit.candidate.dependencies,
    algorithm: 'native@fixture',
    result: { status: 'clean', head: f.heads[0] },
  };
  seedRecord(f, reverseCandidate);
  const reversed = hostedAcceptanceSchema.parse({
    ...state.target,
    id: randomUUID(),
    candidate: { ...state.target.candidate, id: reverseCandidate.id, head: f.heads[0] },
    snapshot: { ...state.target.snapshot, revision: 580 },
  });
  f.patch('projectHostedMainAudits', f.auditRow, { red: undefined });
  await f.transaction('replayedSourceAfterPublication', culprit.advance, {
    projectId: f.projectId,
    runId: f.recoveryId(),
  });
  assert.equal(JSON.parse(f.recovery().recovery).stage, 'landing');
  await f.transaction('acceptedReverse', { _handler: ctx => culprit.onRecoveryAccepted(ctx, reversed) }, {});
  const original = await f.readIntent(f.intents[574].id);
  assert.equal(original.needsFix.state, 'reverted');
  assert.equal(original.needsFix.revertReceiptId, reversed.id);
  assert.equal(original.needsFix.sequence, 580);
  assert.match(original.needsFix.undo, new RegExp(reversed.id));
  const { hostedAgentCommandSchemas } = await import('../dist/hosted-agent-contract.js');
  assert.equal(
    hostedAgentCommandSchemas.revert.parse(JSON.parse(original.needsFix.undo.match(/'(.+)'$/)[1])).target
      .receiptId,
    reversed.id,
  );
  assert.equal(original.status, 'active');
  await f.transaction('replayedReceipt', { _handler: ctx => culprit.onRecoveryAccepted(ctx, reversed) }, {});
  assert.equal((await f.readIntent(original.id)).version, original.version);
  await f.transaction('oldReceipt', { _handler: ctx => culprit.onRecoveryAccepted(ctx, state.target) }, {});
  assert.equal((await f.readIntent(original.id)).needsFix.state, 'reverted');
  const olderLanding = {
    ...state.target,
    id: randomUUID(),
    snapshot: { ...state.target.snapshot, revision: 576 },
  };
  await f.transaction(
    'oldLaterReceipt',
    { _handler: ctx => culprit.onRecoveryAccepted(ctx, olderLanding) },
    {},
  );
  assert.equal((await f.readIntent(original.id)).needsFix.state, 'reverted');
  const relanded = {
    ...state.target,
    id: randomUUID(),
    snapshot: { ...state.target.snapshot, revision: 581 },
  };
  await f.transaction('fixed', { _handler: ctx => culprit.onRecoveryAccepted(ctx, relanded) }, {});
  assert.equal((await f.readIntent(original.id)).needsFix, undefined);
  assert.equal(culprit.needsFix(f.tables.hostedProjects.get(f.projectId)).length, 0);
});

/** A culprit that landed on its first check (Issue 7fe54c7c) carries this receipt shape. */
function firstCheckCulprit(f) {
  const row = [...f.tables.projectHostedAcceptances.values()].find(r => r.sequence === 575);
  const receipt = JSON.parse(row.value);
  const proof = {
    algorithm: 'clean-disjoint-v1',
    checked: { id: randomUUID(), head: 'b'.repeat(64), digest: hash },
    checkedBase: { head: 'c'.repeat(64), receiptId: 'older' },
    main: receipt.previous,
    head: receipt.candidate.head,
    runId: randomUUID(),
    terminalDigest: hash,
    planDigest: hash,
    candidatePaths: ['src/file-1.ts'],
    mainPaths: ['src/file-2.ts'],
    checkedSelection: hash,
    cleanComposition: true,
    audit: {
      source: 'audit',
      head: f.heads[0],
      runId: randomUUID(),
      terminalDigest: hash,
      planDigest: hash,
      selection: hash,
      sequence: 574,
      coverage: 'main-audit-debt',
    },
    riskRule: 'first-check-risk-v1',
    checkEntries: ['scripts/forge-check.mjs'],
    checkedScope: 'full',
  };
  const next = hostedAcceptanceSchema.parse({
    ...receipt,
    crossHeadProof: proof,
    firstCheck: { landedOn: 'admission-run', mainMoved: true },
  });
  f.patch('projectHostedAcceptances', row._id, { value: JSON.stringify(next) });
  f.receipts[574] = next;
  return next;
}
for (const [firstCheck, conflict, held] of [
  [false, false, undefined],
  [true, false, undefined],
  [true, true, undefined],
  [false, false, 'protected'],
  [false, false, 'unknown'],
])
  test(`system reverse advances from retained source results to one full-gated check and landing${firstCheck ? ' (culprit landed on its first check)' : ''}${conflict ? ': a reverse that conflicts with later work reverts nothing and opens fix-forward' : ''}${held ? `: a ${held}-path reverse is prepared as a Candidate and never auto-landed` : ''}`, t =>
    replaySystemReverse(t, { firstCheck, conflict, held }));

test('incident 27865bc4: a new failing test and later failed audits recover in one automatic reverse', t =>
  replaySystemReverse(t, { drill: true }));

async function replaySystemReverse(t, { firstCheck = false, conflict = false, held, drill = false } = {}) {
  if (drill) t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  const replayStarted = performance.now();
  const operations = await import(moduleUrl('../convex/projectHostedOperations.ts'));
  const f = await fixture(1, { addedAt: drill ? 1 : null });
  const culpritReceipt = firstCheck ? firstCheckCulprit(f) : f.receipts[574];
  const receiptsBefore = [...f.tables.projectHostedAcceptances.values()].map(r => r.value);
  const mainBefore = [...f.tables.projectHostedChannels.values()][0].selection;
  await f.runCulprit();
  if (drill) {
    await f.inspect();
    t.mock.timers.tick(120000);
    await laterAudit(f, 2);
    assert.equal(f.probes().length, 1);
  }
  await f.complete(f.probes()[0], true);
  let row = f.recovery(),
    recovery = JSON.parse(row.recovery);
  const syncRow = [...f.tables.projectHostedSyncs.values()][0],
    sync = JSON.parse(syncRow.value);
  const reverseLane = {
    kind: 'lane',
    id: sync.resolutionLaneId,
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    at,
    intentId: sync.intentId,
    actor: 'owner',
    base: sync.base,
    head: f.heads[0],
    state: 'active',
    authorityEpoch: 1,
    revert: { receiptId: recovery.target.id, previous: f.heads[0], accepted: f.heads[1] },
  };
  seedRecord(f, reverseLane);
  const completeOperation = async (id, result) => {
    const opRow = [...f.tables.projectHostedOperations.values()].find(r => r.operationId === id),
      op = JSON.parse(opRow.value);
    await f.transaction(
      'sourceResult',
      {
        _handler: ctx =>
          operations.finishHostedOperation(ctx, {
            projectId: f.projectId,
            actor: 'owner',
            operationId: id,
            receipt: { attemptId: op.firstAttempt.id, at, outcome: { status: 'completed', result } },
          }),
      },
      {},
    );
  };
  // Model terminal source publications; the separate worker test verifies source bytes.
  await completeOperation(sync.request.operationId, { lane: { laneId: reverseLane.id }, status: 'merged' });
  f.patch('projectHostedSyncs', syncRow._id, { value: JSON.stringify({ ...sync, status: 'completed' }) });
  delete recovery.uploads;
  f.patch('projectHostedOperations', row._id, { recovery: JSON.stringify(recovery) });
  await f.transaction('advance', culprit.advance, { projectId: f.projectId, runId: f.recoveryId() });
  recovery = JSON.parse(f.recovery().recovery);
  assert.equal(recovery.stage, 'compose');
  const transfer = JSON.parse(
    await f.transaction('transfer', culprit.transfer, { projectId: f.projectId, runId: f.recoveryId() }),
  );
  assert.equal(transfer.uploads.length, 3);
  assert.deepEqual(
    JSON.parse(
      await f.transaction('staleTransfer', culprit.transfer, {
        projectId: f.projectId,
        runId: f.recoveryId(),
        committed: true,
        token: 'stale',
      }),
    ),
    {},
  );
  assert.equal(JSON.parse(f.recovery().recovery).uploads.length, 3);
  const composeRow = [...f.tables.projectHostedComposes.values()][0],
    compose = JSON.parse(composeRow.value);
  const candidate = {
    kind: 'candidate',
    id: compose.candidateId,
    version: 0,
    at,
    intentId: compose.request.intentId,
    base: compose.request.expectedMain,
    inputs: compose.request.inputs.root,
    dependencies: compose.request.dependencies.root,
    algorithm: 'native@fixture',
    // A real clean compose retains the changed paths the reverse touches.
    ...(conflict || held === 'unknown'
      ? {}
      : { governance: { version: 1, paths: ['src/file-1.ts'], ownerInputs: true } }),
    result: conflict
      ? { status: 'conflict', conflicts: compose.request.inputs.root }
      : { status: 'clean', head: f.heads[0] },
  };
  seedRecord(f, candidate);
  f.insert('projectHostedStates', {
    projectId: f.projectId,
    head: f.heads[0],
    size: [...f.tables.projectObjects.values()].find(r => r.digest === f.heads[0]).size,
    input: hash,
    jobId: randomUUID(),
    output: hash,
  });
  await completeOperation(compose.request.operationId, candidate);
  f.patch('projectHostedComposes', composeRow._id, {
    value: JSON.stringify({ ...compose, status: 'completed' }),
  });
  delete recovery.uploads;
  f.patch('projectHostedOperations', f.recovery()._id, { recovery: JSON.stringify(recovery) });
  // pinLandingAttempt revalidates stored input roots, which the simulated worker uploaded.
  for (const upload of transfer.uploads) {
    f.put(upload.value);
    const object = [...f.tables.projectObjects.values()].find(r => r.digest === upload.pin.sha256);
    f.patch('projectObjects', object._id, { r2Committed: true });
  }
  f.decorateContext(ctx => {
    ctx.scheduler = {
      runAfter: async (_, ref, args) => {
        f.scheduled.push({ name: getFunctionName(ref), args });
        return ctx.db.insert('_scheduled_functions', {
          name: getFunctionName(ref),
          args,
          state: { kind: 'pending' },
        });
      },
      cancel: async () => {},
    };
    ctx.db.system = { get: async () => ({ state: { kind: 'pending' } }) };
  });
  if (held)
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...effectivePolicy(f.tables.hostedProjects.get(f.projectId)),
        acceptance: { mode: 'auto-on-pass', gate: 'contract', protectedPaths: ['src/file-1.ts'] },
      },
    });
  await f.transaction('advanceFull', culprit.advance, { projectId: f.projectId, runId: f.recoveryId() });
  if (held) {
    // Never auto-landed: no check, no landing, main and receipts untouched; the prepared
    // Candidate waits for a person and the culprit's Intent says so (Needs you).
    const state = JSON.parse(f.recovery().recovery);
    assert.equal(state.stage, 'done');
    assert.equal(state.held.candidateId, compose.candidateId);
    assert.match(
      state.held.reason,
      held === 'protected' ? /protected paths: src\/file-1\.ts/ : /coverage is unavailable/,
    );
    assert.equal(f.tables.projectHostedLandingRequests.size, 0);
    assert.equal(
      [...f.tables.projectHostedCheckRuns.values()].filter(r =>
        JSON.parse(r.value).gate?.reason?.startsWith('culprit-revert:'),
      ).length,
      0,
    );
    assert.deepEqual(
      [...f.tables.projectHostedAcceptances.values()].map(r => r.value),
      receiptsBefore,
    );
    assert.equal([...f.tables.projectHostedChannels.values()][0].selection, mainBefore);
    const intent = await f.readIntent(f.intents[574].id);
    assert.equal(intent.status, 'active', 'the culprit Intent is reopened and its work kept');
    assert.equal(intent.needsFix.state, 'needs-fix');
    assert.match(intent.needsFix.summary, new RegExp(`Candidate ${compose.candidateId} but not landed`));
    assert.equal(culprit.needsFix(f.tables.hostedProjects.get(f.projectId)).length, 1);
    // A retried continuation changes nothing and sends no second notice.
    const before = JSON.stringify([...f.tables.projectHostedRecordHeads.values()]);
    await f.transaction('replayHeld', culprit.advance, { projectId: f.projectId, runId: f.recoveryId() });
    assert.equal(JSON.stringify([...f.tables.projectHostedRecordHeads.values()]), before);
    assert.equal(f.tables.projectHostedLandingRequests.size, 0);
    // The person accepts the held Candidate: the notice becomes "reverted" with an undo receipt.
    const accepted = {
      ...state.target,
      id: randomUUID(),
      candidate: { ...state.target.candidate, id: compose.candidateId },
      snapshot: { ...state.target.snapshot, revision: 581 },
    };
    await f.transaction('personAccepted', { _handler: ctx => culprit.onRecoveryAccepted(ctx, accepted) }, {});
    const reverted = (await f.readIntent(f.intents[574].id)).needsFix;
    assert.equal(reverted.state, 'reverted');
    assert.equal(reverted.revertReceiptId, accepted.id);
    assert.equal(JSON.parse(f.recovery().recovery).held, undefined);
    return;
  }
  if (conflict) {
    // No blind revert: nothing is queued, main and every receipt stay as they
    // are, and the culprit's Intent carries one fix-forward notice.
    assert.equal(JSON.parse(f.recovery().recovery).stage, 'done');
    assert.equal(f.tables.projectHostedLandingRequests.size, 0);
    assert.equal(
      [...f.tables.projectHostedCheckRuns.values()].filter(r =>
        JSON.parse(r.value).gate?.reason?.startsWith('culprit-revert:'),
      ).length,
      0,
    );
    assert.deepEqual(
      [...f.tables.projectHostedAcceptances.values()].map(r => r.value),
      receiptsBefore,
    );
    assert.equal([...f.tables.projectHostedChannels.values()][0].selection, mainBefore);
    assert.equal((await f.readIntent(f.intents[574].id)).needsFix.state, 'needs-fix');
    // One new fix-forward Intent; the culprit's own notice points to it.
    const notices = culprit.needsFix(f.tables.hostedProjects.get(f.projectId));
    const fix = notices.find(n => n.intentId !== f.intents[574].id);
    assert.equal(notices.length, 2);
    assert(notices.every(n => n.state === 'needs-fix' && n.receiptId === culpritReceipt.id));
    assert(notices.every(n => n.undo === `nforge agent ROOT start '{"intentId":"${fix.intentId}"}'`));
    return;
  }
  const full = [...f.tables.projectHostedCheckRuns.values()]
    .map(r => JSON.parse(r.value))
    .filter(r => r.gate?.reason?.startsWith('culprit-revert:'));
  assert.equal(full.length, 1);
  assert.equal(full[0].request.gate.mode, 'full');
  assert.equal([...f.tables.projectHostedLandingRequests.values()].length, 1);
  // The reverse is an ordinary queued landing on top of current main: nothing is
  // rewound, no accepted receipt changes, and its receipt message names how to
  // bring the culprit back (owner 2026-11-06: no lost code).
  const reverse = JSON.parse([...f.tables.projectHostedLandingRequests.values()][0].value);
  assert.equal(reverse.request.revertOf, culpritReceipt.id);
  assert.equal(reverse.request.expectedMain.head, f.heads[1], 'composed on current main');
  assert.match(
    reverse.request.message,
    new RegExp(`Re-land after fixing: nforge agent ROOT start '\\{"intentId":"${f.intents[574].id}"\\}'`),
  );
  assert.match(reverse.request.message, /Undo: revert this receipt\.$/);
  assert.deepEqual(
    [...f.tables.projectHostedAcceptances.values()].map(r => r.value),
    receiptsBefore,
  );
  assert.equal([...f.tables.projectHostedChannels.values()][0].selection, mainBefore);
  assert.equal((await f.readIntent(f.intents[574].id)).status, 'active', 'the culprit work stays open');
  await f.transaction('replayFull', culprit.advance, { projectId: f.projectId, runId: f.recoveryId() });
  assert.equal(
    [...f.tables.projectHostedCheckRuns.values()]
      .map(r => JSON.parse(r.value))
      .filter(r => r.gate?.reason?.startsWith('culprit-revert:')).length,
    1,
  );
  const finishRow = [...f.tables.projectHostedFinishes.values()][0];
  assert.equal(JSON.parse(finishRow.value).recoveryRunId, f.recoveryId());
  if (drill) {
    t.mock.timers.tick(120000);
    await laterAudit(f, 4, { 'tests/other.test.mjs': { failed: true } });
    const finishControl = await import(moduleUrl('../convex/projectHostedFinishControl.ts'));
    await f.transaction(
      'sameEpisodeFinish',
      {
        _handler: ctx =>
          finishControl.finishStep(ctx, {
            projectId: f.projectId,
            submissionId: finishRow.submissionId,
            wakeId: finishRow.wake.id,
          }),
      },
      {},
    );
    assert.notEqual(
      JSON.parse([...f.tables.projectHostedLandingRequests.values()][0].value).phase,
      'terminal-failed',
    );
    assert.equal([...f.tables.projectHostedOperations.values()].filter(row => row.recovery).length, 1);
    assert(JSON.parse(f.recovery().recovery).evidence.some(f => f.file === 'tests/other.test.mjs'));
    const checked = await f.activate(full[0].id, 1);
    await f.pass(checked);
    const landingControl = await import(moduleUrl('../convex/projectHostedLandingControl.ts'));
    // Exercise the real queue and acceptance control; external source/check execution stays synthetic.
    const queue = [...f.tables.projectHostedLandingQueues.values()][0];
    await f.transaction(
      'readyDrillReverse',
      {
        _handler: async ctx => {
          const claim = await landingControl.claimLandingQueue(ctx, {
            projectId: f.projectId,
            channel: 'main',
            wakeId: queue.wake.id,
          });
          if (claim && !('waitingFor' in claim)) await landingControl.advanceLandingQueue(ctx, claim);
        },
      },
      {},
    );
    for (const upload of transfer.uploads) f.put(upload.value);
    t.mock.timers.tick(240000);
    for (let step = 0; step < 10; step++) {
      const latest = f.tables.projectHostedFinishes.get(finishRow._id);
      if (!latest.wake) break;
      const input = { projectId: f.projectId, submissionId: latest.submissionId, wakeId: latest.wake.id };
      const command = await f.transaction(
        'publishDrillReverse',
        { _handler: ctx => finishControl.finishStep(ctx, input) },
        {},
      );
      if (command?.kind === 'page') {
        const page = JSON.parse(f.objectBytes.get(command.pin.sha256));
        const next = f.tables.projectHostedFinishes.get(finishRow._id);
        await f.transaction(
          'stageDrillReverse',
          {
            _handler: ctx =>
              finishControl.resumeFinishIO(ctx, { ...input, wakeId: next.wake.id, command, page }),
          },
          {},
        );
      }
    }
    const accepted = [...f.tables.projectHostedAcceptances.values()].find(r => r.sequence === 576);
    assert(
      accepted,
      JSON.stringify([...f.tables.projectHostedLandingRequests.values()].map(r => JSON.parse(r.value))),
    );
    const receipt = JSON.parse(accepted.value);
    await f.transaction(
      'acceptedDrillReverse',
      { _handler: ctx => culprit.onRecoveryAccepted(ctx, receipt) },
      {},
    );
    const recoveredAt = receipt.at;
    const recovered = JSON.parse(f.recovery().recovery);
    assert.equal(recovered.stage, 'done');
    assert.equal((await f.readIntent(f.intents[574].id)).needsFix.state, 'reverted');
    assert.equal(recovered.addition, 1);
    const replayMinutes = (Date.parse(recoveredAt) - Date.parse(recovered.episode)) / 60000;
    assert(replayMinutes <= 15, 'drill recovery fits the simulated 15 minute budget');
    assert.equal(f.tables.projectHostedSyncs.size, 1);
    assert.equal(JSON.parse([...f.tables.projectHostedChannels.values()][0].selection).head, f.heads[0]);
    t.diagnostic(
      JSON.stringify({
        replayMinutes,
        elapsedMs: performance.now() - replayStarted,
        manualFixes: 0,
        recoveryOperations: 1,
      }),
    );
    return;
  }
  f.patch('projectHostedMainAudits', f.auditRow, { red: undefined });
  const finishControl = await import(moduleUrl('../convex/projectHostedFinishControl.ts'));
  await f.transaction(
    'cancelStaleReverse',
    {
      _handler: ctx =>
        finishControl.finishStep(ctx, {
          projectId: f.projectId,
          submissionId: finishRow.submissionId,
          wakeId: finishRow.wake.id,
        }),
    },
    {},
  );
  const failed = JSON.parse([...f.tables.projectHostedLandingRequests.values()][0].value);
  assert.equal(failed.phase, 'terminal-failed');
  assert.equal(failed.error.code, 'RECOVERY_SUPERSEDED');
  await f.transaction(
    'lateReverseCheck',
    {
      _handler: ctx =>
        culprit.onCulpritRunTerminal(ctx, {
          ...full[0],
          status: 'failed',
          endedAt: at,
          terminalDigest: hash,
        }),
    },
    {},
  );
  assert.equal(JSON.parse(f.recovery().recovery).stage, 'done');
  assert.equal([...f.tables.projectHostedRecordHeads.values()].filter(r => r.kind === 'intent').length, 601);
}

test('hosted CLI/MCP status carries notices in its existing discovery read without a follow-up call', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const f = agentFixture(t);
  const notice = {
    intentId: randomUUID(),
    state: 'reverted',
    summary: 'Synthetic reverted work',
    undo: 'reopen the Intent',
  };
  f.caps.needsFix = [notice];
  const before = f.calls.length;
  const status = await f.transport().dispatch('status', {});
  assert.deepEqual(status.result.needsFix, [notice]);
  assert.equal(f.calls.length - before, 1);
  assert.equal(f.calls.at(-1).name, 'projectHostedAgent:capabilities');
  const laneStatus = await f.transport().dispatch('status', { laneId: f.lane.laneId });
  assert.deepEqual(laneStatus.result.needsFix, [notice]);
});

test('every single culprit position stays within the logarithmic probe budget', async t => {
  const measurements = [];
  for (let boundary = 1; boundary <= 5; boundary++) {
    const f = await fixture(5);
    await f.runCulprit();
    for (;;) {
      const queued = f.probes().find(r => r.status === 'queued');
      if (!queued) break;
      await f.complete(queued, f.heads.indexOf(queued.request.expectedHead) >= boundary);
    }
    const recovery = JSON.parse(f.recovery().recovery);
    assert.equal(recovery.target.id, f.receipts[569 + boundary].id);
    assert(f.probes().length <= culpritProbeBudget(5));
    measurements.push({ boundary, probes: f.probes().length });
  }
  t.diagnostic(JSON.stringify({ boundaries: measurements }));
});

test('static/missing failures and incomparable predecessor evidence use fix-forward without probes', async () => {
  for (const kind of ['static', 'environment', 'configuration', 'missing-range']) {
    const f = await fixture(1);
    const runRow = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === f.audit.id);
    if (kind === 'missing-range') f.tables.projectHostedAcceptances.clear();
    else if (kind === 'static')
      f.patch('projectHostedCheckRuns', runRow._id, {
        value: JSON.stringify({ ...f.audit, contractReports: {} }),
      });
    else {
      const audit = f.tables.projectHostedMainAudits.get(f.auditRow),
        row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === audit.lastGreen.runId),
        green = JSON.parse(row.value);
      f.patch('projectHostedCheckRuns', row._id, {
        value: JSON.stringify({
          ...green,
          request: {
            ...green.request,
            ...(kind === 'configuration'
              ? { expectedConfiguration: 'e'.repeat(64) }
              : { expectedEnvironment: 'e'.repeat(64) }),
          },
        }),
      });
    }
    await f.runCulprit();
    assert.equal(f.probes().length, 0);
    assert.equal(f.tables.projectHostedSyncs.size, 0);
    const recovery = JSON.parse(f.recovery().recovery);
    assert.equal(recovery.stage, 'done');
    const intent = await f.readIntent(recovery.intentId);
    assert.equal(intent.needsFix.state, 'needs-fix');
    assert.equal(culprit.needsFix(f.tables.hostedProjects.get(f.projectId)).length, 1);
    if (kind === 'missing-range') {
      assert.equal(intent.needsFix.receiptId, undefined);
      assert.equal(intent.needsFix.head, f.audit.request.expectedHead);
      assert.match(culprit.fixBrief(intent.needsFix), /No complete acceptance receipt retained/);
    }
  }
});

test('old clients keep strict capability/start shapes while new clients opt into notice data', async () => {
  const { hostedAgentCapabilitiesSchema } = await import('../dist/hosted-agent-contract.js');
  const { hostedStartResultSchema } = await import('../dist/hosted-lane.js');
  const f = await fixture(1);
  const emptyNotices = JSON.parse(
    await f.transaction('noticeAwareNoPendingFix', agent.capabilities, {
      projectId: f.projectId,
      noticeVersion: 1,
    }),
  );
  assert.deepEqual(emptyNotices.needsFix, []);
  await f.runCulprit();
  await f.complete(f.probes()[0], true);
  const legacyCapabilities = JSON.parse(
    await f.transaction('legacyCapabilities', agent.capabilities, { projectId: f.projectId }),
  );
  assert.equal(Object.hasOwn(legacyCapabilities, 'needsFix'), false);
  assert(
    hostedAgentCapabilitiesSchema.omit({ needsFix: true }).strict().safeParse(legacyCapabilities).success,
  );
  const main = JSON.parse([...f.tables.projectHostedChannels.values()][0].selection);
  const request = {
    projectId: f.projectId,
    operationId: randomUUID(),
    authorityEpoch: 1,
    expectedMain: { head: main.head, receiptId: main.receipt.id },
    intent: { kind: 'existing', intentId: f.intents[574].id },
  };
  const legacyStart = JSON.parse(await f.transaction('legacyStart', start.start, request));
  assert.equal(Object.hasOwn(legacyStart, 'fixBrief'), false);
  assert(
    hostedStartResultSchema.omit({ fixBrief: true, needsFix: true }).strict().safeParse(legacyStart).success,
  );
  const modernStart = JSON.parse(
    await f.transaction('modernStart', start.start, {
      ...request,
      operationId: randomUUID(),
      noticeVersion: 1,
    }),
  );
  assert.match(modernStart.fixBrief, /synthetic failure/);
  assert.equal(modernStart.needsFix.length, 1);
  const modernReplay = JSON.parse(
    await f.transaction('noticeAwareRetryOfLegacyStart', start.start, { ...request, noticeVersion: 1 }),
  );
  assert.equal(modernReplay.lane.laneId, legacyStart.lane.laneId);
  assert.match(modernReplay.fixBrief, /synthetic failure/);
  const legacyReplay = JSON.parse(
    await f.transaction('legacyRetryOfNoticeAwareStart', start.start, {
      ...request,
      operationId: modernStart.operationId,
    }),
  );
  assert.equal(legacyReplay.lane.laneId, modernStart.lane.laneId);
  assert.equal(Object.hasOwn(legacyReplay, 'fixBrief'), false);
  assert.equal(Object.hasOwn(legacyReplay, 'needsFix'), false);
});

test('new client on old server retries only capability negotiation and keeps old start arguments', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const f = agentFixture(t),
    query = f.exchange.client.query;
  let rejected = 0;
  f.exchange.client.query = async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedAgent:capabilities' && args.noticeVersion === 1) {
      rejected++;
      throw new Error('ArgumentValidationError: extra field noticeVersion');
    }
    return query(ref, args);
  };
  const started = await f.transport().dispatch('start', { outcome: 'Legacy server work' });
  assert(started.result.lane);
  assert.equal(rejected, 1);
  assert.equal(f.calls.find(c => c.name === 'projectHostedStart:start').args.noticeVersion, undefined);
});

test('a later green main supersedes pending automatic reverse work without undoing the fix', async () => {
  for (const step of ['advance', 'transfer']) {
    const f = await fixture(1);
    await f.runCulprit();
    await f.complete(f.probes()[0], true);
    assert.equal(JSON.parse(f.recovery().recovery).stage, 'sync');
    f.patch('projectHostedMainAudits', f.auditRow, { red: undefined });
    await f.transaction('superseded', culprit[step], { projectId: f.projectId, runId: f.recoveryId() });
    assert.equal(JSON.parse(f.recovery().recovery).stage, 'done');
    assert.equal(f.tables.projectHostedComposes.size, 0);
    assert.equal(f.tables.projectHostedLandingRequests.size, 0);
  }
});

test('contradictory evidence on the same State never blames or reverses a no-op receipt', async () => {
  const f = await fixture(1, { noop: true });
  await f.runCulprit();
  await f.complete(f.probes()[0], true);
  assert.equal(f.probes().length, 1);
  assert.equal(f.tables.projectHostedSyncs.size, 0);
  const recovery = JSON.parse(f.recovery().recovery);
  assert.equal(recovery.target, undefined);
  assert.equal(recovery.stage, 'done');
  assert.match(recovery.reason, /distinct passing and failing/);
});

test('audit completion schedules classification after red persists; probes and reverses cross the terminal boundary', async () => {
  const f = await fixture(1);
  const mainAudit = await import(moduleUrl('../convex/projectHostedMainAuditState.ts'));
  const auditRow = f.tables.projectHostedMainAudits.get(f.auditRow);
  f.patch('projectHostedMainAudits', f.auditRow, {
    audit: { ...auditRow.audit, status: 'running' },
    red: undefined,
  });
  const { auditReason } = await import('../dist/main-audit.js');
  const audit = {
    ...f.audit,
    gate: {
      mode: 'audit',
      reason: auditReason({
        sequence: 575,
        count: 1,
        attempt: 0,
        key: hash,
        firstAt: at,
      }),
    },
  };
  await f.transaction('redAudit', { _handler: ctx => mainAudit.onGateRunTerminal(ctx, audit) }, {});
  const classification = f.scheduled.find(s => s.name === 'projectHostedCulprit:startRedClassification');
  assert.deepEqual(classification.args, { projectId: f.projectId, runId: audit.id });
  assert.equal(f.tables.projectHostedMainAudits.get(f.auditRow).red.runId, audit.id);
  await f.transaction('scheduledClassification', culprit.startRedClassification, classification.args);
  assert.equal(f.probes().length, 1);
  const probe = {
    ...f.probes()[0],
    status: 'passed',
    endedAt: at,
    terminalDigest: hash,
    contractReports: { 'tests/red.test.mjs': { failed: false } },
  };
  const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === probe.id);
  f.patch('projectHostedCheckRuns', row._id, { status: probe.status, value: JSON.stringify(probe) });
  await f.transaction('probeHook', { _handler: ctx => mainAudit.onGateRunTerminal(ctx, probe) }, {});
  const callback = f.scheduled.find(s => s.name === 'projectHostedCulprit:terminal');
  assert.deepEqual(callback.args, { projectId: f.projectId, runId: probe.id });
  await f.transaction('scheduledProbeTerminal', culprit.terminal, callback.args);
  assert.equal(f.tables.projectHostedMainAudits.get(f.auditRow).red, undefined);
  for (const status of ['passed', 'failed', 'cancelled', 'interrupted', 'runner-unavailable']) {
    f.scheduled.length = 0;
    const reverse = {
      ...probe,
      id: randomUUID(),
      status,
      gate: { mode: 'full', reason: `culprit-revert:${audit.id}` },
    };
    await f.transaction('reverseHook', { _handler: ctx => mainAudit.onGateRunTerminal(ctx, reverse) }, {});
    assert.deepEqual(f.scheduled.find(s => s.name === 'projectHostedCulprit:terminal')?.args, {
      projectId: f.projectId,
      runId: reverse.id,
    });
  }
});

test('authoritative full gate survives notice closure and one fix member forces a full batch selection', async () => {
  const { policyPreset } = await import('../dist/autonomy-policy.js');
  const gate = await import(moduleUrl('../convex/projectHostedGate.ts'));
  const f = await checksFixture();
  f.decorateContext(ctx => {
    ctx.scheduler = { runAfter: async () => 'scheduled-task' };
  });
  const candidate = {
    ...f.candidate,
    id: randomUUID(),
    governance: { version: 1, paths: ['src/leaf.ts'], ownerInputs: true },
  };
  seedRecord(f, candidate);
  const contract = {
    version: 1,
    operationId: randomUUID(),
    request: hash,
    candidateId: candidate.id,
    measuredOn: candidate.result.head,
    runId: randomUUID(),
    at,
    proposedTests: ['tests/red.test.mjs'],
    tests: [{ path: 'tests/red.test.mjs', durationMs: 1 }],
    totalMs: 1,
  };
  seedRecord(f, {
    kind: 'intent',
    id: candidate.intentId,
    version: 0,
    at,
    outcome: 'Fix',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: candidate.base,
    status: 'active',
    testContracts: [contract],
  });
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
  f.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    lastGreen: { sequence: 0, head: candidate.base.head, runId: randomUUID() },
  });
  await f.bindRepository(f.projectId, { repository: 'synthetic/checks', repoId: 123, installationId: 9 });
  const configuration = await f.configure(
    {
      kind: 'runner',
      configuration: {
        provider: 'github-actions',
        repository: 'synthetic/checks',
        installationId: '9',
        runsOn: 'ubuntu-latest',
        runtime: f.runner.runtime,
        environmentFingerprint: f.runner.environmentFingerprint,
      },
    },
    f.configuration.digest,
  );
  const select = () =>
    f.selection({
      candidateId: candidate.id,
      expectedConfiguration: configuration.digest,
      gate: { mode: 'contract', tests: ['tests/red.test.mjs'] },
    });
  assert.equal((await f.enqueue(select())).gate.mode, 'contract');
  const header = [...f.tables.projectHostedRecords.values()].find(r => r.key === candidate.id);
  f.patch('projectHostedRecords', header._id, { restoreBases: '{}' });
  assert.equal((await f.enqueue(select())).gate.mode, 'full');
  const other = { ...candidate, id: randomUUID(), intentId: randomUUID() };
  const members = [other, candidate].map(candidate => ({
    candidate,
    actor: { kind: 'agent', id: 'owner' },
    contract,
  }));
  for (const ordered of [members, [...members].reverse()]) {
    f.patch('hostedProjects', f.projectId, { needsFix: { [candidate.intentId]: '{}' } });
    const batch = await f.transaction(
      'fixBatchGate',
      {
        _handler: ctx => gate.hostedGateForCandidates(ctx, f.tables.hostedProjects.get(f.projectId), ordered),
      },
      {},
    );
    assert.equal(batch.mode, 'full');
    f.patch('hostedProjects', f.projectId, { needsFix: undefined });
  }
  assert.equal((await f.enqueue(select())).gate.mode, 'full');
});

test('flake recovery releases held requests through the audit reducer and clears stale MAIN_RED notices', async () => {
  const f = await fixture();
  const { hostedLandingStateSchema, landingObservation } = await import('../dist/hosted-landing.js');
  const id = randomUUID(),
    operationId = randomUUID(),
    attemptId = randomUUID();
  const state = hostedLandingStateSchema.parse({
    schema: 1,
    projectId: f.projectId,
    id,
    operationId,
    actor: 'owner',
    at,
    sequence: 1,
    version: 0,
    firstAttemptId: attemptId,
    attemptId,
    phase: 'ready',
    observation: landingObservation('queued'),
    error: { code: 'MAIN_RED', message: 'Main audit failed.' },
    request: {
      operationId,
      authorityEpoch: 1,
      channel: 'main',
      expectedMain: { head: f.heads.at(-1), receiptId: f.receipts.at(-1).id },
      candidateId: f.candidate.id,
      expectedHead: f.state.sha256,
      agent: true,
      check: null,
    },
  });
  const rowId = f.insert('projectHostedLandingRequests', {
    projectId: f.projectId,
    channel: 'main',
    submissionId: id,
    operationId,
    actor: 'owner',
    sequence: 1,
    hold: 'main-red',
    runnable: false,
    phase: 'ready',
    runId: null,
    attemptId,
    value: JSON.stringify(state),
  });
  await f.runCulprit();
  await f.complete(f.probes()[0], false);
  const release = f.scheduled.find(s => s.name === 'projectHostedMainAudit:releaseHeld');
  assert.deepEqual(release?.args, { projectId: f.projectId });
  const audit = await import(moduleUrl('../convex/projectHostedMainAudit.ts'));
  await f.transaction('releaseFlakeHold', audit.releaseHeld, release.args);
  const row = f.tables.projectHostedLandingRequests.get(rowId);
  assert.equal(row.hold, undefined);
  assert.equal(row.runnable, true);
  const updated = JSON.parse(row.value);
  assert.equal(updated.error, null);
  assert.equal(updated.version, 1);
  assert.deepEqual(updated.observation, landingObservation('queued'));
});

test('stepped source worker reapplies a restored ancestor instead of treating reverted main as a fast-forward', async () => {
  const { composeFixture } = await import('./hosted-compose-fixture.mjs');
  const { initialSourceStep, runSourceStep } = await import('../dist/hosted-source-step.js');
  const { saveBytes } = await import('../dist/hosted-save.js');
  const f = await composeFixture();
  const original = f.file('original.txt', 'original');
  const accepted = f.state([f.baseFile, f.hidden, original], [f.baseline.sha256]);
  const reverted = f.state([f.baseFile, f.hidden], [accepted.sha256]);
  const lane = await f.lane(accepted, { restoreBase: f.baseline.sha256 });
  f.register(reverted);
  f.moveMain(reverted.sha256, 'revert-receipt');
  const selected = f.selection([lane], [], {
    expectedMain: { head: reverted.sha256, receiptId: 'revert-receipt' },
  });
  await f.prepare(selected);
  await f.stage(selected);
  const plan = (await f.progress(selected)).input;
  const input = f.put(saveBytes(plan));
  const expected = await f.compute(plan);
  const io = {
    describeBatch: async ids =>
      ids.map(id => ({ object: { sha256: id, size: f.objects.get(id).length }, recipe: null })),
    read: async pin =>
      (async function* () {
        yield f.objects.get(pin.sha256);
      })(),
    upload: async (pin, stream) => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.deepEqual(f.put(Buffer.concat(chunks)), pin);
    },
  };
  let cursor = initialSourceStep(input);
  for (let steps = 0; cursor.phase !== 'done'; steps++) {
    assert(steps < 100, 'finite source continuations');
    const before = structuredClone(cursor);
    const result = await runSourceStep(cursor, io);
    assert.deepEqual(cursor, before, 'durable input is unchanged');
    assert.deepEqual((await runSourceStep(before, io)).cursor, result.cursor, 'lost replies replay exactly');
    cursor = result.cursor;
  }
  assert.equal(cursor.head, expected.head);
  const files = JSON.parse(f.objects.get(cursor.head)).files.map(file => file.path);
  assert(files.includes('original.txt'), 'the original change is actually restored');
});

test('flake recovery retains newer audit debt and cadence when covered receipts include docs', async () => {
  const { auditReason } = await import('../dist/main-audit.js');
  for (const coveredCount of [1, 2]) {
    const f = await fixture(2);
    const firstAt = new Date().toISOString();
    f.audit.gate.reason = auditReason({
      sequence: 575,
      count: coveredCount,
      attempt: 0,
      key: hash,
      firstAt: at,
    });
    const runRow = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === f.audit.id);
    f.patch('projectHostedCheckRuns', runRow._id, { gate: f.audit.gate, value: JSON.stringify(f.audit) });
    f.patch('projectHostedMainAudits', f.auditRow, { unaudited: { count: coveredCount + 1, firstAt } });
    await f.runCulprit();
    await f.complete(f.probes()[0], false);
    const audit = f.tables.projectHostedMainAudits.get(f.auditRow);
    assert.deepEqual(
      audit.unaudited,
      { count: 1, firstAt },
      'only the audit-covered counted landings are cleared',
    );
    assert.equal(audit.red, undefined);
    const next = f.scheduled.find(s => s.name === 'projectHostedMainAudit:start');
    assert.equal(
      next?.args.wakeAt,
      Date.parse(firstAt) + 24 * 60 * 60_000,
      'newer counted work retains its owned cadence wake',
    );
    assert.equal(audit.wake.at, next.args.wakeAt);
  }
});

test('W19: the notice records at most three failing files and how many more', () => {
  const file = n => ({ file: `tests/t${n}.test.mjs` });
  assert.deepEqual(culprit.noticeTests([]), {});
  assert.deepEqual(culprit.noticeTests([file(1)]), { tests: ['tests/t1.test.mjs'] });
  assert.deepEqual(culprit.noticeTests([1, 2, 3].map(file)).moreTests, undefined);
  assert.deepEqual(culprit.noticeTests([1, 2, 3, 4, 5, 6].map(file)), {
    tests: ['tests/t1.test.mjs', 'tests/t2.test.mjs', 'tests/t3.test.mjs'],
    moreTests: 3,
  });
  assert.equal(culprit.noticeTests([{ file: 'x'.repeat(500) }]).tests[0].length, 240);
});
