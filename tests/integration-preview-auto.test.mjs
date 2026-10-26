// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createHook } from 'node:async_hooks';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { updateHostState } from '../dist/host-binding.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { overlapNotifications } from '../dist/mcp-overlap-notifications.js';
import { agentWait } from '../dist/agent-wait.js';
import { integrationPreview, previewPinned } from '../dist/integration-preview.js';
import {
  scheduleIntegrationPreview,
  drainIntegrationPreviews,
  integrationPreviewStatus,
} from '../dist/integration-preview-auto.js';
import { previewLanding } from '../dist/integration-preview-landing.js';
import { LandJournal } from '../dist/land-journal.js';
import { unfinishedFinishes } from '../dist/agent-finish-journal.js';
import { watchLandingWorker } from '../dist/landing-worker.js';
import { agentPeers } from '../dist/agent-peers.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { enqueueLanding, selectBatch, composeBatch, batchEdit } from '../dist/landing-batch-store.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { drainPostAccept } from '../dist/post-accept-main.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (predicate()) return;
    assert.ok(Date.now() < deadline, 'finite preview worker did not settle');
    await sleep(20);
  }
}
async function fixture(t, { schema = false, configured = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-auto-preview-'));
  writeFileSync(join(root, 'a.txt'), '0');
  writeFileSync(join(root, 'b.txt'), '0');
  if (schema) {
    mkdirSync(join(root, 'convex'));
    writeFileSync(
      join(root, 'convex/schema.ts'),
      `defineSchema({
 table: defineTable({})
 // slot a
 // spacer one
 // spacer two
 // slot b
});
`,
    );
  }
  const initial = initNative(root),
    agent = new AgentWorkflow(root),
    store = agent.work.store;
  const check = configured
    ? (
        await agent.dispatch({
          action: 'define-check',
          name: 'verify',
          static: true,
          executable: process.execPath,
          args: [
            '-e',
            `const fs=require('node:fs'); if(fs.readFileSync('a.txt','utf8')==='1' && fs.readFileSync('b.txt','utf8')==='1') { console.error('synthetic pair clash'); process.exit(1); }`,
          ],
        })
      ).result
    : undefined;
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: initial.head,
      previous: null,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
  const policy = fields => agent.dispatch({ action: 'set-policy', operationId: randomUUID(), ...fields });
  const start = async () => (await agent.dispatch({ action: 'start', outcome: 'Synthetic preview' })).result;
  const save = async (lane, path, text) => {
    writeFileSync(join(lane.path, path), text);
    const result = (
      await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Synthetic save' })
    ).result;
    lane.head = result.head;
    return result;
  };
  const a = await start(),
    b = await start();
  await save(a, 'a.txt', '1');
  await save(b, 'b.txt', '1');
  t.after(async () => {
    await drainPostAccept(store);
    await drainIntegrationPreviews(store, undefined, 0);
    // A detached preview or post-accept worker may still hold Work briefly under the zero test lock wait.
    for (let attempt = 0; ; attempt++) {
      try {
        await policy({ integrationPreview: { auto: false } });
        break;
      } catch (error) {
        if (error?.code !== 'WORK_BUSY' || attempt >= 300) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    // Any already launched finite worker observes policy off before teardown.
    await new Promise(resolve => setImmediate(resolve));
    await drainIntegrationPreviews(store, undefined, 0);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, agent, store, check, a, b, policy, start, save };
}

test('policy defaults off, edits persist and off schedules no process or timer', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.agent.dispatch({ action: 'policy' })).result.integrationPreview, { auto: false });
  let launches = 0;
  scheduleIntegrationPreview(f.store, () => {
    launches++;
    throw new Error('should not launch');
  });
  let runs = 0;
  await drainIntegrationPreviews(
    f.store,
    () => {
      runs++;
      throw new Error('should not run');
    },
    0,
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0);
  assert.equal(runs, 0);
  assert.equal(integrationPreviewStatus(f.store), undefined);
  await f.policy({ integrationPreview: { auto: true } });
  await f.policy({ notify: { awaySummary: false } });
  assert.deepEqual((await f.agent.dispatch({ action: 'policy' })).result.integrationPreview, { auto: true });
});

test('a burst coalesces into one run and finite drain leaves no idle timer', async t => {
  const f = await fixture(t);
  await f.policy({ integrationPreview: { auto: true } });
  let launches = 0,
    runs = 0;
  const fakeLaunch = () => {
    launches++;
    return { on() {}, unref() {} };
  };
  for (let i = 0; i < 8; i++) scheduleIntegrationPreview(f.store, fakeLaunch);
  await new Promise(resolve => setImmediate(resolve));
  const timersBefore = process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  await drainIntegrationPreviews(
    f.store,
    () => {
      runs++;
      return integrationPreview(f.store, {}).result;
    },
    25,
  );
  await drainIntegrationPreviews(
    f.store,
    () => {
      runs++;
      throw new Error('idle must not run');
    },
    25,
  );
  assert.equal(launches, 1);
  assert.equal(runs, 1);
  assert.equal(process.getActiveResourcesInfo().filter(name => name === 'Timeout').length, timersBefore);
  assert.match(integrationPreviewStatus(f.store), /^clash/);
  assert.equal(integrationPreview(f.store, {}).result.cached, false);
});

test('checkpoint replies before background check and both Lanes receive notices; worker exits', async t => {
  const f = await fixture(t);
  await f.policy({ integrationPreview: { auto: true } });
  const saved = await f.agent.dispatch({
    action: 'checkpoint',
    laneId: f.b.laneId,
    message: 'Unchanged save',
  });
  assert.equal(saved.result.head, f.b.head);
  assert.match(integrationPreviewStatus(f.store), /^queued/);
  await until(() => integrationPreviewStatus(f.store)?.startsWith('clash'));
  for (const lane of [f.a, f.b]) {
    const peers = agentPeers(f.store, { laneId: lane.laneId, detail: true });
    assert.match(peers.integration, /^clash/);
    assert.ok(peers.notices.some(notice => notice.text.includes('synthetic pair clash')));
  }
  const status = readPendingStatus(f.store, undefined, undefined, { detail: true });
  assert.match(formatPendingStatus(status), /Main: .*Integration preview: clash/);
  assert.ok(formatPendingStatus(status).split('\n').length <= 15);
  const child = spawn(process.execPath, [resolve('dist/integration-preview-worker.js'), f.root], {
    stdio: 'pipe',
  });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('idle worker kept running'));
    }, 5000);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(code, 0);
});

test('successful sync schedules a preview and input changes invalidate current status', async t => {
  const f = await fixture(t);
  await f.policy({ integrationPreview: { auto: true } });
  const result = await f.agent.dispatch({ action: 'sync', laneId: f.a.laneId });
  assert.equal(result.result.status, 'up-to-date');
  assert.match(integrationPreviewStatus(f.store), /^queued/);
  await until(() => integrationPreviewStatus(f.store)?.startsWith('clash'));
  await f.save(f.b, 'b.txt', '0');
  assert.match(integrationPreviewStatus(f.store), /^queued/);
  await until(() => integrationPreviewStatus(f.store)?.startsWith('clean'));
});

test('preflight uses pinned inputs after live heads change, historical evidence, and skip never excludes', async t => {
  const f = await fixture(t);
  await f.policy({ integrationPreview: { auto: true } });
  const pins = [f.a, f.b].map(lane => ({ laneId: lane.laneId, head: lane.head }));
  const preview = previewLanding(f.store, pins);
  assert.deepEqual(
    preview.excluded.map(item => item.laneId),
    [f.b.laneId],
  );
  assert.match(preview.excluded[0].errors.join('\n'), /synthetic pair clash/);
  assert.equal(previewPinned(f.store, undefined, pins).result.cached, false);
  const command = {
    action: 'land',
    operationId: randomUUID(),
    laneIds: [f.a.laneId, f.b.laneId],
    channel: 'main',
  };
  new LandJournal(f.store, command); // Simulate a stop after request pins are saved, before preview.
  await f.save(f.b, 'b.txt', '0');
  const recovered = new LandJournal(f.store, command);
  recovered.preflight(f.store, command);
  assert.equal(recovered.state.preview.key, preview.key);
  assert.equal(
    recovered.state.entries.find(entry => entry.result?.status === 'preview-excluded').inputs[0].head,
    pins[1].head,
  );
  assert.equal(previewLanding(f.store, pins).key, preview.key);
  assert.equal(previewLanding(f.store, pins, { skip: true }), undefined);
});

test('land excludes a clashing Lane with pinned diagnostic and checks only the safe selection', async t => {
  const f = await fixture(t);
  await f.policy({ preset: 'trusted', checks: { runner: 'local' }, integrationPreview: { auto: true } });
  const result = (
    await f.agent.dispatch({ action: 'land', laneIds: [f.a.laneId, f.b.laneId], keepOpen: true })
  ).result;
  assert.equal(result.counts.accepted, 1);
  assert.equal(result.counts['preview-excluded'], 1);
  const rejected = result.entries.find(entry => entry.status === 'preview-excluded');
  assert.equal(rejected.inputs[0].laneId, f.b.laneId);
  assert.equal(rejected.preview.excluded[0].head, f.b.head);
  assert.match(rejected.preview.excluded[0].errors.join('\n'), /synthetic pair clash/);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
  const overridden = (
    await f.agent.dispatch({ action: 'land', laneIds: [f.b.laneId], preview: 'skip', keepOpen: true })
  ).result;
  assert.equal(overridden.entries[0].status, 'failed');
  assert.notEqual(overridden.entries[0].code, 'INTEGRATION_PREVIEW_EXCLUDED');
});

test('finish excludes a failing individual without a landing check, with a new-operation skip override', async t => {
  const f = await fixture(t);
  await f.save(f.a, 'b.txt', '1');
  await f.policy({ preset: 'trusted', integrationPreview: { auto: true } });
  const result = (
    await f.agent.dispatch({ action: 'finish', laneId: f.a.laneId, message: 'Fail alone', accept: true })
  ).result;
  assert.equal(result.status, 'preview-excluded');
  assert.equal(result.preview.excluded[0].laneId, f.a.laneId);
  assert.equal(f.store.load().runs.length, 0);
  const skip = (
    await f.agent.dispatch({
      action: 'finish',
      laneId: f.a.laneId,
      message: 'Override',
      accept: true,
      preview: 'skip',
    })
  ).result;
  assert.equal(skip.status, 'failed');
  assert.equal(f.store.load().runs.length, 1);
});

test('owner worker preserves preview exclusion and skip override for admitted finish', async t => {
  const f = await fixture(t);
  await f.save(f.a, 'b.txt', '1');
  await f.policy({ preset: 'trusted', checks: { runner: 'local' }, integrationPreview: { auto: true } });
  const controller = new AbortController();
  const worker = watchLandingWorker(f.store, controller.signal);
  try {
    for (const skip of [false, true]) {
      const command = {
        action: 'finish',
        operationId: randomUUID(),
        laneId: f.a.laneId,
        message: skip ? 'Override admitted preview' : 'Admitted preview',
        accept: true,
        wait: false,
        ...(skip ? { preview: 'skip' } : {}),
      };
      const admitted = (await f.agent.dispatch(command)).result;
      assert.equal(admitted.durable, true);
      await until(() => !unfinishedFinishes(f.store).length);
      const result = (await f.agent.dispatch(command)).result;
      assert.equal(result.status, skip ? 'failed' : 'preview-excluded');
      if (!skip) assert.equal(result.preview.excluded[0].laneId, f.a.laneId);
      assert.equal(f.store.load().runs.length, skip ? 1 : 0);
    }
  } finally {
    controller.abort();
    await worker;
  }
});

test('actual queue batch catches independent submissions and respects skip for an entry', async t => {
  const f = await fixture(t);
  await f.policy({ preset: 'trusted', checks: { runner: 'local' }, integrationPreview: { auto: true } });
  for (const lane of [f.a, f.b]) {
    const view = (
      await f.agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: lane.head }],
        dependencies: [],
      })
    ).result;
    // The combined preview is exercised after each input has its solo gate.
    await f.agent.dispatch({ action: 'run', viewId: view.viewId });
    await enqueueLanding(
      f.agent.work,
      {
        operationId: randomUUID(),
        action: 'finish',
        laneId: lane.laneId,
        expectedHead: lane.head,
        message: 'Queue preview',
        dependencies: [],
        checkId: f.check.checkId,
        expectedDefinition: f.check.definition,
        expectedEnvironment: checkEnvironment().fingerprint,
        accept: { channel: 'main', expectedPrevious: f.store.load().channelMoves[0].head },
        ...(lane === f.b ? { preview: 'skip' } : {}),
      },
      f.store.select('views', view.viewId),
    );
  }
  const batch = await batchEdit(f.agent.work, 'fixture', data => selectBatch(f.agent.work, data, 'main'));
  const composed = await composeBatch(f.agent.work, batch);
  assert.equal(composed.prefixes.length, 1);
  const entries = f.store.load().landingEntries;
  assert.equal(entries[0].status, 'failed');
  assert.equal(entries[0].previewDiagnostic.laneId, f.a.laneId);
  assert.match(entries[0].previewDiagnostic.errors.join('\n'), /synthetic pair clash/);
  assert.equal(entries[1].status, 'checking');
  assert.equal(entries[1].preview, 'skip');
  assert.equal(f.store.load().runs.length, 2, 'only the two solo checks ran');
});

test('built-in Convex source validation catches a merge-only duplicate without configured commands', async t => {
  const f = await fixture(t, { schema: true, configured: false });
  for (const [lane, slot, expression] of [
    [f.a, 'a', ".index('same', [])"],
    [f.b, 'b', '.searchIndex("same", {})'],
  ]) {
    const path = join(lane.path, 'convex/schema.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace(`// slot ${slot}`, expression));
    await f.save(lane, lane === f.a ? 'a.txt' : 'b.txt', '1');
  }
  const result = integrationPreview(f.store, {}).result;
  assert.equal(result.status, 'clash');
  assert.equal(result.checks.length, 0);
  assert.equal(result.pairs.length, 1);
  assert.ok(result.individual.every(item => item.result.status === 'passed'));
  assert.match(result.pairs[0].errors.join('\n'), /duplicate index name/);
  assert.equal(existsSync(join(f.a.path, 'convex/schema.ts')), true);
});

test('duplicate requests during a preview do not retry execution errors or start an idle loop', async t => {
  const f = await fixture(t);
  await f.policy({ integrationPreview: { auto: true } });
  const fakeLaunch = () => ({ on() {}, unref() {} });
  scheduleIntegrationPreview(f.store, fakeLaunch);
  let runs = 0;
  await drainIntegrationPreviews(
    f.store,
    () => {
      runs++;
      if (runs === 1) scheduleIntegrationPreview(f.store, fakeLaunch);
      throw Object.assign(new Error('synthetic unavailable compiler'), { code: 'INTEGRATION_CHECK_ERROR' });
    },
    0,
  );
  assert.equal(runs, 1, 'duplicate wake during execution does not repeat a failed tuple');
  assert.match(integrationPreviewStatus(f.store), /unavailable.*INTEGRATION_CHECK_ERROR/);
  await drainIntegrationPreviews(
    f.store,
    () => {
      runs++;
    },
    0,
  );
  assert.equal(runs, 1);
});

test('duplicate saved heads after completion do not execute again or replace the request', async t => {
  const f = await fixture(t);
  await f.policy({ integrationPreview: { auto: true } });
  const fakeLaunch = () => ({ on() {}, unref() {} });
  scheduleIntegrationPreview(f.store, fakeLaunch);
  await drainIntegrationPreviews(f.store, undefined, 0);
  const request = readFileSync(join(f.store.directory, 'integration-preview-request.json'), 'utf8');
  let launches = 0,
    runs = 0;
  for (let i = 0; i < 4; i++) {
    await f.agent.dispatch({ action: 'checkpoint', laneId: f.b.laneId, message: 'Duplicate save' });
    scheduleIntegrationPreview(f.store, () => {
      launches++;
      return fakeLaunch();
    });
  }
  await new Promise(resolve => setImmediate(resolve));
  await drainIntegrationPreviews(
    f.store,
    () => {
      runs++;
      throw new Error('duplicate tuple ran');
    },
    0,
  );
  assert.equal(readFileSync(join(f.store.directory, 'integration-preview-request.json'), 'utf8'), request);
  assert.equal(launches, 0);
  assert.equal(runs, 0);
});

test('new heads during a running preview coalesce to the latest tuple and late notices stay historical', async t => {
  const f = await fixture(t);
  await f.policy({ integrationPreview: { auto: true } });
  const fakeLaunch = () => ({ on() {}, unref() {} });
  scheduleIntegrationPreview(f.store, fakeLaunch);
  let runs = 0;
  const observed = [];
  await drainIntegrationPreviews(
    f.store,
    async () => {
      runs++;
      const result = integrationPreview(f.store, {}).result;
      observed.push(result);
      if (runs === 1) {
        // Two publications arrive before the controller returns the old observation.
        await f.save(f.b, 'b.txt', '2');
        await f.save(f.b, 'b.txt', '0');
        assert.equal(
          new CoordinationJournal(f.store)
            .context(f.a.laneId)
            .messages.filter(row => row.actor === 'Integration preview').length,
          0,
        );
      }
      return result;
    },
    0,
  );
  assert.equal(runs, 2);
  assert.equal(observed[0].status, 'clash');
  assert.equal(observed[1].status, 'clean');
  assert.equal(observed[1].inputs.find(pin => pin.laneId === f.b.laneId).head, f.b.head);
  assert.equal(
    new CoordinationJournal(f.store).context(f.a.laneId).notices[0].integration.applicability,
    'historical',
  );
  assert.match(integrationPreviewStatus(f.store), /^clean/);
});

test('committed main changes wake a preview without a Lane save, reads and unrelated writes do not', async t => {
  const f = await fixture(t);
  await f.policy({ integrationPreview: { auto: true } });
  scheduleIntegrationPreview(f.store, () => ({ on() {}, unref() {} }));
  await drainIntegrationPreviews(f.store, undefined, 0);
  const before = readFileSync(join(f.store.directory, 'integration-preview-request.json'), 'utf8');
  f.store.load();
  readPendingStatus(f.store);
  await f.agent.dispatch({ action: 'handoff', laneId: f.a.laneId, summary: 'Unrelated delivery note' });
  assert.equal(readFileSync(join(f.store.directory, 'integration-preview-request.json'), 'utf8'), before);
  f.store.locked(() => {
    const tx = f.store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: f.a.head,
      previous: tx.all('channelMoves', 'main', 'channel').at(-1).head,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    f.store.commitRecords(tx);
  });
  assert.notEqual(readFileSync(join(f.store.directory, 'integration-preview-request.json'), 'utf8'), before);
  await drainIntegrationPreviews(f.store, undefined, 0);
  assert.equal(
    JSON.parse(readFileSync(join(f.store.directory, 'integration-preview-status.json'), 'utf8')).result.main,
    f.a.head,
  );
  assert.match(integrationPreviewStatus(f.store), /^failed/);
  // Both records-v2 and whole-Work publication paths carry the same main wake.
  f.store.locked(() => {
    const data = f.store.load();
    data.channelMoves.push({ ...data.channelMoves.at(-1), id: randomUUID(), head: f.b.head });
    data.revision++;
    f.store.save(data);
  });
  await drainIntegrationPreviews(f.store, undefined, 0);
  assert.equal(
    JSON.parse(readFileSync(join(f.store.directory, 'integration-preview-status.json'), 'utf8')).result.main,
    f.b.head,
  );
});

test('integration delivery uses the bilateral inbox, MCP next-call context and wait cursor without sessions', async t => {
  const f = await fixture(t);
  updateHostState(f.store, state => {
    state.presence = {};
    state.selfReports = {};
  });
  const sent = [];
  const notifications = overlapNotifications(
    {
      server: { registerCapabilities() {} },
      sendLoggingMessage: async row => {
        sent.push(row);
      },
    },
    f.store,
  );
  t.after(() => notifications.close());
  notifications.select(f.a.laneId);
  const result = integrationPreview(f.store, {}).result;
  assert.equal(result.notices.length, 1);
  assert.ok(result.notices[0].participants.every(p => p.sessions.length === 0));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.kind, 'integration-notice');
  assert.equal(sent[0].data.noticeId, result.notices[0].noticeId);
  assert.deepEqual(sent[0].data.inputs, result.inputs);
  notifications.select(f.a.laneId);
  assert.equal(sent.length, 1);
  // The second Lane was absent at publication; its next call receives the same notice.
  notifications.select(f.b.laneId);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].data.noticeId, sent[0].data.noticeId);
  for (const lane of [f.a, f.b]) {
    const context = new CoordinationJournal(f.store).context(lane.laneId);
    assert.equal(context.messages.filter(row => row.actor === 'Integration preview').length, 1);
    assert.ok(
      agentPeers(f.store, { laneId: lane.laneId, detail: true }).notices.some(row =>
        row.text.includes('synthetic pair clash'),
      ),
    );
  }
  const firstEvents = [];
  const first = await agentWait(f.store, { laneIds: [f.a.laneId], timeoutSeconds: 0 }, row =>
    firstEvents.push(row),
  );
  const notice = firstEvents.find(row => row.type === 'notice' && row.status === 'integration');
  assert.equal(notice.id, result.notices[0].noticeId);
  assert.equal(notice.historical, false);
  const replayEvents = [];
  const replay = await agentWait(
    f.store,
    { laneIds: [f.a.laneId], timeoutSeconds: 0, cursor: first.cursor },
    row => replayEvents.push(row),
  );
  assert.ok(!replayEvents.some(row => row.type === 'notice'));
  await f.save(f.b, 'b.txt', '0');
  const changedEvents = [];
  await agentWait(f.store, { laneIds: [f.a.laneId], timeoutSeconds: 0, cursor: replay.cursor }, row =>
    changedEvents.push(row),
  );
  assert.equal(changedEvents.find(row => row.type === 'notice' && row.id === notice.id).historical, true);
  assert.equal(sent.length, 2, 'obsolete observations do not redeliver current advice');
});

test('opt-out main and saved changes create no request, process, notice or idle timer', async t => {
  const f = await fixture(t);
  // Existing finite probe/close timers may finish during this test. Track only
  // newly created resources so unrelated teardown cannot change the baseline.
  const timers = new Set();
  const hook = createHook({
    init(id, type) {
      if (type === 'Timeout') timers.add(id);
    },
    destroy(id) {
      timers.delete(id);
    },
  }).enable();
  t.after(() => hook.disable());
  await f.save(f.b, 'b.txt', '2');
  f.store.locked(() => {
    const data = f.store.load();
    data.channelMoves.push({ ...data.channelMoves[0], id: randomUUID(), head: f.a.head });
    data.revision++;
    f.store.save(data);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(existsSync(join(f.store.directory, 'integration-preview-request.json')), false);
  assert.equal(new CoordinationJournal(f.store).context(f.a.laneId).notices.length, 0);
  hook.disable();
  assert.equal(timers.size, 0, 'opt-out leaves no newly created idle timers');
});

test('runtime drift between a wake and tuple capture finishes without an idle rerun', async t => {
  const f = await fixture(t, { configured: false });
  await f.policy({ integrationPreview: { auto: true } });
  scheduleIntegrationPreview(f.store, () => ({ on() {}, unref() {} }));
  const previous = process.env.TZ;
  let runs = 0;
  try {
    await drainIntegrationPreviews(
      f.store,
      () => {
        runs++;
        process.env.TZ = 'UTC';
        return integrationPreview(f.store, {}).result;
      },
      0,
    );
    await drainIntegrationPreviews(
      f.store,
      () => {
        throw new Error('handled wake repeated');
      },
      0,
    );
    assert.equal(runs, 1);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
