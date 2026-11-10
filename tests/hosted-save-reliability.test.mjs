// SPDX-License-Identifier: Apache-2.0
// Wave 3b save reliability. Incident replays from builder friction on 2026-11-05:
// fcd197f1 (save returned "submitted" and needed 2-3 manual replays), a4c2e8f0 (the local Lane
// binding stayed one version behind until replayed), 381b348c (save --sync after a fire-and-forget
// save failed WORK_STALE), 11cd4121 and d4922dbd (an identical save --sync replayed its retained
// stale-pinned request, WORK_STALE on every retry), Issue 0fe39d02 (land --save default wait 5400 s).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { lifecycleFixture, lanes } from './hosted-lane-lifecycle-fixture.mjs';
import { api } from './hosted-saves-fixture.mjs';
import { executeHostedAgent } from '../dist/hosted-agent-actions.js';
import { HostedAgentJournal } from '../dist/hosted-agent-journal.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { sourceWaitSnapshot } from '../dist/hosted-agent-source-wait.js';
import { supersededSync } from '../dist/hosted-sync-retained.js';
import { reconcileHostedSync } from '../dist/hosted-sync-handoff.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { digest } from '../dist/hash.js';
import { notSavedInclude } from '../dist/save-not-saved.js';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { replayBindings } from '../dist/hosted-replay-holds.js';
import { slimReceipt } from '../dist/receipt-slim.js';

const address = { url: 'https://fixture.invalid', projectId: 'unused' };

async function fixture(t) {
  const f = await lifecycleFixture(),
    base = mkdtempSync(join(tmpdir(), 'forge-save-reliability-')),
    root = join(realpathSync(base), 'client');
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'original');
  writeFileSync(join(root, 'hidden.txt'), 'unmaterialized');
  mkdirSync(join(`${root}.forge-client`, 'objects'), { recursive: true });
  for (const value of ['original', 'unmaterialized'])
    writeFileSync(join(`${root}.forge-client`, 'objects', digest(value)), value);
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: address.url,
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: f.projectId,
        laneId: f.laneId,
        intentId: f.intentId,
        ...f.expected,
        state: 'active',
        base: f.initial.base,
        authority: { mode: 'server', epoch: 1 },
      },
      state: f.state,
      scope: null,
      materialized: ['a.txt', 'hidden.txt'],
    }),
  );
  const calls = [];
  const exchange = {
    projectId: f.projectId,
    missing: async pins => pins.filter(p => !f.objects.has(p.sha256)).map(p => p.sha256),
    uploadFile: async (pin, dir, path) => {
      const bytes = readFileSync(join(dir, path));
      f.put(bytes);
      return { uploadedObjects: 1, uploadedBytes: bytes.length };
    },
    upload: async (_pin, bytes) => {
      f.put(bytes);
      return { uploadedObjects: 1, uploadedBytes: bytes.length };
    },
    downloadBatch: async pins => pins.map(pin => f.objects.get(pin.sha256)),
    downloadToFile: async () => assert.fail('small objects use the batch path'),
    prepareDownloads: async () => {},
    client: {
      mutation: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push(name);
        if (name === 'projectObjectDownloads:describe')
          return args.digests.map(d => ({ digest: d, size: f.objects.get(d).length, location: 'r2' }));
        if (name === 'projectHostedSaves:prepare') return f.call('prepare', api.prepare, args);
        if (name === 'projectHostedSaves:stage') return f.call('stage', api.stage, args);
        assert.equal(name, 'projectHostedSaveJobs:submit');
        return JSON.stringify(
          await f.submit(
            { request: { operationId: args.operationId } },
            args.clientMs === undefined ? {} : { clientMs: args.clientMs },
          ),
        );
      },
      query: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push(name);
        assert.equal(name, 'projectHostedSaves:progress');
        return f.call('progress', api.progress, args);
      },
    },
  };
  const complete = async operationId => f.publish(await f.work({ request: { operationId } }));
  const done = new Set();
  /** The save job's progress subscription: delivers the terminal receipt once the job finishes. */
  const waits = [];
  const waitSource = async (operationId, initial, kind = 'Sync', timeoutSeconds) => {
    waits.push({ operationId, kind, timeoutSeconds });
    if (kind !== 'Saves') return initial;
    if (!done.has(operationId)) {
      done.add(operationId);
      await complete(operationId);
    }
    return sourceWaitSnapshot(
      JSON.parse(await f.call('progress', api.progress, { projectId: f.projectId, operationId })),
    );
  };
  const syncPrepares = [],
    selects = [];
  const session = (action, command, overrides = {}) => ({
    root,
    address: { url: address.url, projectId: f.projectId },
    exchange,
    capabilities: { authority: { epoch: 1 }, actions: [] },
    journal: new HostedAgentJournal(root, address, 'owner', action, command, overrides.operationId),
    marker: () => readHostedLaneCheckout(root),
    waitSource,
    waitUntil: Date.now() + 540_000,
    main: async () => ({ head: digest('main'), receipt: { id: randomUUID() } }),
    query: async (name, args) => {
      assert.equal(name, 'projectHostedLanes:select', `unexpected query ${name}`);
      selects.push(name);
      return JSON.parse(await f.call('select', lanes.select, { ...args, projectId: f.projectId }));
    },
    // The real prepare refuses pins that differ from the server Lane, inside one transaction.
    mutation: async (name, args) => {
      assert.equal(name, 'projectHostedSync:prepare');
      const request = JSON.parse(args.request);
      syncPrepares.push(request);
      const lane = await f.read(f.laneId);
      for (const key of ['head', 'version', 'sourceVersion', 'lifecycleVersion'])
        if (request.expected[key] !== lane[key])
          throw new ConvexError({ code: 'WORK_STALE', message: 'Select the exact saved Lane pins.' });
      return {
        terminal: { outcome: { status: 'failed', error: { code: 'SYNC_FIXTURE', message: 'stop' } } },
      };
    },
    ...overrides,
  });
  return { ...f, root, exchange, calls, waits, waitSource, session, syncPrepares, selects, complete, done };
}
const marker = s => readHostedLaneCheckout(s.root).selection;

test('incident replay fcd197f1: a save that returned submitted and needed 2-3 replays now finishes on the first call', async t => {
  const s = await fixture(t);
  writeFileSync(join(s.root, 'a.txt'), 'first edit');
  const saving = s.session('save', { message: 'first' });
  const result = await executeHostedAgent(saving, 'save', { message: 'first' });
  assert.equal(result.outcome.status, 'completed', 'the first call returns the terminal receipt');
  // Exactly one progress subscription for the remaining budget, no polling or replays.
  assert.equal(s.waits.length, 1);
  assert.equal(s.waits[0].kind, 'Saves');
  assert(s.waits[0].timeoutSeconds > 530 && s.waits[0].timeoutSeconds <= 540);
  const submitAt = s.calls.lastIndexOf('projectHostedSaveJobs:submit');
  assert.deepEqual(s.calls.slice(submitAt + 1), [], 'no hosted call after submission on the happy path');
  // a4c2e8f0: the binding advanced from the receipt; no replay needed.
  const server = await s.read(s.laneId);
  assert.equal(marker(s).head, server.head);
  assert.equal(marker(s).version, server.version);
  assert.equal(marker(s).version, s.expected.version + 1);
  // A replay (the old manual loop) answers from the settled receipt with zero calls.
  const before = s.calls.length;
  const replay = await executeHostedAgent(
    s.session('save', { message: 'first' }, { operationId: saving.journal.operationId }),
    'save',
    { message: 'first' },
  );
  assert.equal(replay.outcome.status, 'completed');
  assert.equal(s.calls.length, before);
  // The next save builds on the advanced binding: no WORK_STALE, no settle read.
  writeFileSync(join(s.root, 'a.txt'), 'second edit');
  const next = await executeHostedAgent(s.session('save', { message: 'second' }), 'save', {
    message: 'second',
  });
  assert.equal(next.outcome.status, 'completed');
  assert.equal(marker(s).version, s.expected.version + 2);
});

test('a save receipt names new paths left out by credential name, bounded, and its replay repeats it', async t => {
  const s = await fixture(t);
  writeFileSync(join(s.root, 'a.txt'), 'first edit');
  mkdirSync(join(s.root, 'cmd/build'), { recursive: true });
  writeFileSync(join(s.root, 'cmd/build/main.go'), 'package main\n');
  writeFileSync(join(s.root, 'server.pem'), 'synthetic certificate fixture\n');
  writeFileSync(join(s.root, '.env.local'), 'A=1\n');
  const saving = s.session('save', { message: 'first' });
  const result = await executeHostedAgent(saving, 'save', { message: 'first' });
  assert.equal(result.outcome.status, 'completed');
  // A credential-looking name with no credential inside is saved; a local env file is held.
  assert.deepEqual(result.notSaved, {
    count: 1,
    paths: [{ path: '.env.local', reason: 'sensitive-name' }],
    include: notSavedInclude,
  });
  const replay = await executeHostedAgent(
    s.session('save', { message: 'first' }, { operationId: saving.journal.operationId }),
    'save',
    { message: 'first' },
  );
  assert.deepEqual(replay.notSaved, result.notSaved);
});

test('save still running at its budget returns submitted, and the CLI reports IN_PROGRESS with its wait', async t => {
  const s = await fixture(t);
  writeFileSync(join(s.root, 'a.txt'), 'slow edit');
  const result = await executeHostedAgent(
    s.session('save', { message: 'slow' }, { waitUntil: Date.now() - 1 }),
    'save',
    { message: 'slow' },
  );
  assert.equal(result.status, 'submitted');
  assert.equal(s.waits.length, 0, 'no budget left: no subscription');
  assert.equal(marker(s).version, s.expected.version, 'binding waits for the receipt');
  // The next save waits for that earlier one on its progress (no SAVE_PENDING, no manual retry).
  writeFileSync(join(s.root, 'b.txt'), 'another edit');
  const next = await executeHostedAgent(s.session('save', { message: 'next' }), 'save', { message: 'next' });
  assert.equal(next.outcome.status, 'completed');
  assert.equal(marker(s).version, s.expected.version + 2);
  assert.deepEqual(
    s.waits.map(wait => wait.kind),
    ['Saves', 'Saves'],
    'one subscription for the earlier save, one for this one',
  );
  // The CLI turns it into one IN_PROGRESS line with the canonical wait, exit 3.
  const operationId = randomUUID();
  t.mock.method(process.stderr, 'write', () => true);
  const response = await hostedAgentCli(s.root, 'save', { message: 'slow' }, address, {
    dispatch: async () => ({
      schema: 1,
      transport: 'hosted',
      action: 'save',
      operationId,
      result: { status: 'submitted', jobId: 'job' },
    }),
  });
  t.mock.restoreAll();
  assert.equal(process.exitCode, 3);
  process.exitCode = 0;
  assert.equal(response.result.status, 'IN_PROGRESS');
  assert.match(response.result.waitCommand, new RegExp(`wait '\\{"operationIds":\\["${operationId}"\\]\\}'`));
});

test('an unavailable progress subscription leaves a submitted save pending, never failed', async t => {
  const s = await fixture(t);
  writeFileSync(join(s.root, 'a.txt'), 'unobserved');
  const unobserved = await executeHostedAgent(
    s.session(
      'save',
      { message: 'unobserved' },
      {
        waitSource: async () => {
          throw Object.assign(new Error('sign-in unavailable'), { code: 'AUTH_REQUIRED' });
        },
      },
    ),
    'save',
    { message: 'unobserved' },
  );
  assert.equal(unobserved.status, 'submitted');
  assert.equal(marker(s).version, s.expected.version);
});

test('incident replay 381b348c / a4c2e8f0: save --sync after a fire-and-forget save settles it first and pins the new version', async t => {
  const s = await fixture(t);
  writeFileSync(join(s.root, 'a.txt'), 'unseen');
  // An older client returned at submission; its job is still running when sync starts.
  const old = await executeHostedAgent(
    s.session('save', { message: 'unseen' }, { waitUntil: Date.now() - 1 }),
    'save',
    { message: 'unseen' },
  );
  assert.equal(old.status, 'submitted');
  assert.equal(marker(s).version, s.expected.version, 'the incident state: binding one version behind');
  const command = { ontoMain: true };
  const result = await executeHostedAgent(s.session('sync', command), 'sync', command);
  assert.equal(result.outcome.status, 'failed', 'the fixture sync ran (its prepare accepted the pins)');
  assert.equal(s.syncPrepares.length, 1, 'one prepare: never refused');
  assert.equal(s.syncPrepares[0].expected.version, s.expected.version + 1);
  assert.equal(marker(s).version, s.expected.version + 1, 'binding advanced from the settled save');
  assert.deepEqual(
    s.waits.map(wait => wait.kind),
    ['Saves', 'Sync'],
    'one subscription for the earlier save, then the sync',
  );
});

test('incident replay 11cd4121 / d4922dbd: a retained stale-pinned sync request is rebuilt, never replayed stale', async t => {
  const s = await fixture(t);
  const command = { ontoMain: true };
  const first = s.session('sync', command);
  // The retained request from before the Lane moved (pins v0).
  await first.journal.retain(`sync:${first.journal.operationId}`, () => ({
    kind: 'sync',
    ontoMain: true,
    operationId: first.journal.operationId,
    authorityEpoch: 1,
    laneId: s.laneId,
    expected: s.expected,
    target: { kind: 'main', head: digest('main'), receiptId: randomUUID() },
  }));
  // A save then moved the Lane and the binding to v1.
  writeFileSync(join(s.root, 'a.txt'), 'moved');
  await executeHostedAgent(s.session('save', { message: 'moved' }), 'save', { message: 'moved' });
  assert.equal(marker(s).version, s.expected.version + 1);
  // The identical command (no operationId) with pins still matching v0 would replay; the
  // checkout moved past them, so it is new work with current pins.
  assert.equal(supersededSync(s.root, address, 'owner', command), true);
  // Even replaying that exact operation: the refusal drops the stale request and rebuilds once.
  const replay = s.session('sync', command, { operationId: first.journal.operationId });
  const result = await executeHostedAgent(replay, 'sync', command);
  assert.equal(result.outcome.status, 'failed', 'the rebuilt request reached the fixture sync');
  assert.deepEqual(
    s.syncPrepares.map(request => [request.operationId, request.expected.version]),
    [
      [first.journal.operationId, s.expected.version],
      [first.journal.operationId, s.expected.version + 1],
    ],
    'the stale request once (refused, nothing began), then current pins on the same operation',
  );
  assert.equal(
    replay.journal.get(`sync:${first.journal.operationId}`).expected.version,
    s.expected.version + 1,
    'retained request now holds current pins',
  );
});

test('incident replay b8c0a4f6: a sync onto main refused CHANNEL_CHANGED rebuilds on the moved main, an explicit target never', async t => {
  const s = await fixture(t);
  let main = { head: digest('main'), receipt: { id: randomUUID() } };
  const prepares = [];
  // The real prepare checks the main target after finding no begun operation, in one transaction.
  const mutation = async (name, args) => {
    assert.equal(name, 'projectHostedSync:prepare');
    const request = JSON.parse(args.request);
    prepares.push(request);
    if (prepares.length === 1) main = { head: digest('moved'), receipt: { id: randomUUID() } };
    if (request.target.head !== main.head || request.target.receiptId !== main.receipt.id)
      throw new ConvexError({
        code: 'CHANNEL_CHANGED',
        message: 'Sync against the exact observed main head and receipt.',
      });
    return {
      terminal: { outcome: { status: 'failed', error: { code: 'SYNC_FIXTURE', message: 'stop' } } },
    };
  };
  const command = { ontoMain: true };
  const sync = s.session('sync', command, { main: async () => main, mutation });
  const result = await executeHostedAgent(sync, 'sync', command);
  assert.equal(result.outcome.status, 'failed', 'the rebuilt request reached the fixture sync');
  assert.deepEqual(
    prepares.map(request => [request.operationId, request.target.head]),
    [
      [sync.journal.operationId, digest('main')],
      [sync.journal.operationId, digest('moved')],
    ],
  );
  // A target the caller named is its pin: refused once, never replaced.
  const target = { kind: 'main', head: digest('main'), receiptId: randomUUID() };
  const pinned = { ontoMain: true, target };
  prepares.length = 0;
  await assert.rejects(
    executeHostedAgent(s.session('sync', pinned, { main: async () => main, mutation }), 'sync', pinned),
    error => error.data?.code === 'CHANNEL_CHANGED' || error.code === 'CHANNEL_CHANGED',
  );
  assert.equal(prepares.length, 1);
});

test('a sync still refused after rebuilding names the save that fixes it and leaves nothing to install', async t => {
  const s = await fixture(t);
  // Another writer moved the Lane on the server only: this checkout's binding is behind and
  // no local save is pending, so rebuilt pins are still stale.
  const lane = await s.read(s.laneId);
  const x = await s.prepare(
    [
      {
        path: 'c.txt',
        before: null,
        after: {
          blob: s.put(Buffer.from('elsewhere')).sha256,
          mode: 'file',
          content: { object: s.put(Buffer.from('elsewhere')), recipe: null },
        },
      },
    ],
    {
      expected: {
        head: lane.head,
        version: lane.version,
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: lane.lifecycleVersion,
      },
    },
  );
  await s.stage(x);
  await s.submit(x);
  await s.complete(x.request.operationId);
  const command = { ontoMain: true, apply: true };
  const sync = s.session('sync', command);
  await assert.rejects(executeHostedAgent(sync, 'sync', command), error => {
    assert.equal(error.code, 'WORK_STALE');
    assert.match(error.message, /Run save in this checkout/);
    assert.equal(error.recovery.next.action, 'save');
    assert.match(error.recovery.command, / save '/);
    return true;
  });
  assert.equal(s.syncPrepares.length, 2, 'refused, rebuilt once, refused');
  assert.equal(s.selects.length, 1, 'one bounded Lane read, only after the rebuild was refused');
  assert.equal(marker(s).version, s.expected.version, 'a newer saved head is never adopted without a save');
  assert.equal(sync.journal.get(`sync:${sync.journal.operationId}`), undefined, 'no stale request retained');
  assert.equal(existsSync(join(`${s.root}.forge-client`, 'sync-handoff.json')), false, 'no handoff for land');
});

test('incident replay f98f0f4b / b344b920: a retained sync replayed after the Lane was reopened from another root adopts the lifecycle pins', async t => {
  const s = await fixture(t);
  const command = { ontoMain: true };
  const first = s.session('sync', command);
  const operationId = first.journal.operationId;
  // The request retained from this checkout (pins v0), then interrupted before it completed.
  await first.journal.retain(`sync:${operationId}`, () => ({
    kind: 'sync',
    ontoMain: true,
    operationId,
    authorityEpoch: 1,
    laneId: s.laneId,
    expected: s.expected,
    target: { kind: 'main', head: digest('main'), receiptId: randomUUID() },
  }));
  // Acceptance completed the Lane and a reopen from another root made it active again: the server
  // moved version and lifecycleVersion; head and sourceVersion (the saved source) did not.
  await s.changeLane(s.laneId, { lifecycleVersion: s.expected.lifecycleVersion + 1 });
  const server = await s.changeLane(s.laneId, { lifecycleVersion: s.expected.lifecycleVersion + 2 });
  assert.equal(marker(s).lifecycleVersion, s.expected.lifecycleVersion, 'the incident state: marker behind');
  // The identical replay (same operation id) pins fresh instead of failing WORK_STALE on every retry.
  const calls = s.calls.length;
  const result = await executeHostedAgent(s.session('sync', command, { operationId }), 'sync', command);
  assert.equal(result.outcome.status, 'failed', 'the adopted pins reached the fixture sync');
  assert.deepEqual(
    s.syncPrepares.map(r => [r.operationId, r.expected.version, r.expected.lifecycleVersion]),
    [
      [operationId, s.expected.version, s.expected.lifecycleVersion],
      [operationId, s.expected.version, s.expected.lifecycleVersion],
      [operationId, server.version, server.lifecycleVersion],
    ],
    'the stale request, the marker rebuild, then the server pins on the same operation',
  );
  assert.equal(s.selects.length, 1, 'one bounded Lane read');
  assert.equal(s.calls.length, calls, 'no other call');
  const advanced = marker(s);
  assert.deepEqual(
    [advanced.version, advanced.lifecycleVersion, advanced.head, advanced.sourceVersion],
    [server.version, server.lifecycleVersion, s.expected.head, s.expected.sourceVersion],
    'only the metadata advanced',
  );
  // A healthy replay afterwards asks for no read.
  s.selects.length = 0;
  await executeHostedAgent(s.session('sync', command, { operationId }), 'sync', command);
  assert.equal(s.selects.length, 0);
});

test('identical sync after the Lane moved starts fresh; matching pins or a pending install still replay', t => {
  const parent = mkdtempSync(join(tmpdir(), 'forge-sync-retained-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(realpathSync(parent), 'client');
  mkdirSync(join(root, '.forge'), { recursive: true });
  const laneId = randomUUID(),
    head = digest('v1');
  const selection = (h, version) => ({
    schema: 2,
    projectId: 'p',
    laneId,
    intentId: randomUUID(),
    head: h,
    version,
    sourceVersion: version,
    lifecycleVersion: 0,
    state: 'active',
    base: { head: digest('base'), receiptId: randomUUID() },
    authority: { mode: 'server', epoch: 1 },
  });
  const write = (h, version) =>
    writeFileSync(
      join(root, '.forge/hosted-lane.json'),
      JSON.stringify({
        schema: 1,
        kind: 'forge-hosted-lane-checkout',
        url: address.url,
        operationId: randomUUID(),
        selection: selection(h, version),
        state: {
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: [],
          message: 'm',
          at: '2026-11-05T12:00:00.000Z',
        },
        scope: null,
        materialized: [],
      }),
    );
  write(head, 1);
  const command = { ontoMain: true };
  assert.equal(supersededSync(root, address, 'owner', command), false, 'nothing retained');
  const journal = new HostedAgentJournal(root, address, 'owner', 'sync', command);
  return journal
    .retain(`sync:${journal.operationId}`, () => ({
      kind: 'sync',
      laneId,
      expected: { head, version: 1, sourceVersion: 1, lifecycleVersion: 0 },
    }))
    .then(() => {
      assert.equal(supersededSync(root, address, 'owner', command), false, 'pins match: replay resumes it');
      write(digest('v2'), 2);
      assert.equal(supersededSync(root, address, 'owner', command), true, 'binding moved: fresh operation');
      writeFileSync(
        join(`${root}.forge-client`, 'sync-handoff.json'),
        JSON.stringify({ operationId: journal.operationId }),
      );
      assert.equal(supersededSync(root, address, 'owner', command), false, 'a pending install replays');
    });
});

test('a sync handoff whose sync never began clears instead of failing every land NOT_FOUND', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'forge-sync-handoff-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(realpathSync(parent), 'client');
  mkdirSync(join(`${root}.forge-client`), { recursive: true });
  const operationId = randomUUID();
  const path = join(`${root}.forge-client`, 'sync-handoff.json');
  writeFileSync(
    path,
    JSON.stringify({ operationId, applyOperationId: randomUUID(), action: 'sync', command: { operationId } }),
  );
  let reads = 0;
  const exchange = {
    projectId: 'p',
    client: {
      query: async () => {
        reads++;
        throw new ConvexError({ code: 'NOT_FOUND', message: 'Prepare this original hosted sync first.' });
      },
    },
  };
  assert.equal(await reconcileHostedSync(root, exchange), null);
  assert.equal(reads, 1);
  assert.equal(existsSync(path), false);
  assert.equal(await reconcileHostedSync(root, exchange), null);
  assert.equal(reads, 1, 'no handoff, no call');
});

test('land submitter stops waiting on its save at the land budget (Issue 0fe39d02)', async t => {
  const previous = process.env.FORGE_LAND_INVOKED_AT;
  // The land command started 541 s ago: its 540 s budget is spent.
  process.env.FORGE_LAND_INVOKED_AT = String(Date.now() - 541_000);
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_LAND_INVOKED_AT;
    else process.env.FORGE_LAND_INVOKED_AT = previous;
  });
  t.mock.method(process.stderr, 'write', () => true);
  const parent = mkdtempSync(join(tmpdir(), 'forge-land-budget-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  mkdirSync(join(root, '.git'), { recursive: true });
  const operationId = randomUUID();
  let dispatches = 0;
  const transport = {
    dispatch: async () => {
      dispatches++;
      return {
        schema: 1,
        transport: 'hosted',
        action: 'finish',
        operationId,
        result: {
          phase: 'save',
          saveOperationId: randomUUID(),
          progress: { status: 'submitted', jobId: 'j' },
        },
      };
    },
  };
  const response = await submitHostedLand(root, { message: 'm' }, address, transport);
  t.mock.restoreAll();
  assert.equal(dispatches, 1, 'no save wait or finish replay past the budget');
  assert.equal(response.result.phase, 'save');
});

test('pull without ROOT uses the Forge clone holding the current directory (friction fcd197f1)', async t => {
  const { hostedPullCli } = await import('../dist/hosted-pull-cli.js');
  const { clientCacheRoot } = await import('../dist/root-paths.js');
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'forge-pull-root-')));
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    rmSync(parent, { recursive: true, force: true });
  });
  const clone = join(parent, 'clone'),
    nested = join(clone, 'src', 'deep'),
    outside = join(parent, 'elsewhere');
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside);
  mkdirSync(join(clientCacheRoot(clone), 'agent'), { recursive: true });
  writeFileSync(
    join(clientCacheRoot(clone), 'agent/address.json'),
    JSON.stringify({ url: 'https://fixture.invalid', projectId: 'project' }),
  );
  let gated = 0;
  // The gate stops before any network call: reaching it proves the clone was found.
  const gate = async () => {
    gated++;
    return false;
  };
  process.chdir(nested);
  assert.equal(await hostedPullCli([], gate), undefined);
  assert.equal(gated, 1);
  process.chdir(outside);
  await assert.rejects(hostedPullCli([], gate), error => error.code === 'WORK_CONFLICT');
  assert.equal(gated, 1, 'no clone, no call');
  await assert.rejects(hostedPullCli(['a', 'b'], gate), error => error.code === 'BAD_ARGUMENT');
});

// Issue ca49dc6c: a replay is valid only while the state it reports still holds.
test('incident replay 9694afff: a bare save after new edits saves them; an unchanged one replays and says so', async t => {
  const s = await resolutionFixture(t, { overlap: false }),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(s.root, 'first.txt'), 'first edit');
  const first = await s.transport().dispatch('save', {});
  assert.equal(first.result.outcome.status, 'completed');
  assert.equal(first.result.replayed, undefined);
  assert.equal(first.result.unsavedEdits, undefined);
  const saved = readHostedLaneCheckout(s.root).selection;
  // Nothing changed: the identical request replays the settled receipt, says so, and saves nothing.
  const same = await s.transport().dispatch('save', {});
  assert.equal(same.operationId, first.operationId);
  assert.equal(same.result.replayed, true);
  assert.equal(same.result.unsavedEdits, undefined);
  assert.equal(readHostedLaneCheckout(s.root).selection.version, saved.version);
  // New edits: the earlier receipt no longer says what is saved, so the same bare save is new work.
  writeFileSync(join(s.root, 'second.txt'), 'second edit');
  const second = await s.transport().dispatch('save', {});
  assert.notEqual(second.operationId, first.operationId, 'a new save, not a replay of the earlier one');
  assert.equal(second.result.outcome.status, 'completed');
  assert.equal(second.result.replayed, undefined);
  assert.equal(second.result.unsavedEdits, undefined, 'the new edits are in this save');
  const after = readHostedLaneCheckout(s.root);
  assert.notEqual(after.selection.head, saved.head);
  assert(after.state.files.some(file => file.path === 'second.txt'));
  assert.equal((await f.readLane(f.lane.laneId)).head, after.selection.head);
  // An explicit replay of the first operation answers from its receipt, and names the edits that
  // differ from the head it reports instead of implying they are saved.
  writeFileSync(join(s.root, 'third.txt'), 'third edit');
  const explicit = await s.transport().dispatch('save', { operationId: first.operationId });
  assert.equal(explicit.result.replayed, true);
  assert.equal(explicit.result.unsavedEdits.saved, false);
  // The brief receipt keeps both facts.
  const brief = slimReceipt(explicit);
  assert.equal(brief.result.replayed, true);
  assert.equal(brief.result.unsavedEdits.saved, false);
});

test('every hosted agent action declares how its replay binds to current state', () => {
  const kinds = new Set(['checked', 'transport', 'server', 'read']);
  const actions = Object.keys(hostedAgentCommandSchemas).sort();
  assert.deepEqual(Object.keys(replayBindings).sort(), actions);
  for (const action of actions) {
    const binding = replayBindings[action];
    assert(kinds.has(binding.kind), action);
    if (binding.kind === 'checked') assert.equal(typeof binding.superseded, 'function', action);
  }
  for (const action of ['save', 'sync', 'withdraw', 'open'])
    assert.equal(replayBindings[action].kind, 'checked', `${action} receipts describe local state`);
});

test('guard b8c0a4f6: no retained request reads main inline; main-pinned requests go through sendMainPinned', () => {
  // A request that pins the observed main and is retained for exact replay can never succeed once
  // main moves; the server's refusal begins nothing. sendMainPinned drops and rebuilds it.
  const offenders = [];
  for (const name of readdirSync('src').filter(file => file.endsWith('.ts'))) {
    const text = readFileSync(join('src', name), 'utf8');
    for (let at = text.indexOf('journal.retain('); at !== -1; at = text.indexOf('journal.retain(', at + 1)) {
      let depth = 0,
        end = at + 'journal.retain'.length;
      for (; end < text.length; end++) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')' && --depth === 0) break;
      }
      if (/\.main\(\)/.test(text.slice(at, end)))
        offenders.push(`${name}:${text.slice(0, at).split('\n').length}`);
    }
  }
  assert.deepEqual(offenders, [], 'wrap the request in sendMainPinned (src/hosted-main-pin.ts)');
  for (const name of ['hosted-agent-source.ts', 'hosted-agent-actions.ts'])
    assert.match(readFileSync(join('src', name), 'utf8'), /sendMainPinned\(/, name);
});

test('negotiated save timing rides the final save call and caches only the completed matching head', async t => {
  const { saveHostedLane } = await import('../dist/hosted-save-client.js');
  const { savedDuration } = await import('../dist/hosted-save-pending.js');
  const { saveContract } = await import('../dist/hosted-save-client.js');
  assert.equal(saveContract({}).durations, false);
  const counts = [];
  for (const durations of [false, true]) {
    const s = await fixture(t);
    writeFileSync(join(s.root, 'a.txt'), 'timed edit');
    const command = { operationId: randomUUID(), message: 'timed save' };
    const progress = await saveHostedLane(s.root, command, s.exchange, {
      overlapEvidence: false,
      submitPage: false,
      durations,
    });
    const terminal = await s.complete(command.operationId);
    const { applyObservedSaveOutcome } = await import('../dist/hosted-save-client.js');
    // The ordinary observed-save path applies the returned receipt and local timing together.
    await applyObservedSaveOutcome(s.root, command.operationId, terminal);
    counts.push(s.calls);
    const value = savedDuration(s.root, s.laneId, terminal.outcome.result.head);
    assert.equal(typeof value, durations ? 'number' : 'undefined');
    assert.equal(
      savedDuration(s.root, s.laneId, 'f'.repeat(64)),
      undefined,
      'never attribute another source head',
    );
  }
  assert.deepEqual(counts[1], counts[0], 'timing introduces no Convex call');
});
