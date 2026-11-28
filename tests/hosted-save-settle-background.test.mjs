// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { testDeploymentOrigin } from './trusted-origin.mjs';
// Split save (fea47345 C): a save returns once its upload is in and it is submitted; the server
// settles it on a scheduled step, peers see its paths at once, and the checkout's next command
// applies the outcome or reports a failed settle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { withSavedList } from './hosted-overlap-list.mjs';
import { controls, environment, modules as sourceModules } from './hosted-source-efficiency-fixture.mjs';
import { ConvexExchange } from '../dist/exchange-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { saveHostedLane, settleBackgroundSave } from '../dist/hosted-save-client.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { digest } from '../dist/hash.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hostedAgentCli, sourceWaitHooks } from '../dist/hosted-agent-cli.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';

const contract = {
  overlapEvidence: false,
  submitPage: true,
  submitRun: true,
  prepareTargets: true,
  runPublish: true,
  settleBackground: true,
  durations: true,
};

async function setup(t, { fromBase = false, protectedPath = false } = {}) {
  environment(t);
  process.env.FORGE_SOURCE_PROVIDER = 'convex';
  const s = await composeFixture();
  const files = Array.from({ length: 20 }, (_, i) =>
    s.file(protectedPath && i === 0 ? 'netlify.toml' : `f${String(i).padStart(2, '0')}`, `original-${i}\n`),
  );
  const baseline = fromBase ? s.baseline : s.state(files),
    entry = await s.lane(baseline),
    state = JSON.parse(s.objects.get(baseline.sha256));
  const directory = mkdtempSync(join(tmpdir(), 'forge-settle-background-')),
    root = join(directory, 'checkout');
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: 'https://fixture.invalid',
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: s.projectId,
        laneId: entry.laneId,
        intentId: s.intentId,
        head: entry.head,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head: protectedPath ? baseline.sha256 : s.baseline.sha256, receiptId: 'main-0' },
        authority: { mode: 'server', epoch: 1 },
      },
      state,
      scope: [],
      materialized: state.files.map(file => file.path),
    }),
  );
  for (const file of state.files) writeFileSync(join(root, file.path), s.objects.get(file.blob));
  const changed = protectedPath ? ['netlify.toml'] : state.files.slice(0, 2).map(file => file.path);
  for (const path of changed) writeFileSync(join(root, path), `changed-${path}\n`);
  if (protectedPath) {
    const objects = join(clientCacheRoot(root), 'objects');
    mkdirSync(objects, { recursive: true });
    writeFileSync(join(objects, baseline.sha256), s.objects.get(baseline.sha256));
    const policy = policyPreset('trusted');
    policy.acceptance.ownerApprovalPaths = ['netlify.toml'];
    policy.agentDefaults = { preflight: 'off' };
    s.patch('hostedProjects', s.projectId, { autonomyPolicy: policy });
  }
  // The submit's scheduled work, recorded instead of run: the test runs it when it chooses.
  const scheduled = [];
  const decorate = s.decorateContext.bind(s);
  s.decorateContext = fn =>
    decorate(async (ctx, ...rest) => {
      await fn(ctx, ...rest);
      ctx.scheduler = {
        runAfter: async (ms, ref, args) => {
          scheduled.push({ ms, name: getFunctionName(ref), args });
          return 'synthetic-task';
        },
        cancel: async () => {},
      };
    });
  const c = controls(t, s);
  const exchange = new ConvexExchange(
    testDeploymentOrigin('https://fixture.invalid'),
    'synthetic',
    s.projectId,
    randomUUID(),
    null,
  );
  exchange.client = c.client;
  const overlap = () =>
    withSavedList(
      s,
      [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === entry.laneId),
    );
  const settle = async jobId => {
    const args = { projectId: s.projectId, jobId };
    await c.call('projectConvexSource:dispatch', args);
    await c.call('projectConvexSource:step', { ...args, step: 0 });
    await c.call('projectHostedSaveJobs:complete', args);
  };
  return { s, c, root, entry, exchange, scheduled, overlap, settle, changed, files: state.files.length };
}
const count = (calls, name) => calls.filter(value => value === name).length;

for (const mcp of [false, true])
  test(`diff waits for its checkout’s split save and includes the saved changes (${mcp ? 'MCP' : 'CLI'})`, async t => {
    const f = await setup(t, { fromBase: true });
    const address = { url: 'https://fixture.invalid', projectId: f.s.projectId };
    const before = readHostedLaneCheckout(f.root).selection.head;
    const saved = await new HostedAgentTransport(f.root, address, f.exchange).dispatch('save', {
      message: 'Save before diff',
    });
    assert.equal(saved.result.status, 'settling');
    assert.equal(readHostedLaneCheckout(f.root).selection.head, before);
    const transport = new HostedAgentTransport(f.root, address, f.exchange, () => ({
      onUpdate(ref, args, update, fail) {
        void (async () => {
          assert.equal(getFunctionName(ref), 'projectHostedSaves:progress');
          assert.equal(args.operationId, saved.operationId);
          const dispatch = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
          await f.settle(dispatch.args.jobId);
          update(await f.exchange.client.query(ref, args));
        })().catch(fail);
        return () => {};
      },
      async close() {},
    }));
    let diff;
    if (mcp) {
      const tools = new Map();
      t.after(
        registerHostedAgentWorkflow(
          { registerTool: (name, _options, call) => tools.set(name, call) },
          transport,
        ),
      );
      const reply = await tools.get('forge_review')({ command: { action: 'diff' } });
      diff = JSON.parse(reply.content[0].text);
    } else diff = await transport.dispatch('diff', {});
    assert.equal(diff.unsaved, undefined);
    assert.notEqual(readHostedLaneCheckout(f.root).selection.head, before);
    assert.deepEqual(diff.result.items.map(item => item.path).sort(), f.changed);
  });

test('diff names the original save replay when a split save has no submit acknowledgement', async t => {
  const f = await setup(t, { fromBase: true });
  const address = { url: 'https://fixture.invalid', projectId: f.s.projectId };
  const transport = new HostedAgentTransport(f.root, address, f.exchange);
  const saved = await transport.dispatch('save', { message: 'Interrupted save' });
  rmSync(join(clientCacheRoot(f.root), 'saves', saved.operationId, 'acknowledged'));
  transport.waitUntil = 0;
  const before = f.c.calls.length;
  await assert.rejects(transport.dispatch('diff', {}), error => {
    assert.equal(error.recovery?.next?.action, 'save');
    assert.equal(error.recovery.next.operationId, saved.operationId);
    return true;
  });
  assert.equal(f.c.calls.length, before);
});

test('diff still follows the original split save when settlement takes six seconds (P7 a12/a13)', async t => {
  const f = await setup(t, { fromBase: true });
  const address = { url: 'https://fixture.invalid', projectId: f.s.projectId };
  const saved = await new HostedAgentTransport(f.root, address, f.exchange).dispatch('save', {
    message: 'Save while other jobs settle',
  });
  assert.equal(saved.result.status, 'settling');
  let subscriptions = 0;
  const transport = new HostedAgentTransport(f.root, address, f.exchange, () => ({
    onUpdate(ref, args, update, fail) {
      subscriptions++;
      assert.equal(args.operationId, saved.operationId);
      // Advance the existing subscription's deadline without sleeping or adding reads.
      t.mock.timers.tick(6000);
      void (async () => {
        const dispatch = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
        await f.settle(dispatch.args.jobId);
        update(await f.exchange.client.query(ref, args));
      })().catch(fail);
      return () => {};
    },
    async close() {},
  }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const diff = await transport.dispatch('diff', {});
  assert.deepEqual(diff.result.items.map(item => item.path).sort(), f.changed);
  assert.equal(subscriptions, 1);
});

test('diff reports the retryable source failure and its original save command', async t => {
  const f = await setup(t, { fromBase: true });
  const address = { url: 'https://fixture.invalid', projectId: f.s.projectId };
  const saved = await new HostedAgentTransport(f.root, address, f.exchange).dispatch('save', {
    message: 'Stalled save',
  });
  const retryable = {
    status: 'retryable',
    jobId: randomUUID(),
    source: { status: 'running' },
    error: { code: 'SOURCE_JOB_STALLED', message: 'Save work stalled.' },
  };
  const transport = new HostedAgentTransport(f.root, address, f.exchange, () => ({
    onUpdate(ref, args, update) {
      assert.equal(getFunctionName(ref), 'projectHostedSaves:progress');
      assert.equal(args.operationId, saved.operationId);
      queueMicrotask(() => update(retryable));
      return () => {};
    },
    async close() {},
  }));
  await assert.rejects(transport.dispatch('diff', {}), error => {
    assert.equal(error.code, 'SOURCE_JOB_STALLED');
    assert.equal(error.recovery?.next?.action, 'save');
    assert.equal(error.recovery.next.operationId, saved.operationId);
    return true;
  });
});

test('a cold-base save warns about a captured change to a protected file', async t => {
  const f = await setup(t, { protectedPath: true });
  const marker = readHostedLaneCheckout(f.root);
  rmSync(join(clientCacheRoot(f.root), 'objects', marker.selection.base.head));
  const address = { url: 'https://fixture.invalid', projectId: f.s.projectId };
  const out = [];
  t.mock.method(process.stderr, 'write', line => {
    out.push(String(line));
    return true;
  });
  const reply = await new HostedAgentTransport(f.root, address, f.exchange).dispatch('save', {
    message: 'Protected change',
  });
  assert.deepEqual(reply.result.protectedPathNotice?.paths, ['netlify.toml']);
  assert.match(out.join(''), /The owner must approve this landing/);
  assert.doesNotMatch(out.join(''), /Protected-path coverage is unavailable/);
});

// Issue 75b4d062: the printed wait follows a background save through registration and settlement.
for (const budget of [0, 540])
  test(`the printed wait for a split save ${budget ? 'applies its settled receipt' : 'keeps the original operation when its budget ends'}`, async t => {
    const f = await setup(t),
      address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
      transport = new HostedAgentTransport(f.root, address, f.exchange),
      written = [],
      oldExit = process.exitCode,
      operationMissing = new ConvexError({
        code: 'NOT_FOUND',
        message: 'Prepare this original hosted save first.',
      });
    t.after(() => {
      process.exitCode = oldExit;
    });
    t.mock.method(process.stderr, 'write', text => {
      written.push(String(text));
      return true;
    });
    const saved = await hostedAgentCli(f.root, 'save', { message: 'split wait' }, address, transport);
    assert.equal(saved.result.status, 'settling', 'ordinary saves still return before settlement');
    const recovery = /resume with: nforge agent '([^']+)' wait '([^']+)'/.exec(written.join(''));
    assert(recovery, 'the initial operation announcement carries a recovery command');
    const command = JSON.parse(recovery[2]);
    assert.deepEqual(command.operationIds, [saved.operationId]);
    const query = f.exchange.client.query;
    let progressReads = 0,
      subscriptions = 0,
      released = false,
      closed = false;
    f.exchange.client.query = async (ref, args) => {
      if (getFunctionName(ref) === 'projectHostedSaves:progress') {
        assert.equal(args.operationId, saved.operationId);
        progressReads++;
        // The reported replay fails on its initial HTTP observation, while the
        // separate live progress stream can still see the original save.
        if (budget) throw new Error('[Request ID: 0123abcd] Server Error');
        throw operationMissing;
      }
      return query(ref, args);
    };
    const waitTransport = new HostedAgentTransport(f.root, address, f.exchange, () => ({
      onUpdate(ref, args, update, fail) {
        subscriptions++;
        assert.equal(getFunctionName(ref), 'projectHostedSaves:progress');
        assert.equal(args.operationId, saved.operationId);
        void (async () => {
          fail(operationMissing);
          const pending = await query(ref, args);
          if (JSON.parse(pending).terminal) {
            update(pending);
            return;
          }
          assert.equal(JSON.parse(pending).state.status, 'submitted');
          update(pending);
          assert.equal(released, false, 'a submitted save keeps its wait attached');
          const dispatch = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
          await f.settle(dispatch.args.jobId);
          update(await query(ref, args));
        })().catch(fail);
        return () => {
          released = true;
        };
      },
      async close() {
        closed = true;
      },
    }));
    const waited = await hostedAgentCli(
      recovery[1],
      'wait',
      { ...command, timeoutSeconds: budget },
      address,
      waitTransport,
    );
    assert.equal(subscriptions, budget ? 1 : 0);
    assert.equal(progressReads, budget ? 0 : 1, 'one snapshot or one live subscription');
    if (budget) {
      assert.equal(waited.result.status, 'terminal');
      assert.equal(waited.operationId, saved.operationId);
      assert.equal(waited.result.operationId, saved.operationId);
      assert.equal(waited.result.outcome.status, 'completed');
      assert.equal(readHostedLaneCheckout(f.root).selection.head, waited.result.outcome.result.head);
      assert.notEqual(waited.result.outcome.result.head, f.entry.head);
      assert(released && closed, 'terminal success closes the subscription');
      assert.equal(process.exitCode ?? 0, 0);
      const repeat = await hostedAgentCli(recovery[1], 'wait', command, address, waitTransport);
      assert.equal(subscriptions, 2, 'local settlement preserves the read-only continuation');
      assert.equal(progressReads, 0);
      assert.equal(repeat.operationId, saved.operationId);
      assert.deepEqual(repeat.result.outcome, waited.result.outcome);
    } else {
      assert.equal(waited.result.status, 'IN_PROGRESS');
      assert.equal(process.exitCode, 3);
      assert.deepEqual(waited.result.next.operationIds, [saved.operationId]);
      assert.equal(readHostedLaneCheckout(f.root).selection.head, f.entry.head);
      assert(!written.join('').includes(`${saved.operationId} finished`));
    }
    assert.equal(
      f.scheduled.filter(item => item.name === 'projectConvexSource:dispatch').length,
      1,
      'exact replay retains one source job for the save',
    );
    assert(!f.c.calls.includes('projectHostedFinishObserve:page'), 'a source save is never a landing');
  });

for (const fromBase of [false, true])
  test(`a split save returns after its upload, peers see its paths at once, and the next command applies the settle with one read${fromBase ? ' (first save from the base)' : ''}`, async t => {
    const f = await setup(t, { fromBase });
    const command = { operationId: randomUUID(), message: 'split save' };
    const before = f.c.calls.length;
    const returned = await saveHostedLane(f.root, command, f.exchange, contract);
    const saveCalls = f.c.calls.slice(before);
    assert.equal(returned.status, 'submitted', 'the save returned before its settle');
    assert.equal(returned.outcome, undefined);
    assert.equal(count(saveCalls, 'projectSourceRun:submit'), 1);
    assert.equal(count(saveCalls, 'projectConvexSourceStore:commit'), 0, 'no step ran inside the save');
    const dispatch = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
    assert.equal(dispatch?.ms, 0, 'the settle is scheduled at once');
    // Peers (and this Lane's own overlap read) see the save's paths before its head is published.
    const row = f.overlap();
    assert.equal(row.head, f.entry.head);
    assert.deepEqual(
      JSON.parse(row.changes)
        .map(change => change.path)
        .sort(),
      f.changed,
    );
    assert.equal(
      readHostedLaneCheckout(f.root).selection.head,
      f.entry.head,
      'the marker waits for the outcome',
    );

    await f.settle(returned.jobId);
    const next = f.c.calls.length;
    if (fromBase) {
      // A direct read (no capability call to carry it): one progress read applies the settle.
      await settleBackgroundSave(f.root, f.exchange);
      assert.deepEqual(f.c.calls.slice(next), ['projectHostedSaves:progress'], 'one read applies the settle');
    } else {
      // The agent's next command: its capability call carries the outcome, so no read is added.
      const agent = new HostedAgentTransport(
        f.root,
        { url: 'https://fixture.invalid', projectId: f.s.projectId },
        f.exchange,
      );
      await agent.dispatch('status', {}).catch(error => assert.notEqual(error.code, 'SAVE_SETTLE_FAILED'));
      assert.equal(f.c.calls[next], 'projectHostedAgent:capabilities');
      assert.equal(count(f.c.calls.slice(next), 'projectHostedSaves:progress'), 0);
    }
    assert.equal(count(f.c.calls, 'projectHostedSaves:dismissFailure'), 0);
    assert.equal((await projectBoard(f)).saveFailures, undefined);
    const marker = readHostedLaneCheckout(f.root);
    assert.notEqual(marker.selection.head, f.entry.head);
    assert.equal(marker.selection.version, 1);
    assert.equal(JSON.parse(f.s.objects.get(marker.selection.head)).files.length, f.files);
    assert.equal(f.overlap().head, marker.selection.head, 'the publish keeps the same paths on the new head');
    assert.equal(existsSync(join(clientCacheRoot(f.root), `saves/${command.operationId}/background`)), false);
    // Settled: later commands make no call for it (idle costs nothing).
    const idle = f.c.calls.length;
    await settleBackgroundSave(f.root, f.exchange);
    assert.equal(f.c.calls.length, idle);
  });

test('593fc2d7: lanes run in a checkout whose save is still settling marks that Lane row and names the wait', async t => {
  const f = await setup(t);
  const { liveLanes } = await import('../dist/hosted-live-lanes.js');
  const other = randomUUID();
  const list = () =>
    liveLanes(
      {
        root: f.root,
        query: async () => ({
          page: [
            { laneId: f.entry.laneId, head: f.entry.head },
            { laneId: other, head: f.entry.head },
          ],
          isDone: true,
          continueCursor: null,
        }),
      },
      {},
    );
  const command = { operationId: randomUUID(), message: 'split save' };
  const returned = await saveHostedLane(f.root, command, f.exchange, contract);
  assert.equal(returned.status, 'submitted');
  const before = f.c.calls.length;
  const [own, peer] = (await list()).result.page;
  assert.equal(f.c.calls.length, before, 'the mark reads local files only');
  assert.equal(own.saving.operationId, command.operationId);
  assert.match(own.saving.note, /still settling; head is the one before it/);
  assert.match(own.saving.next, new RegExp(`wait '\\{"operationIds":\\["${command.operationId}"\\]\\}'`));
  assert.equal(peer.saving, undefined, "only this checkout's Lane");
  await f.settle(returned.jobId);
  await settleBackgroundSave(f.root, f.exchange);
  assert.equal((await list()).result.page[0].saving, undefined, 'a settled save leaves no mark');
});

async function moveLaneBeforeSettle(f) {
  // Another writer moves the Lane before the scheduled settle publishes.
  const head = [...f.s.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'lane' && row.key === f.entry.laneId,
  );
  const record = f.s.tables.projectHostedRecords.get(head.recordId);
  const bodies = Object.entries(f.s.tables).find(([, rows]) => rows.has(record.bodyId));
  const value = JSON.stringify({ ...JSON.parse(bodies[1].get(record.bodyId).value), sourceVersion: 7 });
  f.s.patch(bodies[0], record.bodyId, { value });
  f.s.patch('projectHostedRecords', record._id, {
    digest: digest(value),
    bytes: Buffer.byteLength(value),
  });
  const dispatch = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
  await f.settle(dispatch.args.jobId);
}

test('a printed background wait reports the real failed receipt and keeps the checkout head', async t => {
  const f = await setup(t),
    address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
    transport = new HostedAgentTransport(f.root, address, f.exchange);
  t.mock.method(process.stderr, 'write', () => true);
  const saved = await hostedAgentCli(
    f.root,
    'save',
    { message: 'wait on failed settle' },
    address,
    transport,
  );
  assert.equal(saved.result.status, 'settling');
  let closed = false;
  const waitTransport = new HostedAgentTransport(f.root, address, f.exchange, () => ({
    onUpdate(ref, args, update, fail) {
      void (async () => {
        const pending = JSON.parse(await f.exchange.client.query(ref, args));
        if (!pending.terminal) {
          update({ ...pending, status: 'failed', error: { code: 'SOURCE_WORKER_FAILED' } });
          await Promise.resolve();
          assert.equal(closed, false, 'a worker failure stays attached while its receipt publishes');
          await moveLaneBeforeSettle(f);
        }
        update(await f.exchange.client.query(ref, args));
      })().catch(fail);
      return () => {};
    },
    async close() {
      closed = true;
    },
  }));
  await assert.rejects(
    hostedAgentCli(f.root, 'wait', { operationIds: [saved.operationId] }, address, waitTransport),
    { code: 'SAVE_SETTLE_FAILED', recovery: { failedSave: saved.operationId, cause: 'WORK_STALE' } },
  );
  assert.equal(readHostedLaneCheckout(f.root).selection.head, f.entry.head);
  assert.equal((await projectBoard(f)).saveFailures[0].operationId, saved.operationId);
  const wait = f.c.calls.length;
  await settleBackgroundSave(f.root, f.exchange);
  assert.equal(f.c.calls.length, wait, 'the already-reported failure is settled locally');
  await assert.rejects(
    hostedAgentCli(f.root, 'wait', { operationIds: [saved.operationId] }, address, waitTransport),
    { code: 'SAVE_SETTLE_FAILED', recovery: { failedSave: saved.operationId, cause: 'WORK_STALE' } },
  );
  await transport.dispatch('status', {});
  assert.equal((await projectBoard(f)).saveFailures, undefined);
});

test('a background wait refuses an old source epoch from the same progress subscription', async t => {
  const f = await setup(t),
    address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
    transport = new HostedAgentTransport(f.root, address, f.exchange);
  t.mock.method(process.stderr, 'write', () => true);
  const saved = await hostedAgentCli(f.root, 'save', { message: 'wait after cutover' }, address, transport);
  assert.equal(saved.result.status, 'settling');
  f.s.patch('hostedProjects', f.s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  const waitTransport = new HostedAgentTransport(f.root, address, f.exchange, () => ({
    onUpdate(ref, args, update, fail) {
      void f.exchange.client.query(ref, args).then(update, fail);
      return () => {};
    },
    async close() {},
  }));
  await assert.rejects(
    hostedAgentCli(f.root, 'wait', { operationIds: [saved.operationId] }, address, waitTransport),
    error => {
      assert.equal(error.code, 'SOURCE_AUTHORITY_CHANGED');
      assert.match(error.message, /epoch 1.*epoch 2/);
      assert.equal(error.recovery.next.action, 'save');
      assert.notEqual(error.recovery.next.operationId, saved.operationId);
      return true;
    },
  );
  assert.equal(readHostedLaneCheckout(f.root).selection.head, f.entry.head);
});

test('a completed background wait preserves the stacked Lane restack', async t => {
  const f = await setup(t),
    address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
    transport = new HostedAgentTransport(f.root, address, f.exchange);
  t.mock.method(process.stderr, 'write', () => true);
  const markerPath = join(f.root, '.forge/hosted-lane.json');
  const marker = readHostedLaneCheckout(f.root);
  const parentLaneId = randomUUID(),
    parentHead = 'b'.repeat(64),
    restackedHead = 'c'.repeat(64);
  marker.selection.stack = { laneId: parentLaneId, head: 'a'.repeat(64) };
  writeFileSync(markerPath, JSON.stringify(marker));
  const saved = await hostedAgentCli(f.root, 'save', { message: 'save stacked child' }, address, transport);
  assert.equal(saved.result.status, 'settling');
  const job = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
  await f.settle(job.args.jobId);
  const waitTransport = new HostedAgentTransport(f.root, address, f.exchange, () => ({
    onUpdate(ref, args, update, fail) {
      void f.exchange.client.query(ref, args).then(update, fail);
      return () => {};
    },
    async close() {},
  }));
  t.mock.method(waitTransport, 'query', async (name, args) => {
    assert.equal(name, 'projectHostedOverlaps:read');
    assert.equal(args.laneId, f.entry.laneId);
    return {
      behindMain: { commits: 0, conflictingPaths: [], more: 0, coverage: 'exact' },
      stack: { laneId: f.entry.laneId, parentLaneId, parentHead, restack: 'ready' },
    };
  });
  t.mock.method(waitTransport, 'dispatch', async (action, args) => {
    assert.equal(action, 'sync');
    assert.equal(args.laneId, f.entry.laneId);
    assert.equal(args.cleanOnly, true);
    return {
      result: {
        outcome: {
          status: 'completed',
          result: {
            status: 'merged',
            lane: { laneId: f.entry.laneId, head: restackedHead },
          },
        },
        applied: true,
      },
    };
  });
  const waited = await hostedAgentCli(
    f.root,
    'wait',
    { operationIds: [saved.operationId] },
    address,
    waitTransport,
  );
  assert.equal(waited.operationId, saved.operationId);
  assert.equal(waited.result.outcome.status, 'completed');
  assert.equal(waited.restack.from, waited.result.outcome.result.head);
  assert.equal(waited.restack.head, restackedHead);
});

const projectBoard = async (f, input = {}) =>
  JSON.parse(await f.c.call('projectBoard:read', { projectId: f.s.projectId, ...input }));

async function failSaveJob(f, jobId) {
  const { projectId } = f.s;
  await f.c.call('projectConvexSource:dispatch', { projectId, jobId });
  await f.c.call('projectConvexSourceStore:commit', {
    projectId,
    jobId,
    step: 0,
    cursor: null,
    objects: [],
    output: null,
    failure: 'SOURCE_HASH_MISMATCH',
    failureReason: 'Synthetic worker diagnostic',
  });
  const finalizer = f.scheduled.find(
    item => item.name === 'projectHostedSaveJobs:complete' && item.args.jobId === jobId,
  );
  assert.ok(finalizer, 'the existing worker finalizer settles the failed save');
  await f.c.call(finalizer.name, finalizer.args);
}

test('a newer save wins over a delayed terminal job failure on the same Lane pins', async t => {
  const f = await setup(t),
    projectId = f.s.projectId;
  const original = await saveHostedLane(
    f.root,
    { operationId: randomUUID(), message: 'original' },
    f.exchange,
    contract,
  );
  const old = [...f.s.tables.projectHostedSaves.values()].find(row => row.jobId === original.jobId);
  const request = JSON.parse(old.value).request;
  await f.c.call('projectHostedSaves:prepare', {
    projectId,
    request: JSON.stringify({ ...request, operationId: randomUUID() }),
  });
  // Creation time can run ahead of commit order under concurrent preparations.
  const saves = f.s.tables.projectHostedSaves;
  const lastCreated = Math.max(...[...saves.values()].map(row => row._creationTime));
  saves.set(old._id, { ...saves.get(old._id), _creationTime: lastCreated + 1 });
  await failSaveJob(f, original.jobId);
  assert.equal((await projectBoard(f)).saveFailures, undefined);
  const progress = JSON.parse(
    await f.c.call('projectHostedSaves:progress', { projectId, operationId: old.operationId }),
  );
  assert.equal(progress.terminal.outcome.status, 'failed', 'the superseded receipt stays exact');
});

for (const [action, read] of [
  ['board', 'projectBoard:read'],
  ['lanes', 'projectHostedLiveLanes:list'],
])
  test(`a checkout's next ${action} reports and clears its exact failure without a healthy follow-up call`, async t => {
    const f = await setup(t),
      projectId = f.s.projectId;
    const command = { operationId: randomUUID(), message: 'split save' };
    const saved = await saveHostedLane(f.root, command, f.exchange, contract);
    const transport = new HostedAgentTransport(
      f.root,
      { url: 'https://fixture.invalid', projectId },
      f.exchange,
    );
    const healthy = f.c.calls.length;
    await transport.dispatch(action, {});
    assert.deepEqual(f.c.calls.slice(healthy), [read]);
    await failSaveJob(f, saved.jobId);
    const failed = f.c.calls.length;
    await assert.rejects(transport.dispatch(action, {}), {
      code: 'SAVE_SETTLE_FAILED',
      recovery: { failedSave: command.operationId, cause: 'SOURCE_HASH_MISMATCH' },
    });
    assert.deepEqual(f.c.calls.slice(failed), [
      read,
      'projectHostedSaves:progress',
      'projectHostedSaves:dismissFailure',
    ]);
    assert.equal((await projectBoard(f)).saveFailures, undefined);
  });

test('an already submitted save can hand off to the background and project a later worker failure', async t => {
  const f = await setup(t),
    projectId = f.s.projectId;
  const command = { operationId: randomUUID(), message: 'hand off an already-submitted save' };
  const runMutation = f.c.context.runMutation;
  f.c.context.runMutation = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectSourceRunStore:submit') return runMutation(ref, args);
    const { background, ...inline } = args;
    assert.equal(background, true);
    const accepted = JSON.parse(await runMutation(ref, inline));
    assert.ok(accepted.run, 'the inline job was retained before its caller left');
    return JSON.stringify({ ...accepted, run: null });
  };
  let saved;
  try {
    saved = await saveHostedLane(f.root, command, f.exchange, contract);
  } finally {
    f.c.context.runMutation = runMutation;
  }
  assert.equal(saved.status, 'submitted');
  await f.c.call('projectSourceRun:submit', {
    projectId,
    kind: 'save',
    operationId: command.operationId,
    settle: 'background',
  });
  await failSaveJob(f, saved.jobId);
  assert.equal((await projectBoard(f)).saveFailures[0].operationId, command.operationId);
});

for (const clearBy of ['dismiss', 'retry'])
  test(`a worker terminal failure is cleared only by its exact ${clearBy}`, async t => {
    const f = await setup(t),
      projectId = f.s.projectId,
      laneId = f.entry.laneId;
    const command = { operationId: randomUUID(), message: 'worker failed' };
    const saved = await saveHostedLane(f.root, command, f.exchange, contract);
    await failSaveJob(f, saved.jobId);
    const [failure] = (await projectBoard(f)).saveFailures;
    assert.equal(failure.operationId, command.operationId);
    assert.equal(failure.code, 'SOURCE_HASH_MISMATCH');
    assert(!JSON.stringify(failure).includes('Synthetic worker diagnostic'));
    if (clearBy === 'dismiss') {
      await f.c.call('projectHostedLanePark:set', {
        projectId,
        laneId,
        authorityEpoch: 1,
        park: { reason: 'Waiting for the next command' },
      });
      assert.deepEqual((await projectBoard(f, { laneId })).saveFailures, [failure]);
    }
    const dismiss = params => f.c.call('projectHostedSaves:dismissFailure', { projectId, laneId, ...params });
    assert.equal(await dismiss({ operationId: randomUUID(), attemptId: failure.attemptId }), false);
    assert.equal(await dismiss({ operationId: failure.operationId, attemptId: randomUUID() }), false);
    assert.deepEqual((await projectBoard(f)).saveFailures, [failure]);
    const held = JSON.parse(
      await f.c.call('projectHostedSaves:progress', { projectId, operationId: command.operationId }),
    );
    if (clearBy === 'retry') {
      const exact = JSON.parse(
        await f.c.call('projectHostedSaves:prepare', {
          projectId,
          request: JSON.stringify(held.state.request),
        }),
      );
      assert.deepEqual(exact.terminal, held.terminal);
    } else {
      assert.equal(await dismiss({ operationId: failure.operationId, attemptId: failure.attemptId }), true);
      assert.equal(
        await dismiss({ operationId: failure.operationId, attemptId: failure.attemptId }),
        false,
        'a repeated acknowledgement is safe',
      );
    }
    await f.c.call('projectHostedSaveJobs:complete', { projectId, jobId: saved.jobId });
    assert.equal(
      (await projectBoard(f)).saveFailures,
      undefined,
      'a repeated completion cannot revive a cleared failure',
    );
    assert.equal((await projectBoard(f, { laneId })).saveFailures, undefined);
    const after = JSON.parse(
      await f.c.call('projectHostedSaves:progress', { projectId, operationId: command.operationId }),
    );
    assert.deepEqual(after.terminal, held.terminal);
  });

test('a settle that fails after the save returned is reported by the next command, once', async t => {
  const f = await setup(t);
  const command = { operationId: randomUUID(), message: 'split save' };
  const returned = await saveHostedLane(f.root, command, f.exchange, contract);
  assert.equal(returned.status, 'submitted');
  await moveLaneBeforeSettle(f);
  const progress = JSON.parse(
    await f.c.client.query(makeFunctionReference('projectHostedSaves:progress'), {
      projectId: f.s.projectId,
      operationId: command.operationId,
    }),
  );
  assert.equal(progress.terminal.outcome.status, 'failed', 'the server could not finish the save');
  const projectId = f.s.projectId,
    laneId = f.entry.laneId;
  const readCalls = f.c.calls.length,
    scheduled = f.scheduled.length;
  const failure = {
    operationId: command.operationId,
    attemptId: progress.terminal.attemptId,
    code: 'WORK_STALE',
  };
  const board = await projectBoard(f);
  const [notice] = board.saveFailures;
  const { at, ...identity } = notice;
  assert.equal(typeof at, 'number');
  assert.deepEqual(identity, { laneId, ...failure });
  const { laneId: _laneId, ...summary } = notice;
  const query = async (name, args) => {
    const value = await f.c.call(name, { projectId, ...args });
    return typeof value === 'string' ? JSON.parse(value) : value;
  };
  assert.deepEqual((await query('projectHostedLanes:head', { laneId })).saveFailure, summary);
  assert.deepEqual((await query('projectHostedLanes:detail', { laneId })).saveFailure, summary);
  assert.deepEqual(
    (await query('projectHostedLiveLanes:list', { cursor: null, limit: 10 })).page[0].saveFailure,
    { ...summary, canDismiss: true },
  );
  const laneRead = f.s.counts.at(-1);
  assert.equal(
    laneRead.readRangesByTable.projectFinishReadRows ?? 0,
    0,
    'Lane list uses its existing page rows',
  );
  assert.deepEqual((await projectBoard(f, { laneId, after: at + 100 })).saveFailures, [notice]);
  const outside = new HostedAgentTransport(
    join(f.root, '..'),
    { url: 'https://fixture.invalid', projectId },
    f.exchange,
  );
  assert.deepEqual((await outside.dispatch('board', {})).result.saveFailures, [notice]);
  assert.deepEqual(f.c.calls.slice(readCalls), [
    'projectBoard:read',
    'projectHostedLanes:head',
    'projectHostedLanes:detail',
    'projectHostedLiveLanes:list',
    'projectBoard:read',
    'projectBoard:read',
  ]);
  assert.equal(f.scheduled.length, scheduled, 'readers schedule no work');

  for (const [module, method, input] of [
    ['projectBoard', 'read', { projectId }],
    ['projectHostedLanes', 'head', { projectId, laneId }],
    [
      'projectHostedSaves',
      'dismissFailure',
      { projectId, laneId, operationId: failure.operationId, attemptId: failure.attemptId },
    ],
  ]) {
    await assert.rejects(
      f.s.call(method, sourceModules[module][method], input, 'outside-project'),
      error => error.data?.code === 'PROJECT_UNAVAILABLE',
    );
  }

  // A command that discovers capabilities reports the failure before dispatching its work.
  const agent = new HostedAgentTransport(
    f.root,
    { url: 'https://fixture.invalid', projectId: f.s.projectId },
    f.exchange,
  );
  const reported = f.c.calls.length;
  await assert.rejects(agent.dispatch('status', {}), error => {
    assert.equal(error.code, 'SAVE_SETTLE_FAILED');
    assert.match(error.message, new RegExp(command.operationId));
    assert.match(error.message, /WORK_STALE/);
    assert.match(error.message, /edits are still in this checkout/);
    assert.equal(error.recovery.failedSave, command.operationId);
    return true;
  });
  // Discovery carries the outcome; only a failed settle adds a mutation for acknowledgement.
  assert.deepEqual(f.c.calls.slice(reported), [
    'projectHostedAgent:capabilities',
    'projectHostedSaves:dismissFailure',
  ]);
  assert.equal((await projectBoard(f)).saveFailures, undefined);
  assert.equal(readHostedLaneCheckout(f.root).selection.head, f.entry.head, 'the marker never moved');
  // Reported once: the agent's retry of its command goes on with no call for the failed save.
  const retry = f.c.calls.length;
  await settleBackgroundSave(f.root, f.exchange);
  assert.equal(f.c.calls.length, retry);
});

test('a save whose server outlives the request window waits on its original operation and applies the real receipt', async t => {
  const { ForgeError } = await import('../dist/errors.js');
  const f = await setup(t),
    command = { operationId: randomUUID(), message: 'reconcile original save' },
    action = f.exchange.client.action;
  let serverReply,
    submits = 0;
  f.exchange.client.action = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectSourceRun:submit') return action(ref, args);
    submits++;
    // Server work is durable, but has not run its source step at caller expiry.
    serverReply = JSON.parse(await action(ref, { ...args, settle: 'background' }));
    throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'ordinary request window ended');
  };
  const saved = await saveHostedLane(
    f.root,
    command,
    f.exchange,
    { ...contract, settleBackground: false },
    false,
    undefined,
    async operationId => {
      assert.equal(operationId, command.operationId);
      assert.equal(readHostedLaneCheckout(f.root).selection.head, f.entry.head);
      await f.settle(serverReply.jobId);
      const progress = JSON.parse(
        await f.exchange.client.query(makeFunctionReference('projectHostedSaves:progress'), {
          projectId: f.s.projectId,
          operationId,
        }),
      );
      return progress.terminal;
    },
  );
  assert.equal(saved.outcome.status, 'completed');
  assert.notEqual(readHostedLaneCheckout(f.root).selection.head, f.entry.head);
  assert.equal(submits, 1, 'the retained source work is never submitted again');
});

test('netlify incident: the first changed split save names approval before a step runs; a reverted edit removes the notice', async t => {
  const f = await setup(t, { protectedPath: true });
  const agent = new HostedAgentTransport(
    f.root,
    { url: 'https://fixture.invalid', projectId: f.s.projectId },
    f.exchange,
  );
  const returned = await agent.dispatch('save', { message: 'Save protected configuration' });
  assert.equal(returned.result.status, 'settling');
  assert.deepEqual(returned.result.protectedPathNotice.paths, ['netlify.toml']);
  assert.match(returned.result.protectedPathNotice.message, /^The owner must approve this landing/);
  assert(
    !f.c.calls.includes('projectConvexSourceStore:commit'),
    'approval is explained before source steps or checks',
  );
  const dispatch = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
  await f.settle(dispatch.args.jobId);
  await agent.dispatch('status', {});
  writeFileSync(join(f.root, 'netlify.toml'), 'original-0\n');
  const reverted = await agent.dispatch('save', { message: 'Revert protected configuration' });
  assert.equal(reverted.result.protectedPathNotice, undefined);
});

test('1dd4e095: replaying a completed split save removes its background flag without resubmitting', async t => {
  const f = await setup(t);
  const command = { operationId: randomUUID(), message: 'split replay' };
  const returned = await saveHostedLane(f.root, command, f.exchange, contract);
  const flag = join(clientCacheRoot(f.root), `saves/${command.operationId}/background`);
  assert(existsSync(flag));
  await f.settle(returned.jobId);
  const before = f.c.calls.length;
  const replayed = await saveHostedLane(f.root, command, f.exchange, contract);
  assert.equal(replayed.outcome.status, 'completed');
  assert.equal(existsSync(flag), false);
  assert.notEqual(readHostedLaneCheckout(f.root).selection.head, f.entry.head);
  assert.deepEqual(f.c.calls.slice(before), ['projectHostedSaves:progress']);
});

// Item e1633718, review 1d3e59ac: a save that parks never returns before its settlement. Sent while the server still
// settled the save, the park's Lane record write moved the version and the save failed as stale after the CLI had
// said "Saved", with the Lane shown as parked without its last edits.
test('a save that parks waits for its own settlement, then parks: the save lands and the park holds', async t => {
  const f = await setup(t),
    address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
    transport = new HostedAgentTransport(f.root, address, f.exchange),
    originalWait = sourceWaitHooks.wait;
  t.after(() => {
    sourceWaitHooks.wait = originalWait;
  });
  t.mock.method(process.stderr, 'write', () => true);
  // Should the save be left to settle in the background, settle it only after the CLI has replied (the incident).
  sourceWaitHooks.wait = async (_address, operationId) => {
    const dispatch = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
    await f.settle(dispatch.args.jobId);
    return JSON.parse(
      await f.c.client.query(makeFunctionReference('projectHostedSaves:progress'), {
        projectId: f.s.projectId,
        operationId,
      }),
    ).terminal;
  };
  const saved = await hostedAgentCli(
    f.root,
    'save',
    { message: 'park after this save', park: { reason: 'Waits for the lead.' } },
    address,
    transport,
  );
  assert.notEqual(saved.result.status, 'settling', 'a parking save does not return before its settlement');
  const committed = f.c.calls.lastIndexOf('projectConvexSourceStore:commit'),
    parked = f.c.calls.indexOf('projectHostedLanePark:set');
  assert(committed >= 0 && parked > committed, 'the save settled before the park was sent');
  assert.equal(saved.result.outcome.status, 'completed', 'the save itself completed, not failed as stale');
  assert.equal(saved.result.park.reason, 'Waits for the lead.');
  const saveHead = saved.result.outcome.result.head;
  assert.notEqual(saveHead, f.entry.head, 'the edits are in the saved head');
  assert.equal(f.overlap().head, saveHead, 'the Lane is on the saved head');
  assert.equal(f.overlap().park?.reason, 'Waits for the lead.', 'and it is parked');
});

// Review e09e956c (1): a save still settling when its wait ends sends no park (the park would fail it as stale). The
// reply says so; once the save has landed, the same save {park} parks, and the checkout follows the park's version.
test('a save that parks but is still settling when its wait ends sends no park; the same command after it lands parks', async t => {
  const f = await setup(t),
    address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
    transport = new HostedAgentTransport(f.root, address, f.exchange),
    originalWait = sourceWaitHooks.wait,
    oldExit = process.exitCode;
  t.after(() => {
    process.exitCode = oldExit;
    sourceWaitHooks.wait = originalWait;
  });
  t.mock.method(process.stderr, 'write', () => true);
  // The server takes the save as background work and the wait's budget ends before it settles.
  const action = f.exchange.client.action;
  f.exchange.client.action = async (ref, args) =>
    action(
      ref,
      getFunctionName(ref) === 'projectSourceRun:submit' ? { ...args, settle: 'background' } : args,
    );
  transport.waitUntil = Date.now();
  const command = { message: 'park after this save', park: { reason: 'Waits for the lead.' } };
  const pending = await hostedAgentCli(f.root, 'save', command, address, transport);
  assert.match(pending.result.parkNotSent, /not sent/);
  assert.equal(pending.result.park, undefined);
  assert.equal(count(f.c.calls, 'projectHostedLanePark:set'), 0, 'no park while the save settles');
  assert.equal(process.exitCode, 3, 'the save is still in progress');
  process.exitCode = oldExit;
  const dispatch = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
  await f.settle(dispatch.args.jobId);
  f.exchange.client.action = action;
  transport.waitUntil = undefined;
  // From here a wait sees the settled save, as a real one would.
  sourceWaitHooks.wait = async (_address, operationId) =>
    JSON.parse(
      await f.c.client.query(makeFunctionReference('projectHostedSaves:progress'), {
        projectId: f.s.projectId,
        operationId,
      }),
    ).terminal;
  const again = await hostedAgentCli(f.root, 'save', command, address, transport);
  assert.equal(again.result.park.reason, 'Waits for the lead.');
  assert.equal(f.overlap().park?.reason, 'Waits for the lead.');
  assert.notEqual(f.overlap().head, f.entry.head, 'the saved edits are on the Lane');
  const marker = readHostedLaneCheckout(f.root).selection;
  assert.equal(marker.head, f.overlap().head);
  assert.equal(marker.version, f.overlap().recordVersion, 'the checkout follows the version the park wrote');
});

// Review c343b42c follow-up: a save whose source worker passed its lease without progress comes back stalled
// (retryable, no outcome yet). It sends no park either: the replay that reconciles the save must not meet a Lane
// version the park moved.
test('a save that parks but comes back stalled (retryable) sends no park', async t => {
  const f = await setup(t),
    address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
    transport = new HostedAgentTransport(f.root, address, f.exchange),
    oldExit = process.exitCode;
  t.after(() => {
    process.exitCode = oldExit;
  });
  t.mock.method(process.stderr, 'write', () => true);
  // The server takes the save as background work, and its worker's lease has already passed.
  const action = f.exchange.client.action;
  f.exchange.client.action = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectSourceRun:submit') return action(ref, args);
    const reply = JSON.parse(await action(ref, { ...args, settle: 'background' }));
    return JSON.stringify(
      reply.status === 'submitted'
        ? { ...reply, source: { ...reply.source, jobId: reply.jobId, status: 'running', workerUntil: 1 } }
        : reply,
    );
  };
  const saved = await hostedAgentCli(
    f.root,
    'save',
    { message: 'park after this save', park: { reason: 'Waits for the lead.' } },
    address,
    transport,
  );
  assert.equal(saved.result.status, 'retryable', 'the save came back stalled');
  assert.match(saved.result.parkNotSent ?? '', /not sent/);
  assert.equal(count(f.c.calls, 'projectHostedLanePark:set'), 0, 'no park on a stalled save');
  assert.equal(f.overlap().park, undefined);
});

// Incident 48835eea: a save still settling here replayed its old capture as "Saved" over newer edits.
test('48835eea: a bare save after an edit made while the last one settles takes a fresh id and captures the edit', async t => {
  const f = await setup(t),
    address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
    agent = new HostedAgentTransport(f.root, address, f.exchange);
  const first = await agent.dispatch('save', { message: 'split save' });
  assert.equal(first.result.status, 'settling');
  writeFileSync(join(f.root, 'f05'), 'edited while the save settled\n');
  // The server settles the first save only once the next command asks about it (load): the identical
  // save must not answer from the older capture, and it waits on the first save instead of a deadline.
  const original = f.c.client.query;
  let settled = false;
  f.c.client.query = async (ref, args) => {
    if (
      !settled &&
      getFunctionName(ref) === 'projectHostedSaves:progress' &&
      args.operationId === first.operationId
    ) {
      settled = true;
      await f.settle(f.scheduled.find(item => item.name === 'projectConvexSource:dispatch').args.jobId);
    }
    return original(ref, args);
  };
  t.after(() => (f.c.client.query = original));
  const third = await agent.dispatch('save', { message: 'split save' });
  assert(settled, 'the second save asked about the first one before saving');
  assert.notEqual(third.operationId, first.operationId, 'never a replay of the older capture');
  const capture = JSON.parse(
    readFileSync(join(clientCacheRoot(f.root), 'saves', third.operationId, 'capture.json'), 'utf8'),
  );
  assert.deepEqual(
    capture.changes.map(change => change.path),
    ['f05'],
    'the new save captures the edit on top of the settled one',
  );
});

test('48835eea: a settling save reply is refused when a file changed after its capture, naming the file', async t => {
  const f = await setup(t),
    address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
    agent = new HostedAgentTransport(f.root, address, f.exchange);
  const original = f.c.client.mutation;
  let edited = false;
  // An edit lands while the upload runs, after the capture was taken.
  f.c.client.mutation = async (ref, args) => {
    const saves = join(clientCacheRoot(f.root), 'saves');
    if (
      !edited &&
      existsSync(saves) &&
      readdirSync(saves).some(name => existsSync(join(saves, name, 'capture.json')))
    ) {
      edited = true;
      writeFileSync(join(f.root, 'f07'), 'edited during the upload\n');
    }
    return original(ref, args);
  };
  t.after(() => (f.c.client.mutation = original));
  await assert.rejects(agent.dispatch('save', { message: 'split save' }), error => {
    assert.equal(error.code, 'UNSAVED_LANE_EDITS');
    assert.deepEqual(error.recovery.unsaved.paths, ['f07']);
    assert.equal(error.recovery.completed.status, 'settling');
    return true;
  });
});

test('48835eea review: a settling save in a scoped checkout does not name files outside its scope', async t => {
  const f = await setup(t),
    address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
    agent = new HostedAgentTransport(f.root, address, f.exchange);
  // Scope the checkout: f19 is not materialized here, so its absence is never a deletion.
  const markerPath = join(f.root, '.forge/hosted-lane.json'),
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  marker.materialized = marker.materialized.filter(path => path !== 'f19');
  writeFileSync(markerPath, JSON.stringify(marker));
  rmSync(join(f.root, 'f19'));
  const saved = await agent.dispatch('save', { message: 'scoped split save' });
  assert.equal(saved.result.status, 'settling');
});

test('9124ec2f: status {files:true} right after a settling save names it and lists only a later edit as unsaved', async t => {
  const f = await setup(t),
    address = { url: 'https://fixture.invalid', projectId: f.s.projectId },
    agent = new HostedAgentTransport(f.root, address, f.exchange);
  for (const name of ['f01', 'f02', 'f03']) writeFileSync(join(f.root, name), `settling ${name}\n`);
  const saved = await agent.dispatch('save', { message: 'split save' });
  assert.equal(saved.result.status, 'settling');
  writeFileSync(join(f.root, 'f05'), 'edited after the save returned\n');
  const before = f.c.calls.length;
  const status = (await agent.dispatch('status', { files: true })).result;
  assert.equal(f.c.calls.length, before, 'status reads the local capture only, no server call');
  assert.deepEqual(
    status.unsaved.paths.map(row => row.path),
    ['f05'],
    'only the edit after the capture is unsaved',
  );
  assert.equal(status.settling.operationId, saved.operationId);
  const captured = JSON.parse(
    readFileSync(join(clientCacheRoot(f.root), 'saves', saved.operationId, 'capture.json'), 'utf8'),
  ).changes.map(change => change.path);
  for (const name of ['f01', 'f02', 'f03']) assert(captured.includes(name), name);
  assert.equal(status.settling.captured, captured.length);
  assert.deepEqual(
    status.settling.paths.map(row => row.path),
    captured.sort(),
    'every file the settling save holds shows as settling',
  );
  assert.match(status.note, new RegExp(`Settling: save ${saved.operationId}`));
});

// Item 3f70760d: a background save writes its paths into the shared evidence at submit; a failure
// takes them back out, so peers, presence and the first-write hook never name unsaved work.
const presence = f =>
  [...f.s.tables.projectHostedPresence.values()].find(row => row.laneId === f.entry.laneId);

test('3f70760d: a background save that fails takes its paths back out of every overlap surface', async t => {
  const f = await setup(t);
  const saved = await saveHostedLane(
    f.root,
    { operationId: randomUUID(), message: 'split save' },
    f.exchange,
    contract,
  );
  const paths = row =>
    JSON.parse(row.changes)
      .map(change => change.path)
      .sort();
  assert.deepEqual(paths(f.overlap()), f.changed, 'peers see the pending paths at submit');
  assert.deepEqual([...presence(f).paths].sort(), f.changed);
  await failSaveJob(f, saved.jobId);
  assert.deepEqual(paths(f.overlap()), [], 'the failed save names no path');
  assert.equal(f.overlap().head, f.entry.head);
  assert.deepEqual(presence(f).paths, []);
  assert.equal(presence(f).pathCount, 0);
  const failures = (await projectBoard(f)).saveFailures;
  assert.equal(failures?.[0]?.code, 'SOURCE_HASH_MISMATCH', 'the failure itself is still reported');
});

test('3f70760d: a protected file restored after a failed background save leaves no protected notice', async t => {
  const f = await setup(t, { protectedPath: true });
  const agent = new HostedAgentTransport(
    f.root,
    { url: 'https://fixture.invalid', projectId: f.s.projectId },
    f.exchange,
  );
  const returned = await agent.dispatch('save', { message: 'Save protected configuration' });
  assert.deepEqual(returned.result.protectedPathNotice.paths, ['netlify.toml']);
  const dispatch = f.scheduled.find(item => item.name === 'projectConvexSource:dispatch');
  await failSaveJob(f, dispatch.args.jobId);
  await assert.rejects(agent.dispatch('status', {}), { code: 'SAVE_SETTLE_FAILED' });
  writeFileSync(join(f.root, 'netlify.toml'), 'original-0\n');
  const restored = await agent.dispatch('save', { message: 'Drop the protected edit' });
  assert.equal(restored.result.protectedPathNotice, undefined);
  assert.deepEqual(JSON.parse(f.overlap().changes), []);
});

test('3f70760d: status by Lane id tells a superseded Lane from a live one, with the receipt', async t => {
  const f = await setup(t);
  const agent = new HostedAgentTransport(
    f.root,
    { url: 'https://fixture.invalid', projectId: f.s.projectId },
    f.exchange,
  );
  await agent.dispatch('save', { message: 'split save' });
  await f.settle(f.scheduled.find(item => item.name === 'projectConvexSource:dispatch').args.jobId);
  const status = async () => (await agent.dispatch('status', { laneId: f.entry.laneId })).result.superseded;
  assert.equal(await status(), undefined, 'a live Lane names no successor');
  const row = f.overlap(),
    by = randomUUID(),
    receiptId = randomUUID(),
    at = '2026-11-20T12:00:00.000Z';
  assert.equal(row.head, readHostedLaneCheckout(f.root).selection.head);
  f.s.patch('projectHostedOverlapLanes', row._id, { superseded: { by, receiptId, laneHead: row.head, at } });
  const marked = await status();
  assert.deepEqual({ ...marked, summary: undefined }, { by, receiptId, at, summary: undefined });
  assert(marked.summary.startsWith(`superseded by Lane ${by} (receipt ${receiptId})`), marked.summary);
  // Superseded at an older head: a later save made it live again.
  f.s.patch('projectHostedOverlapLanes', row._id, {
    superseded: { by, receiptId, laneHead: f.entry.head, at },
  });
  assert.equal(await status(), undefined);
});

test('3f70760d: lanes lists a superseded Lane as superseded, like status, and a later save makes it live', async t => {
  const f = await setup(t);
  const agent = new HostedAgentTransport(
    f.root,
    { url: 'https://fixture.invalid', projectId: f.s.projectId },
    f.exchange,
  );
  await agent.dispatch('save', { message: 'split save' });
  await f.settle(f.scheduled.find(item => item.name === 'projectConvexSource:dispatch').args.jobId);
  const row0 = async () =>
    (await agent.dispatch('lanes', {})).result.page.find(row => row.laneId === f.entry.laneId);
  assert.equal((await row0()).superseded, undefined, 'a live Lane lists no successor');
  const row = f.overlap(),
    by = randomUUID(),
    receiptId = randomUUID(),
    at = '2026-11-20T12:00:00.000Z';
  f.s.patch('projectHostedOverlapLanes', row._id, { superseded: { by, receiptId, laneHead: row.head, at } });
  const listed = (await row0()).superseded;
  const status = (await agent.dispatch('status', { laneId: f.entry.laneId })).result.superseded;
  assert.deepEqual(listed, status, 'lanes and status say the same thing');
  assert.equal(listed.by, by);
  assert(listed.summary.startsWith(`superseded by Lane ${by} (receipt ${receiptId})`), listed.summary);
  const tree = (await agent.dispatch('lanes', { view: 'tree' })).result.tree.join('\n');
  assert(tree.includes('[superseded]'), tree);
  f.s.patch('projectHostedOverlapLanes', row._id, {
    superseded: { by, receiptId, laneHead: 'older-head', at },
  });
  assert.equal((await row0()).superseded, undefined, 'a stamp for an older head is a live Lane');
});
