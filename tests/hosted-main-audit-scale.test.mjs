// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auditFixture, state } from './hosted-main-audit-fixture.mjs';
import { hostedRecordValue, hostedRecordIndex } from '../dist/hosted-records.js';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
import { stateSchema } from '../dist/native-state-format.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';

test('600 Intents, 575 receipts and 3k files: a 30-landing day runs three bounded audits; idle zero', async t => {
  const f = await auditFixture();
  const { receipt } = await f.land('full');
  const at = new Date().toISOString();
  for (let i = 0; i < 600; i++) {
    const { record, ref, value } = hostedRecordValue({
      kind: 'intent',
      id: randomUUID(),
      version: 0,
      at,
      outcome: 'Synthetic scale Intent',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: receipt.candidate.head, receiptId: receipt.id },
      status: 'active',
    });
    const bodyId = f.insert('projectHostedRecordBodies', { projectId: f.projectId, value });
    const identity = { projectId: f.projectId, kind: 'intent', key: record.id };
    const recordId = f.insert('projectHostedRecords', {
      ...identity,
      ...hostedRecordIndex(record),
      version: 0,
      bodyId,
      digest: ref.digest,
      bytes: ref.bytes,
    });
    f.insert('projectHostedRecordHeads', { ...identity, ...hostedRecordIndex(record), version: 0, recordId });
  }
  for (let i = 2; i <= 575; i++) {
    const id = randomUUID();
    const value = hostedAcceptanceSchema.parse({
      ...receipt,
      id,
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      snapshot: { ...receipt.snapshot, id, revision: i },
    });
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: id,
      submissionId: value.submissionId,
      attemptId: value.attemptId,
      sequence: i,
      value: canonicalPayload(value),
    });
  }
  f.setRevision(575);
  const tree = stateSchema.parse({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: Array.from({ length: 3000 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      blob: 'a'.repeat(64),
      mode: 'file',
    })),
    message: 'Synthetic 3k-file tree',
    at,
  });
  const treePin = f.put(canonicalPayload(tree));
  f.insert('projectHostedStates', {
    projectId: f.projectId,
    head: treePin.sha256,
    size: treePin.size,
    input: 'a'.repeat(64),
    jobId: randomUUID(),
    output: 'b'.repeat(64),
  });
  const start = f.counts.length,
    began = performance.now();
  let audits = 0;
  const runCalls = [];
  for (let i = 0; i < 30; i++) {
    await f.land('contract', { head: i === 29 ? treePin.sha256 : undefined });
    if ((i + 1) % 10 !== 0) continue;
    const controlBefore = f.counts.length;
    await f.tick(f.pending()[0]);
    assert.equal(f.counts.length - controlBefore, 1, 'one audit start control call');
    audits++;
    const checkBefore = f.counts.length;
    const active = await f.activate(f.currentRun().id, 9);
    for (let shard = 0; shard < 9; shard++)
      await f.callback({ ...f.shard(active, shard), provider: 'github-actions' });
    await f.callback({ ...f.complete(active), provider: 'github-actions' });
    runCalls.push(f.counts.length - checkBefore);
    // The fake provider delivered the plan and all nine results above; it owns no remaining dispatch job.
    for (const task of f.pending('projectHostedActionsDirect:dispatch'))
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    assert.equal(f.row().unaudited.count, 0);
    assert.equal(f.pending().length, 0);
  }
  assert.equal(audits, 3);
  assert(runCalls.every(count => count <= 80));
  assert.equal(
    [...f.tables._scheduled_functions.values()].filter(row => row.state.kind === 'pending').length,
    0,
  );
  const measured = f.counts.slice(start);
  const landings = measured.filter(row => row.name === 'auditLanding');
  assert(
    landings.every(row => row.documents <= 3 && row.writes <= 5),
    'existing row: two indexed reads plus cancellation acknowledgement at cadence threshold',
  );
  const auditCalls = measured.filter(row => !['auditSeedCandidate', 'auditLanding'].includes(row.name));
  assert(auditCalls.length <= audits * 85 && auditCalls.length <= 500);
  const idle = f.counts.length;
  await f.run('idleGate', ctx => state.mainGate(ctx, f.projectId));
  assert.equal(f.pending().length, 0);
  assert.equal(f.counts.length, idle + 1, 'only the explicit status read runs at idle');
  t.diagnostic(
    JSON.stringify({
      intents: 600,
      historyReceipts: 575,
      sourceFiles: 3000,
      landings: 30,
      audits,
      controlCallsPerAudit: 1,
      measuredCheckMetadataCallsPerAudit: runCalls,
      measuredAuditCallsPerDay: auditCalls.length,
      baseline76CallRunEnvelopePerDay: audits * (76 + 1),
      landingReads: Math.max(...landings.map(row => row.documents)),
      landingWrites: Math.max(...landings.map(row => row.writes)),
      auditDocumentsRead: auditCalls.reduce((sum, row) => sum + row.documents, 0),
      auditDocumentsWritten: auditCalls.reduce((sum, row) => sum + row.writes, 0),
      maxAuditReadBytes: Math.max(...auditCalls.map(row => row.readBytes)),
      idleScheduledFunctions: 0,
      wallMs: performance.now() - began,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );

  // The same dogfood-size history must not turn a reduced pass into another
  // dispatch or an idle retry loop, even when the count already exceeds cadence.
  for (let i = 0; i < 10; i++) await f.land();
  await f.tick(f.pending()[0]);
  const selected = f.currentRun();
  const terminalBefore = f.counts.length;
  const terminalBegan = performance.now();
  const finished = await f.terminal('passed', {
    ...selected,
    gate: { ...selected.gate, effective: 'docs' },
  });
  const terminal = f.counts.slice(terminalBefore);
  assert.equal(terminal.length, 1, 'scope guard stays inside the existing completion call');
  assert(terminal[0].documents <= 10 && terminal[0].writes <= 10);
  assert.equal(f.row().unaudited.count, 10);
  assert.equal(f.row().lastGreen.sequence, 605);
  assert.equal(f.pending().length, 0);
  for (const task of f.pending('projectHostedActionsDirect:dispatch'))
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  const events = f.tables.projectHostedMainAuditEvents.size;
  await f.run('duplicateNotFull', ctx => state.onGateRunTerminal(ctx, finished));
  await f.start();
  assert.equal(f.tables.projectHostedMainAuditEvents.size, events);
  assert.equal(
    [...f.tables._scheduled_functions.values()].filter(row => row.state.kind === 'pending').length,
    0,
  );
  t.diagnostic(
    JSON.stringify({
      notFullCompletionCalls: terminal.length,
      notFullDocumentsRead: terminal[0].documents,
      notFullDocumentsWritten: terminal[0].writes,
      idleScheduledFunctions: 0,
      notFullWallMs: performance.now() - terminalBegan,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});
