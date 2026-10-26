// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { nativeSelfMetricsReader } from '../dist/self-metrics-native.js';
import { hostedSelfMetricsReader } from '../dist/self-metrics-hosted.js';
import { readSelfMetrics } from '../dist/self-metrics.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import {
  readSelfMetricJournal,
  readSelfMetricReceipts,
  selfMetricsJournalPath,
  withLifecycleMetric,
} from '../dist/self-metrics-journal.js';
import { publishRecords } from '../dist/work-records.js';
import { ForgeError } from '../dist/errors.js';
import { WorkService } from '../dist/work.js';
import { saveBytes } from '../dist/hosted-save.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { digest } from '../dist/hash.js';
import { cleanupOwner } from './owner-cleanup.mjs';
const period = { from: '2026-10-14T00:00:00.000Z', to: '2026-10-25T03:30:00.000Z' };
const at = time => `2026-10-23T${time}:00.000Z`;
const h = 'a'.repeat(64),
  def = 'd'.repeat(64);
function tree(root) {
  const output = [];
  function walk(path) {
    for (const file of readdirSync(path)) {
      const p = join(path, file),
        s = lstatSync(p);
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) output.push([p, digest(readFileSync(p))]);
    }
  }
  walk(root);
  return output;
}
test('native reader replays a leaderless batch from owner shapes, reads a pinned snapshot and never writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-m1-native-'));
  writeFileSync(join(root, 'file.txt'), 'fixture\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  try {
    const lane = (
      await agent.dispatch({ action: 'start', operationId: randomUUID(), outcome: 'metric fixture' })
    ).result;
    const data = agent.work.store.load();
    const viewId = randomUUID(),
      entryId = randomUUID(),
      batchId = randomUUID();
    data.views.push({
      id: viewId,
      intentId: lane.intentId,
      base: lane.head,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
      status: 'clean',
      head: lane.head,
      details: '',
      at: at('12:00'),
      dependencies: [],
    });
    data.schema = 17;
    data.landingEntries = [
      {
        id: entryId,
        request: h,
        channel: 'main',
        viewId,
        head: lane.head,
        checkId: randomUUID(),
        definition: def,
        environment: h,
        arrivedAt: at('12:00'),
        priority: 'normal',
        submitter: 'builder',
        keepOpen: false,
        status: 'checking',
        batchId,
      },
    ];
    data.landingBatches = [
      {
        id: batchId,
        channel: 'main',
        base: lane.head,
        previous: null,
        arrivedAt: at('12:01'),
        entryIds: [entryId],
        mode: 'parallel',
        status: 'checking',
        prefixes: [],
        conflicts: [],
      },
    ];
    agent.work.store.locked(() => agent.work.store.save(data));
    const before = tree(join(root, '.forge'));
    const m = await readSelfMetrics(nativeSelfMetricsReader(root), { ...period, asOf: at('14:00') });
    assert.equal(m.metric3.dropped, 1);
    assert.equal(m.metric3.rows[0].entryId, entryId);
    assert.equal(m.metric3.partial, true);
    assert.deepEqual(tree(join(root, '.forge')), before);
  } finally {
    await cleanupOwner(root);
  }
});
test('hosted reader hydrates table bodies and immutable input pages, counts failed attempts and main acceptance', async () => {
  const laneId = randomUUID(),
    intentId = randomUUID(),
    candidateId = randomUUID(),
    submissionId = randomUUID(),
    attemptId = randomUUID(),
    runId = randomUUID();
  const { pages } = buildComposePages([
    {
      laneId,
      head: h,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: { sha256: h, size: 1 }, recipe: null },
    },
  ]);
  const page = pages[0],
    blobs = new Map(pages.map(p => [p.pin.sha256, Buffer.from(saveBytes(p.value))]));
  const table = {
    projectHostedRecords: [{ bodyId: 'body' }],
    projectHostedRecordBodies: [
      {
        _id: 'body',
        value: JSON.stringify({ kind: 'lane', id: laneId, intentId, head: h, version: 0, at: at('09:00') }),
      },
    ],
    projectHostedLandingRequests: [
      {
        value: JSON.stringify({
          id: submissionId,
          attemptId,
          at: at('10:00'),
          phase: 'landed',
          request: { candidateId },
        }),
      },
    ],
    projectHostedLandingAttempts: [
      {
        value: JSON.stringify({
          id: attemptId,
          submissionId,
          at: at('10:00'),
          candidate: { inputs: page.pin },
          check: { runId },
        }),
      },
    ],
    projectHostedAcceptances: [
      {
        value: JSON.stringify({
          id: randomUUID(),
          channel: 'main',
          at: at('11:00'),
          candidate: { head: h, inputs: page.pin },
        }),
      },
    ],
    projectHostedCheckRuns: [
      {
        value: JSON.stringify({
          id: runId,
          at: at('10:01'),
          endedAt: at('10:03'),
          status: 'passed',
          request: { expectedHead: h },
          candidate: { inputs: page.pin },
          check: { definition: def },
          plan: { lockfile: h },
          cost: { status: 'observed', seconds: 240 },
        }),
      },
    ],
  };
  const source = { records: async name => table[name] ?? [], object: async pin => blobs.get(pin.sha256) };
  const m = await readSelfMetrics(hostedSelfMetricsReader(source), period);
  assert.equal(m.landings, 1);
  assert.equal(m.metric1.days.find(d => d.day === '2026-10-23').firstTry, 1);
  assert.equal(m.metric3.dropped, null);
  assert.equal(m.metric6.runnerMinutes, 4);
  assert.equal(m.metric6.wallMinutes, 2);
  assert.equal(m.metric6.reuseRate, null);
  assert.equal(m.metric6.partial, true);
  const laneBody = JSON.parse(table.projectHostedRecordBodies[0].value);
  laneBody.revert = { receiptId: randomUUID(), previous: h, accepted: h };
  table.projectHostedRecordBodies[0].value = JSON.stringify(laneBody);
  const compensating = await readSelfMetrics(hostedSelfMetricsReader(source), period);
  assert.equal(compensating.landings, 0);
  assert.equal(compensating.metric1.compensating, 1);
  const bad = hostedSelfMetricsReader({ ...source, object: async () => Buffer.from('changed') });
  await assert.rejects(
    () => bad.read(),
    e => e.code === 'EVIDENCE_CHANGED',
  );
});
test('lifecycle receipt records final returned errors once, reads stay silent, cancellation and raw owner mutations have a requester', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-m1-journal-'));
  writeFileSync(join(root, 'file.txt'), 'fixture\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  try {
    const operationId = randomUUID();
    const lane = (
      await agent.dispatch({ action: 'start', operationId, outcome: 'metric receipt', actor: 'builder' })
    ).result;
    const records = readSelfMetricReceipts(store.directory);
    assert.ok(
      records.some(
        r =>
          r.kind === 'lifecycle' &&
          r.operationId === operationId &&
          r.actor.name === 'builder' &&
          !r.errorCode,
      ),
    );
    assert.ok(
      records
        .filter(r => r.kind === 'mutation' && r.operationId === operationId)
        .every(r => r.actor.name === 'builder'),
    );
    const before = readFileSync(selfMetricsJournalPath(store.directory));
    await agent.dispatch({ action: 'records', collection: 'lanes', offset: 0, limit: 10 });
    assert.deepEqual(readFileSync(selfMetricsJournalPath(store.directory)), before);
    const bad = randomUUID();
    await assert.rejects(() =>
      agent.dispatch({
        action: 'checkpoint',
        operationId: bad,
        laneId: randomUUID(),
        expectedHead: lane.head,
        message: 'missing',
      }),
    );
    assert.equal(
      readSelfMetricReceipts(store.directory).filter(
        r => r.kind === 'lifecycle' && r.operationId === bad && r.errorCode === 'NOT_FOUND',
      ).length,
      1,
    );
    const person = new WorkService(root, { kind: 'person', id: 'operator' });
    await person.dispatch(
      { action: 'intent', outcome: 'operator mutation', constraints: '' },
      store.revision(),
    );
    assert.ok(
      readSelfMetricReceipts(store.directory).some(
        r => r.kind === 'mutation' && r.action === 'intent' && r.actor.name === 'operator',
      ),
    );
    const view = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: lane.head }],
      })
    ).result;
    const cancel = randomUUID(),
      data = store.load();
    data.schema = 17;
    data.landingEntries = [
      {
        id: cancel,
        request: h,
        channel: 'main',
        viewId: view.viewId,
        head: view.head,
        checkId: randomUUID(),
        definition: def,
        environment: h,
        arrivedAt: new Date().toISOString(),
        priority: 'normal',
        submitter: 'builder',
        keepOpen: false,
        status: 'queued',
      },
    ];
    store.locked(() => store.save(data));
    await agent.dispatch({ action: 'cancel', operationId: cancel, actor: 'canceller' });
    assert.ok(
      readSelfMetricReceipts(store.directory).some(
        r =>
          r.kind === 'mutation' &&
          r.action === 'cancel' &&
          r.operationId === cancel &&
          r.actor.name === 'canceller',
      ),
    );
    assert.equal(store.select('landingEntries', cancel).status, 'cancelled');
  } finally {
    await cleanupOwner(root);
  }
});

test('Oct 21 concurrency replay records seven caller-visible WORK_STALE errors and hides successful internal retries', async () => {
  const { withLifecycleMetric } = await import('../dist/self-metrics-journal.js');
  const { ForgeError } = await import('../dist/errors.js');
  const { calculateSelfMetrics } = await import('../dist/self-metrics.js');
  const directory = mkdtempSync(join(tmpdir(), 'forge-m1-eight-'));
  try {
    await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        withLifecycleMetric(
          directory,
          { action: 'finish', operationId: `incident-${i}`, actor: `builder-${i}` },
          async () => {
            if (i) throw new ForgeError('WORK_STALE', 'Concurrent compose revision changed.');
            // The request boundary records only the final outcome.
            try {
              throw new ForgeError('WORK_BUSY', 'internal retry');
            } catch {
              /* retry succeeded */
            }
            return { result: { status: 'accepted' } };
          },
        ),
      ),
    );
    const receipts = readSelfMetricReceipts(directory);
    const result = calculateSelfMetrics(
      {
        moves: [],
        submissions: [],
        runs: [],
        receipts,
        gaps: [],
        coverage: { lifecycle: '2000-01-01T00:00:00.000Z' },
      },
      { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' },
    );
    assert.equal(result.metric2.finishes, 8);
    assert.equal(result.metric2.errors, 7);
    assert.deepEqual(result.metric2.byCode, [
      { code: 'WORK_STALE', count: 7, per100Finishes: 87.5, noOwner: null },
    ]);
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a torn receipt append preserves complete history and counts partial coverage without writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-m1-torn-'));
  writeFileSync(join(root, 'file.txt'), 'fixture\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    directory = agent.work.store.directory;
  try {
    await agent.dispatch({ action: 'start', outcome: 'complete receipt' });
    const complete = readSelfMetricReceipts(directory);
    const bytes = readFileSync(selfMetricsJournalPath(directory), 'utf8') + '{"schema":1';
    writeFileSync(selfMetricsJournalPath(directory), bytes);
    const before = tree(join(root, '.forge'));
    assert.deepEqual(readSelfMetricReceipts(directory), complete);
    assert.equal(readSelfMetricJournal(directory).incompleteTrailingRecords, 1);
    const output = await readSelfMetrics(nativeSelfMetricsReader(root), {
      from: '2000-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
    });
    assert.equal(output.incompleteReceiptRecords, 1);
    for (const metric of ['metric2', 'metric3', 'metric5', 'metric6']) {
      assert.equal(output[metric].partial, true);
      assert.ok(output[metric].gaps.some(gap => gap.includes('1 incomplete trailing')));
    }
    assert.deepEqual(tree(join(root, '.forge')), before);
    writeFileSync(selfMetricsJournalPath(directory), '{"schema":1');
    assert.deepEqual(readSelfMetricJournal(directory), { receipts: [], incompleteTrailingRecords: 1 });
    writeFileSync(selfMetricsJournalPath(directory), '{"schema":1\n');
    assert.throws(() => readSelfMetricReceipts(directory), SyntaxError);
  } finally {
    await cleanupOwner(root);
  }
});

test('only published Work writes emit mutation receipts with their committed revision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-m1-commit-'));
  writeFileSync(join(root, 'file.txt'), 'fixture\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  const path = selfMetricsJournalPath(store.directory);
  try {
    unlinkSync(path);
    store.locked(() => store.commitRecords(store.records()));
    assert.equal(existsSync(path), false);
    const invalid = store.load();
    invalid.schema = 999;
    assert.throws(
      () => store.save(invalid),
      error => error.code === 'WORK_UPGRADE_REQUIRED',
    );
    assert.throws(
      () =>
        store.locked(() => {
          const tx = store.records();
          tx.manifest.fields.nativeHead = 'f'.repeat(64);
          throw new Error('abort before publish');
        }),
      /abort before publish/,
    );
    assert.equal(existsSync(path), false);

    const stale = store.records(),
      tx = store.records();
    const revision = tx.revision;
    tx.manifest.fields.nativeHead = 'b'.repeat(64);
    // An explicit same-revision publication is still a real write.
    store.locked(() => store.commitRecords(tx, revision));
    assert.deepEqual(
      readSelfMetricReceipts(store.directory).map(r => r.revision),
      [revision],
    );
    const before = readFileSync(path);
    assert.throws(
      () => store.locked(() => store.commitRecords(stale)),
      error => error.code === 'WORK_STALE',
    );
    assert.deepEqual(readFileSync(path), before);

    const failed = join(root, 'failed-publication');
    mkdirSync(join(failed, 'records'), { recursive: true });
    mkdirSync(join(failed, 'work.json'));
    assert.throws(() => publishRecords(failed, tx.manifest));
    assert.equal(existsSync(selfMetricsJournalPath(failed)), false);
  } finally {
    await cleanupOwner(root);
  }
});

test('lifecycle format refusals and pre-store BAD_ARGUMENT failures create no metric file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-m1-refusal-'));
  try {
    for (const action of ['start', 'checkpoint', 'sync', 'finish', 'land']) {
      for (const code of ['WORK_UPGRADE_REQUIRED', 'INVALID_WORK_STORE', 'BAD_ARGUMENT']) {
        await assert.rejects(
          () =>
            withLifecycleMetric(root, { action }, async () => {
              throw new ForgeError(code, 'refused');
            }),
          error => error.code === code,
        );
        assert.deepEqual(readdirSync(root), []);
      }
    }
    const workflow = Object.create(AgentWorkflow.prototype);
    Object.defineProperty(workflow, 'work', {
      get() {
        throw new Error('Work must not be read');
      },
    });
    await assert.rejects(
      () => workflow.dispatch({ action: 'start' }),
      error => error.code === 'BAD_ARGUMENT',
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(root, { recursive: true, force: true });
  }
});

test('M2 workflow saves record path overlaps and response delivery without treating sync as another save', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-m2-save-'));
  writeFileSync(join(root, 'shared.ts'), 'export const a = 1;\nexport const b = 1;\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  try {
    const a = (await agent.dispatch({ action: 'start', outcome: 'first peer' })).result;
    const b = (await agent.dispatch({ action: 'start', outcome: 'second peer' })).result;
    writeFileSync(join(a.path, 'shared.ts'), 'export const a = 2;\nexport const b = 1;\n');
    await agent.dispatch({ action: 'checkpoint', laneId: a.laneId, expectedHead: a.head, message: 'A save' });
    writeFileSync(join(b.path, 'shared.ts'), 'export const a = 3;\nexport const b = 1;\n');
    const saved = (
      await agent.dispatch({
        action: 'checkpoint',
        laneId: b.laneId,
        expectedHead: b.head,
        message: 'B save',
      })
    ).result;
    const receipts = readSelfMetricReceipts(agent.work.store.directory);
    const observation = receipts.find(
      r => r.observation?.type === 'save' && r.observation.laneId === b.laneId,
    )?.observation;
    assert.ok(observation);
    assert.ok(
      observation.overlaps.some(peer => peer.laneId === a.laneId && peer.paths.includes('shared.ts')),
    );
    assert.ok(
      receipts.some(r => r.observation?.type === 'overlap-delivery' && r.observation.head === saved.head),
    );
    const result = await readSelfMetrics(nativeSelfMetricsReader(root), {
      from: '2000-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
    });
    assert.equal(result.metric4.overlappingSaves, 1);
    assert.equal(result.metric4.delivered, 1);
    assert.ok(result.metric7.modes[0].rows.length > 0);
    assert.ok(result.disk.sample);
  } finally {
    await cleanupOwner(root);
  }
});

test('a delivered superseded presentation retains its actual terminal outcome for metric 3', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-q2-delivery-'));
  try {
    const operationId = randomUUID();
    await withLifecycleMetric(root, { action: 'land', operationId }, async () => ({
      result: {
        submissions: [
          { entryOperationId: 'failed', state: 'superseded', outcome: 'terminal-failed' },
          { entryOperationId: 'landed', state: 'superseded', outcome: 'landed' },
          { entryOperationId: 'pending', state: 'superseded', outcome: 'pending' },
        ],
      },
    }));
    const receipts = readSelfMetricReceipts(root);
    assert.deepEqual(receipts.at(-1).deliveries, [
      { entryId: 'failed', state: 'terminal-failed' },
      { entryId: 'landed', state: 'landed' },
    ]);
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(root, { recursive: true, force: true });
  }
});
