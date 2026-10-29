// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkRecordTransaction } from '../dist/work-record-transaction.js';
import { NativeSource } from '../dist/native-source.js';
import { PeersCache } from '../dist/agent-peers-cache.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { checkEnvironment } from '../dist/work-run.js';

function fixture(t, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'forge-status-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.txt'), 'synthetic\n');
  const { head } = initNative(root),
    store = new WorkStore(root),
    at = new Date().toISOString();
  const intentId = randomUUID(),
    lanes = [];
  store.locked(() => {
    const tx = store.records();
    tx.append('intents', {
      id: intentId,
      outcome: 'Committed intent',
      constraints: '',
      base: head,
      status: 'active',
      notes: [],
      createdAt: at,
    });
    for (let i = 0; i < count; i++) {
      const id = randomUUID(),
        viewId = randomUUID();
      lanes.push(id);
      tx.append('lanes', {
        id,
        intentId,
        name: `Committed Lane ${i}`,
        base: head,
        head,
        assignment: '',
        target: '',
        state: 'active',
        checkpoints: [],
      });
      tx.append('views', {
        id: viewId,
        intentId,
        base: head,
        head,
        status: 'clean',
        inputs: [{ laneId: id, head }],
        details: 'Synthetic retained diff\n'.repeat(1000),
        at,
      });
    }
    store.commitRecords(tx);
  });
  return { root, store, head, intentId, lanes };
}

test('default summaries page headers and never hydrate history, source, costs or submission journals', async t => {
  const f = fixture(t, 25),
    agent = new AgentWorkflow(f.root);
  for (const directory of ['agent-land', 'agent-finish']) {
    mkdirSync(join(f.store.directory, directory), { recursive: true });
    writeFileSync(join(f.store.directory, directory, `${randomUUID()}.json`), 'not valid JSON');
  }
  const counters = [
    t.mock.method(f.store, 'locked', () => {
      throw Error('Read attempted writer admission');
    }),
    t.mock.method(f.store, 'load', () => {
      throw Error('Read hydrated Work');
    }),
    t.mock.method(agent.work.store, 'load', () => {
      throw Error('Read hydrated Work');
    }),
    t.mock.method(WorkRecordTransaction.prototype, 'at', () => {
      throw Error('Read hydrated a record');
    }),
    t.mock.method(NativeSource.prototype, 'state', () => {
      throw Error('Read scanned source');
    }),
    t.mock.method(PeersCache.prototype, 'read', () => {
      throw Error('Read rebuilt costs or peers');
    }),
    t.mock.method(PeersCache.prototype, 'write', () => {
      throw Error('Read indexed peers');
    }),
  ];
  const reads = t.mock.method(WorkRecordTransaction.prototype, 'fieldsAt');
  const status = (await agent.dispatch({ action: 'status', limit: 3 })).result;
  assert.equal(status.lanes.total, 25);
  assert.equal(status.lanes.items.length, 3);
  assert.equal(status.lanes.nextOffset, 3);
  assert.equal(status.intents.items[0].lanes.length, 3);
  assert.equal(status.intents.items[0].lanePage.total, 25);
  assert.equal(status.views.items[0].inputs.length, 1);
  assert.ok(status.sections.skipped.includes('costs'));
  assert.ok(reads.mock.callCount() < 25, 'only requested pages and their selected references are read');
  const pending = readPendingStatus(f.store, undefined, undefined, { limit: 3 });
  assert.equal(pending.pagination.lanes.total, 25);
  assert.equal(pending.pagination.lanes.nextOffset, 3);
  assert.equal(pending.lanes.length, 3);
  assert.deepEqual(pending.queue.items, []);
  assert.equal(pending.queue.total, 0);
  assert.ok(pending.sections.skipped.includes('overlap'));
  assert.equal(pending.overlap.coverage, 'unknown');
  assert.ok(pending.metrics, 'M3 metrics headline survives the bounded summary read');
  assert.match(formatPendingStatus(pending), /Metrics · last 7 days/);
  assert.match(formatPendingStatus(pending), /Skipped: .*use --detail/);
  const next = readPendingStatus(f.store, undefined, undefined, { offset: 3, limit: 3 });
  assert.ok(next.lanes.every(lane => !pending.lanes.some(previous => previous.laneId === lane.laneId)));
  for (const counter of counters) assert.equal(counter.mock.callCount(), 0);
});

test('pending and agent status read the last committed revision while a separate writer stages changes', async t => {
  const f = fixture(t),
    agent = new AgentWorkflow(f.root),
    revision = f.store.revision();
  const release = join(f.root, 'release-holder');
  const script = `import { WorkStore } from ${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)};
    import { existsSync } from 'node:fs';
    const store = new WorkStore(${JSON.stringify(f.root)});
    store.locked(() => {
      const tx = store.records();
      tx.patchFields('intents', ${JSON.stringify(f.intentId)}, {outcome:'Uncommitted intent'});
      tx.patchFields('lanes', ${JSON.stringify(f.lanes[0])}, {name:'Uncommitted Lane'});
      process.send('ready');
      const end = Date.now()+5000;
      while(!existsSync(${JSON.stringify(release)}) && Date.now()<end)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      tx.commit();
    });
    process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  t.after(() => child.kill());
  await once(child, 'message');
  try {
    const pending = readPendingStatus(f.store);
    const status = await agent.dispatch({ action: 'status' });
    assert.ok(existsSync(join(f.store.directory, 'lock')), 'reader returned before holder released');
    assert.equal(pending.snapshot.workRevision, revision);
    assert.equal(pending.lanes[0].name, 'Committed Lane 0');
    assert.equal(status.revision, revision);
    assert.equal(status.result.intents.items[0].outcome, 'Committed intent');
  } finally {
    writeFileSync(release, 'release');
    assert.equal((await exited)[0], 0);
  }
  assert.equal(readPendingStatus(f.store).snapshot.workRevision, revision + 1);
});

test('explicit pending detail still reads the retained submission section', t => {
  const f = fixture(t);
  mkdirSync(join(f.store.directory, 'agent-land'));
  writeFileSync(join(f.store.directory, 'agent-land', `${randomUUID()}.json`), 'not valid JSON');
  assert.doesNotThrow(() => readPendingStatus(f.store));
  assert.throws(() => readPendingStatus(f.store, undefined, undefined, { detail: true }), SyntaxError);
});

test('active checks and current main remain visible outside the recent history page', t => {
  const f = fixture(t),
    at = new Date().toISOString(),
    runId = randomUUID();
  f.store.locked(() => {
    const tx = f.store.records(),
      viewId = tx.fieldsAt('views', 0).record.id;
    const run = {
      id: runId,
      viewId,
      base: f.head,
      head: f.head,
      inputs: [],
      dependencies: [],
      check: {
        id: randomUUID(),
        name: 'Synthetic',
        executable: process.execPath,
        args: [],
        environmentLabel: '',
        definition: 'a'.repeat(64),
        at,
      },
      environment: checkEnvironment(),
      runner: { pid: process.pid, host: 'synthetic' },
      status: 'running',
      startedAt: at,
      details: '',
    };
    tx.append('runs', run);
    for (let i = 0; i < 3; i++)
      tx.append('runs', { ...run, id: randomUUID(), status: 'passed', endedAt: at });
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId,
      head: f.head,
      previous: null,
      status: 'accepted',
      provenance: 'user-declared-local',
      at,
    });
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'other',
      viewId,
      head: 'b'.repeat(64),
      previous: null,
      status: 'accepted',
      provenance: 'user-declared-local',
      at,
    });
    f.store.commitRecords(tx);
  });
  const pending = readPendingStatus(f.store, undefined, undefined, { limit: 1 });
  assert.equal(pending.main.head, f.head);
  assert.equal(pending.metrics.landings, 1, 'metrics retain the indexed main acceptance outside the page');
  assert.equal(pending.checks[0].runId, runId);
  assert.equal(pending.pagination.activeChecks.total, 1);
  assert.equal(pending.pagination.runs.total, 4);
});

test('summary save counts use the header while explicit detail retains the saved history', t => {
  const f = fixture(t),
    at = new Date().toISOString();
  f.store.locked(() => {
    const tx = f.store.records();
    tx.appendField('lanes', f.lanes[0], 'checkpoints', {
      head: f.head,
      parent: f.head,
      message: 'Synthetic retained save',
      at,
    });
    f.store.commitRecords(tx);
  });
  const summary = readPendingStatus(f.store);
  assert.equal(summary.lanes[0].checkpointCount, 1);
  assert.equal(summary.lanes[0].lastCheckpointAt, at);
  assert.deepEqual(summary.lanes[0].checkpoints, []);
  const detail = readPendingStatus(f.store, undefined, undefined, { detail: true });
  assert.equal(detail.lanes[0].checkpoints[0].message, 'Synthetic retained save');
  assert.equal(detail.lanes[0].checkpointCount, 1);
});

test('top-level paging does not drop pins from an eight-Lane Candidate', async t => {
  const f = fixture(t, 8),
    agent = new AgentWorkflow(f.root),
    viewId = randomUUID();
  f.store.locked(() => {
    const tx = f.store.records();
    tx.append('views', {
      id: viewId,
      intentId: f.intentId,
      base: f.head,
      head: f.head,
      inputs: f.lanes.map(laneId => ({ laneId, head: f.head })),
      status: 'clean',
      details: '',
      at: new Date().toISOString(),
    });
    f.store.commitRecords(tx);
  });
  const status = (await agent.dispatch({ action: 'status', limit: 1 })).result;
  assert.equal(status.views.items.length, 1);
  assert.equal(status.views.items[0].inputCount, 8);
  assert.equal(status.views.items[0].inputs.length, 8);
  assert.equal(status.views.items[0].inputsMore, false);
});

test('legacy validation does not implicitly enable expensive status sections', async t => {
  const f = fixture(t),
    agent = new AgentWorkflow(f.root);
  writeFileSync(join(f.store.directory, 'work.json'), f.store.snapshotBytes());
  mkdirSync(join(f.store.directory, 'agent-land'));
  writeFileSync(join(f.store.directory, 'agent-land', `${randomUUID()}.json`), 'not valid JSON');
  const source = t.mock.method(NativeSource.prototype, 'state', () => {
    throw Error('Unexpected source detail');
  });
  const status = (await agent.dispatch({ action: 'status' })).result;
  assert.equal(status.readMode, 'legacy-complete-validation');
  assert.ok(status.sections.skipped.includes('submissions'));
  assert.equal(status.lanes.items.length, 1);
  assert.equal(source.mock.callCount(), 0);
});
