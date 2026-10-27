// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { checksFixture, code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedRecordSchema } from '../dist/hosted-records.js';
const backend = await import(moduleUrl('../convex/projectIntentTests.ts'));
const store = await import(moduleUrl('../convex/projectIntentTestStore.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const a = 'tests/leaf.test.mjs',
  b = 'tests/extra.test.mjs';
async function fixture() {
  const s = await checksFixture(),
    objects = new Map();
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const pin = s.put(bytes);
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const state = files =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: Object.entries(files).map(([path, text]) => ({ path, mode: 'file', blob: put(text).sha256 })),
        message: 'synthetic contract source',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
  const baseFiles = {
    'src/leaf.ts': 'export const leaf = 1;',
    [a]: "import '../dist/leaf.js';",
    [b]: "import 'node:assert';",
  };
  const base = state(baseFiles),
    head = state({ ...baseFiles, 'src/leaf.ts': 'export const leaf = 2;' });
  const intent = {
    kind: 'intent',
    id: randomUUID(),
    version: 0,
    at: '2026-01-01T00:00:00.000Z',
    outcome: 'Hosted proving tests',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: { head: base.sha256, receiptId: 'main-0' },
    status: 'active',
  };
  await s.run('contractIntent', records.writeHostedRecord, {
    ...s.auth,
    expectedVersion: null,
    record: intent,
  });
  const candidate = {
    ...s.candidate,
    id: randomUUID(),
    intentId: intent.id,
    base: intent.base,
    result: { status: 'clean', head: head.sha256 },
  };
  await s.run('contractCandidate', records.writeHostedRecord, {
    ...s.auth,
    expectedVersion: null,
    record: candidate,
  });
  s.insert('projectHostedStates', {
    projectId: s.projectId,
    head: head.sha256,
    size: head.size,
    input: 'a'.repeat(64),
    jobId: randomUUID(),
    output: 'b'.repeat(64),
  });
  const run = await s.enqueue(s.selection({ candidateId: candidate.id, expectedHead: head.sha256 }));
  const stream = { shard: 0, attempt: 0, executionId: 'synthetic', stream: 'stdout', name: 'stdout' };
  let reports = { [a]: 1200, [b]: 800 },
    complete = true,
    actor = 'owner',
    corrupt = false;
  const outputBytes = () =>
    Buffer.from(
      Object.entries(reports)
        .map(([file, durationMs]) => '__FORGE_TESTS__' + JSON.stringify({ file, durationMs, complete: true }))
        .join('\n') + '\n',
    );
  const pin = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  const invoke = async (name, args) => {
    if (name === 'projectIntentTestStore:context') return s.call(name, store.context, args, actor);
    if (name === 'projectIntentTestStore:objects') return s.call(name, store.objects, args, actor);
    if (name === 'projectIntentTestStore:confirm') return s.call(name, store.confirm, args, actor);
    if (name === 'projectHostedCheckRead:status') return { ...run, status: 'passed' };
    if (name === 'projectHostedOutputRead:manifest') return { complete };
    if (name === 'projectHostedOutputRead:streams') {
      const bytes = outputBytes();
      return {
        page: [
          {
            streamId: 'synthetic-stream',
            stream,
            seal: { stream, chunks: 1, bytes: bytes.length, sha256: pin(bytes).sha256 },
          },
        ],
        isDone: true,
        continueCursor: '',
      };
    }
    if (name === 'projectHostedOutputRead:download')
      return { object: pin(outputBytes()), url: 'https://fixture.invalid/timings' };
    assert.fail(`Unexpected API ${name}`);
  };
  const ctx = {
    runQuery: (ref, args) => invoke(getFunctionName(ref), args),
    runMutation: (ref, args) => invoke(getFunctionName(ref), args),
  };
  const reader = {
    read: async (projectId, subject, pins) => {
      assert.equal(projectId, s.projectId);
      assert.equal(subject, actor);
      return pins.map(pin => {
        const bytes = objects.get(pin.sha256);
        assert.equal(bytes.length, pin.size);
        return bytes;
      });
    },
  };
  const execute = command =>
    backend.executeIntentTests(
      ctx,
      s.projectId,
      JSON.stringify({ candidateId: candidate.id, ...command }),
      reader,
    );
  const originalFetch = globalThis.fetch;
  return {
    ...s,
    candidate,
    intent,
    run,
    execute,
    context: ctx,
    setReports: value => (reports = value),
    setComplete: value => (complete = value),
    setActor: value => (actor = value),
    setCorrupt: value => (corrupt = value),
    install(t) {
      globalThis.fetch = async () => new Response(corrupt ? 'changed output' : outputBytes());
      t.after(() => (globalThis.fetch = originalFetch));
    },
    confirm: overrides => ({
      action: 'confirm-tests',
      operationId: randomUUID(),
      runId: run.id,
      expectedHead: head.sha256,
      expectedVersion: 0,
      ...overrides,
    }),
  };
}
test('server proposal/confirmation/edit, immutable Intent versions and review use exact measured source', async t => {
  const s = await fixture();
  s.install(t);
  const before = await s.execute({ action: 'tests' });
  assert.deepEqual(before.tests, [a]);
  assert.equal(before.contractProposal.totalMs, null);
  const proposal = await s.execute({ action: 'tests', runId: s.run.id });
  assert.equal(proposal.contractProposal.totalMs, 1200);
  const command = s.confirm(),
    first = await s.execute(command);
  assert.equal(first.contract.measuredOn, s.candidate.result.head);
  assert.equal(first.contract.totalMs, 1200);
  const edit = await s.execute(s.confirm({ tests: [b], expectedVersion: 1 }));
  assert.equal(edit.contract.totalMs, 800);
  assert.equal(edit.contract.version, 2);
  assert.deepEqual(edit.contract.proposedTests, [a]);
  assert.deepEqual(await s.execute(command), first);
  await assert.rejects(s.execute({ ...command, tests: [b] }), code('WORK_OPERATION_CHANGED'));
  const review = JSON.parse(
    await s.call('contractReview', store.review, { projectId: s.projectId, intentId: s.intent.id }),
  );
  assert.deepEqual(review.contract, edit.contract);
  const history = [...s.tables.projectHostedRecords.values()].filter(
    row => row.kind === 'intent' && row.key === s.intent.id,
  );
  assert.deepEqual(history.map(row => row.version).sort(), [0, 1, 2]);
  assert.equal(
    hostedRecordSchema.options[0].parse(
      JSON.parse(
        await s.call('contractContext', store.context, {
          projectId: s.projectId,
          candidateId: s.candidate.id,
        }),
      ).intent,
    ).testContracts.length,
    2,
  );
});
test('server refuses budget overflow, unknown/incomplete timings, wrong source and corrupt bytes', async t => {
  const s = await fixture();
  s.install(t);
  s.setReports({ [a]: 90000 });
  await assert.rejects(
    s.execute(s.confirm()),
    e => e.code === 'CONTRACT_OVER_BUDGET' && /90000 ms/.test(e.message) && e.message.includes(a),
  );
  s.setReports({ [b]: 100 });
  await assert.rejects(s.execute(s.confirm()), { code: 'CONTRACT_TIMING_MISSING' });
  s.setReports({ [a]: 100 });
  s.setComplete(false);
  await assert.rejects(s.execute(s.confirm()), { code: 'CONTRACT_TIMING_MISSING' });
  s.setComplete(true);
  s.setCorrupt(true);
  await assert.rejects(s.execute(s.confirm()), { code: 'R2_OBJECT_CHECKSUM_MISMATCH' });
  s.setCorrupt(false);
  await assert.rejects(s.execute(s.confirm({ expectedHead: 'c'.repeat(64) })), { code: 'VIEW_STALE' });
  const review = await s.call('noContract', store.review, { projectId: s.projectId, intentId: s.intent.id });
  assert.equal(JSON.parse(review).contract, null);
});
test('server contract reads and writes recheck current project access and authority', async t => {
  const s = await fixture();
  s.install(t);
  s.setActor('outsider');
  await assert.rejects(s.execute({ action: 'tests' }), code('PROJECT_UNAVAILABLE'));
  s.setActor('owner');
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'native-owner', epoch: 2 } });
  await assert.rejects(s.execute(s.confirm()), code('SOURCE_AUTHORITY_CHANGED'));
  assert.equal(
    await s.call('nativeContractReview', store.review, { projectId: s.projectId, intentId: s.intent.id }),
    null,
  );
});
