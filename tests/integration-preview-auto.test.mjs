// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { integrationPreview, previewPinned } from '../dist/integration-preview.js';
import {
  scheduleIntegrationPreview,
  drainIntegrationPreviews,
  integrationPreviewStatus,
} from '../dist/integration-preview-auto.js';
import { previewLanding } from '../dist/integration-preview-landing.js';
import { LandJournal } from '../dist/land-journal.js';
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
    await policy({ integrationPreview: { auto: false } });
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
  assert.equal(integrationPreview(f.store, {}).result.cached, true);
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
  const status = readPendingStatus(f.store);
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

test('preflight uses pinned inputs after live heads change, cache hits, and skip never excludes', async t => {
  const f = await fixture(t);
  await f.policy({ integrationPreview: { auto: true } });
  const pins = [f.a, f.b].map(lane => ({ laneId: lane.laneId, head: lane.head }));
  const preview = previewLanding(f.store, pins);
  assert.deepEqual(
    preview.excluded.map(item => item.laneId),
    [f.b.laneId],
  );
  assert.match(preview.excluded[0].errors.join('\n'), /synthetic pair clash/);
  assert.equal(previewPinned(f.store, undefined, pins).result.cached, true);
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
  assert.equal(f.store.load().runs.length, 0);
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

test('requests during a preview drain again; execution errors remain visible without an idle retry loop', async t => {
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
  assert.equal(runs, 2);
  assert.match(integrationPreviewStatus(f.store), /unavailable.*INTEGRATION_CHECK_ERROR/);
  await drainIntegrationPreviews(
    f.store,
    () => {
      runs++;
    },
    0,
  );
  assert.equal(runs, 2);
});
