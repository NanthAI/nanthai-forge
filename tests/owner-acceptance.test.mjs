// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { initNative, nativeChannels, nativeExecute } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { queueAgentSync, flushAgentSync } from '../dist/agent-hosted-sync.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
import { updateHostState, readHostState } from '../dist/host-binding.js';
import {
  acceptOwnerRequest,
  consumeOwnerRequests,
  startOwnerAcceptanceListener,
} from '../dist/owner-acceptance-consumer.js';
import { state } from './hosted-fixture.mjs';
import { trustAgents } from './autonomy-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const backend = await import(moduleUrl('../convex/ownerAcceptance.ts'));
const lifecycleBackend = await import(moduleUrl('../convex/ownerLifecycle.ts'));
const sync = await import(moduleUrl('../convex/projectOwnerSync.ts'));
const coordination = await import(moduleUrl('../convex/projectCoordination.ts'));
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const projectWork = await import(moduleUrl('../convex/projectWork.ts'));
Error.stackTraceLimit = 0;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-owner-acceptance-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.txt'), 'base a\n');
  writeFileSync(join(root, 'b.txt'), 'base b\n');
  const base = initNative(root).head,
    store = new WorkStore(root),
    source = new NativeSource(root),
    ownerId = randomUUID();
  const s = state([]);
  s.tables.ownerAcceptanceRequests = new Map();
  s.tables.ownerAcceptanceMachines = new Map();
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: ownerId,
    name: 'Synthetic',
    revision: 0,
    hostingRequest: 'synthetic',
    currentBackup: 'backup',
    visibility: 'private',
    work: {
      generationId: 'generation',
      backupId: 'backup',
      operationId: 'seed',
      initialRevision: 0,
      revision: 0,
    },
  });
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    _creationTime: 1,
    projectId: 'project',
    status: 'stored',
    preview: { format: 'native' },
  });
  s.tables.projectWorkGenerations.set('generation', {
    _id: 'generation',
    _creationTime: 1,
    projectId: 'project',
    backupId: 'backup',
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    revision: 0,
    initialRevision: 0,
    nextBatch: 0,
    metadata: JSON.stringify({ counts: {} }),
  });
  const indexed = (collection, key, value) => {
    const id = `${collection}:${key}`;
    s.tables.projectWorkRecords.set(id, {
      _id: id,
      _creationTime: 1,
      projectId: 'project',
      generationId: 'generation',
      collection,
      key,
      parent: '',
      position: 0,
      value: JSON.stringify(value),
    });
  };
  const addView = (files = {}, parent = base) => {
    const original = source.state(parent).files;
    const next = original.map(f =>
      files[f.path] === undefined ? f : { ...f, blob: source.put(Buffer.from(files[f.path])) },
    );
    const head = Object.keys(files).length
      ? source.writeState(next, [parent], 'Synthetic candidate', new Date().toISOString())
      : parent;
    const intentId = randomUUID(),
      view = {
        id: randomUUID(),
        intentId,
        base: parent,
        head,
        inputs: [],
        dependencies: [],
        status: 'clean',
        at: new Date().toISOString(),
        details: '',
      };
    store.locked(() => {
      const data = store.load();
      data.intents.push({
        id: intentId,
        outcome: 'Synthetic',
        base: parent,
        status: 'active',
        constraints: '',
        notes: [],
        createdAt: view.at,
      });
      data.views.push(view);
      data.revision++;
      store.save(data);
    });
    indexed('views', view.id, view);
    return view;
  };
  const initial = addView();
  nativeExecute(
    store,
    {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: initial.id,
      expectedHead: initial.head,
      expectedPrevious: null,
    },
    store.revision(),
  );
  indexed('channels', 'main', { name: 'main', head: base });
  updateHostState(store, state => {
    state.binding = {
      operationId: ownerId,
      projectId: 'project',
      deployment: 'http://127.0.0.1:1',
      projectUrl: 'https://example.invalid/',
      name: 'Synthetic',
      backupId: 'backup',
      visibility: 'private',
      autoSync: false,
      acceptanceOwner: true,
    };
  });
  const client = {
    mutation: async (ref, args) => {
      const name = getFunctionName(ref);
      if (name === 'projectOwnerSync:publish') return sync.publish._handler(s.ctx, args);
      return backend[name.split(':')[1]]._handler(s.ctx, args);
    },
  };
  const request = async (view, extra = {}) =>
    backend.request._handler(s.ctx, {
      projectId: 'project',
      operationId: randomUUID(),
      viewId: view.id,
      head: view.head,
      expectedMain: base,
      ...extra,
    });
  return { root, store, source, base, ownerId, s, addView, client, request, indexed };
}
const main = f => nativeChannels(f.store.load()).find(c => c.name === 'main').head;
const status = f => backend.status._handler(f.s.ctx, { projectId: 'project', viewId: f.view.id });

test('hosted request waits offline, consumes once on bound synthetic owner and returns canonical receipt', async t => {
  const f = fixture(t);
  f.view = f.addView({ 'a.txt': 'accepted\n' });
  const request = await f.request(f.view);
  assert.equal(request.state, 'requested');
  assert.equal(main(f), f.base);
  assert.equal((await status(f)).machine, null);
  assert.equal((await status(f)).request.receipt, null);
  await consumeOwnerRequests(f.store, f.client);
  assert.equal(main(f), f.view.head);
  const observed = await status(f),
    receipt = JSON.parse(observed.request.receipt);
  assert.equal(observed.request.state, 'accepted');
  assert.equal(receipt.acceptance.id, request.operationId);
  assert.equal(receipt.acceptance.acceptedBy.kind, 'person');
  assert.equal(observed.mainHead, f.view.head);
  assert.match(observed.machine.command, /nforge host .* --listen/);
  assert.ok(observed.machine.lastSeen);
  assert.equal((await consumeOwnerRequests(f.store, f.client)).consumed, 0);
  assert.equal(f.store.load().channelMoves.filter(m => m.id === request.operationId).length, 1);
  assert.equal(f.s.tables.projectWorkEvents.size, 0);
});

test('unknown completion reply and publication reply replay exact metadata even after another acceptance', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'one\n' });
  const request = await f.request(view);
  let lose = true;
  const flaky = {
    mutation: async (ref, args) => {
      const result = await f.client.mutation(ref, args);
      if (lose && getFunctionName(ref) === 'projectOwnerSync:publish') {
        lose = false;
        throw new Error('lost reply');
      }
      return result;
    },
  };
  await assert.rejects(consumeOwnerRequests(f.store, flaky), /lost reply/);
  assert.equal(main(f), view.head);
  const pinned = readHostState(f.store).acceptancePublications[request.operationId];
  const other = f.addView({ 'b.txt': 'two\n' }, view.head);
  nativeExecute(
    f.store,
    {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: other.id,
      expectedHead: other.head,
      expectedPrevious: view.head,
    },
    f.store.revision(),
  );
  await consumeOwnerRequests(f.store, f.client);
  assert.equal(readHostState(f.store).acceptancePublications[request.operationId], pinned);
  assert.equal(main(f), other.head);
  const observed = await backend.status._handler(f.s.ctx, { projectId: 'project', viewId: view.id });
  assert.equal(observed.mainHead, other.head);
  assert.equal(f.store.load().channelMoves.filter(m => m.id === request.operationId).length, 1);
  const same = await f.request(view, { operationId: request.operationId });
  assert.equal(same.state, 'accepted');
  assert.equal((await acceptOwnerRequest(f.store, request)).result.id, request.operationId);
  await assert.rejects(f.request(other, { operationId: request.operationId }), /original acceptance request/);
});

test('concurrent disjoint requests retain both changes without re-check and record immutable path evidence', async t => {
  const f = fixture(t),
    a = f.addView({ 'a.txt': 'a change\n' }),
    b = f.addView({ 'b.txt': 'b change\n' });
  const r1 = await f.request(a),
    r2 = await f.request(b);
  await Promise.all([consumeOwnerRequests(f.store, f.client), consumeOwnerRequests(f.store, f.client)]);
  const data = f.store.load(),
    move = data.channelMoves.find(m => m.id === r2.operationId);
  assert.deepEqual(move.ownerRequest.disjoint.viewPaths, ['b.txt']);
  assert.deepEqual(move.ownerRequest.disjoint.mainPaths, ['a.txt']);
  const files = f.source.state(main(f)).files;
  assert.equal(f.source.object(files.find(x => x.path === 'a.txt').blob).toString(), 'a change\n');
  assert.equal(f.source.object(files.find(x => x.path === 'b.txt').blob).toString(), 'b change\n');
  assert.ok(f.source.ancestors(main(f)).has(a.head));
  assert.ok(f.source.ancestors(main(f)).has(b.head));
  assert.equal(data.runs.length, 0);
  assert.equal(data.channelMoves.filter(m => [r1.operationId, r2.operationId].includes(m.id)).length, 2);
});

test('overlapping stale main rejects with needs re-check, retaining main and original terminal rejection', async t => {
  const f = fixture(t),
    a = f.addView({ 'a.txt': 'first\n' }),
    b = f.addView({ 'a.txt': 'overlap\n' });
  await f.request(a);
  const req = await f.request(b);
  await consumeOwnerRequests(f.store, f.client);
  await consumeOwnerRequests(f.store, f.client);
  const row = [...f.s.tables.ownerAcceptanceRequests.values()].find(r => r.operationId === req.operationId);
  assert.equal(row.state, 'rejected');
  assert.match(JSON.parse(row.receipt).reason, /Needs re-check.*overlap/);
  assert.equal(main(f), a.head);
  assert.equal(
    f.store.load().channelMoves.some(m => m.id === req.operationId),
    false,
  );
  assert.equal((await f.request(b, { operationId: req.operationId })).receipt, row.receipt);
});

test('authority, binding pins, stale View, changed replay and agent identity cannot bypass person policy', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'change\n' });
  f.s.caller('stranger');
  await assert.rejects(f.request(view), /project|owner/i);
  f.s.caller('owner');
  await assert.rejects(f.request(view, { head: '0'.repeat(64) }), /retained clean View/);
  const req = await f.request(view);
  assert.throws(() => acceptOwnerRequest(f.store, { ...req, ownerId: randomUUID() }), /bound native owner/);
  const agentReq = { ...req, operationId: randomUUID(), actorKind: 'agent' };
  await assert.rejects(() => acceptOwnerRequest(f.store, agentReq), /person|review/i);
  assert.equal(main(f), f.base);
  await assert.rejects(
    backend.complete._handler(f.s.ctx, {
      projectId: 'project',
      ownerId: f.ownerId,
      operationId: req.operationId,
      receipt: JSON.stringify({ status: 'accepted', acceptance: {} }),
    }),
  );
});

test('legacy acceptChannel routes native projects to requests; hosted and Git projects keep selection route', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'change\n' });
  const originalQuery = f.s.ctx.runQuery;
  f.s.ctx.runQuery = (ref, args) =>
    getFunctionName(ref) === 'projectWork:owner'
      ? projectWork.owner._handler(f.s.ctx, args)
      : originalQuery(ref, args);
  const originalMutation = f.s.ctx.runMutation;
  f.s.ctx.runMutation = (ref, args) => {
    const name = getFunctionName(ref);
    if (name.startsWith('ownerAcceptance:')) return backend[name.split(':')[1]]._handler(f.s.ctx, args);
    return originalMutation(ref, args);
  };
  const result = await actions.acceptChannel._handler(f.s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    revision: 0,
    command: JSON.stringify({
      action: 'accept-hosted-channel',
      channel: 'main',
      viewId: view.id,
      head: view.head,
      previousId: null,
      archiveSha256: 'a'.repeat(64),
    }),
  });
  assert.equal(result.state, 'requested');
  assert.equal(main(f), f.base);
  assert.equal(f.s.tables.projectWorkEvents.size, 0);
  const routeArgs = {
    projectId: 'project',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    head: view.head,
  };
  f.s.tables.projectBackups.get('backup').preview.format = 'sha1';
  assert.equal(await backend.route._handler(f.s.ctx, routeArgs), null);
  delete f.s.tables.hostedProjects.get('project').hostingRequest;
  f.s.tables.projectBackups.get('backup').preview.format = 'native';
  assert.equal(await backend.route._handler(f.s.ctx, routeArgs), null);
});

test('offline transport leaves requested pins pending; a lost completion reply cannot repeat local acceptance', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'one\n' }),
    req = await f.request(view);
  await assert.rejects(
    consumeOwnerRequests(f.store, {
      mutation: async () => {
        throw new Error('offline');
      },
    }),
    /offline/,
  );
  assert.equal(main(f), f.base);
  assert.equal([...f.s.tables.ownerAcceptanceRequests.values()][0].state, 'requested');
  let lose = true;
  const transport = {
    mutation: async (ref, args) => {
      const result = await f.client.mutation(ref, args);
      if (lose && getFunctionName(ref) === 'ownerAcceptance:complete') {
        lose = false;
        throw new Error('lost completion reply');
      }
      return result;
    },
  };
  await assert.rejects(consumeOwnerRequests(f.store, transport), /lost completion reply/);
  await consumeOwnerRequests(f.store, f.client);
  assert.equal(main(f), view.head);
  assert.equal(f.store.load().channelMoves.filter(m => m.id === req.operationId).length, 1);
  await assert.rejects(
    () => acceptOwnerRequest(f.store, { ...req, head: f.base }),
    /original native acceptance/,
  );
});

test('device requests retain agent classification and current supervised policy rejects them on the owner', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'agent proposal\n' });
  f.s.tables.cliCredentials.set('device', {
    _id: 'device',
    _creationTime: 1,
    credentialId: 'device',
    owner: 'owner',
    scope: 'cli',
    expiresAt: Date.now() + 60000,
    revoked: false,
  });
  f.s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'device' });
  const req = await f.request(view);
  assert.equal(req.actorKind, 'agent');
  await consumeOwnerRequests(f.store, f.client);
  const row = [...f.s.tables.ownerAcceptanceRequests.values()][0];
  assert.equal(row.state, 'rejected');
  assert.match(JSON.parse(row.receipt).reason, /person|review/i);
  assert.equal(main(f), f.base);
});

test('revert Intent creation replays the same local Intent after an unknown response without changing main', t => {
  const f = fixture(t),
    operationId = randomUUID();
  const command = {
    action: 'intent',
    operationId,
    outcome: 'Revert acceptance',
    constraints: 'Create a compensating Lane; check then accept normally.',
  };
  const revision = f.store.revision();
  const first = nativeExecute(f.store, command, revision);
  const replay = nativeExecute(f.store, command, revision);
  assert.equal(first.result.id, operationId);
  assert.equal(replay.result.id, operationId);
  assert.equal(f.store.load().intents.filter(i => i.id === operationId).length, 1);
  assert.equal(main(f), f.base);
  assert.throws(
    () => nativeExecute(f.store, { ...command, constraints: 'different' }, f.store.revision()),
    /original Intent/,
  );
});

test('a View no longer retained by the canonical owner returns a local rejection without a hosted move', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'stale\n' }),
    req = await f.request(view);
  f.store.locked(() => {
    const data = f.store.load();
    data.views = data.views.filter(v => v.id !== view.id);
    data.revision++;
    f.store.save(data);
  });
  await consumeOwnerRequests(f.store, f.client);
  const row = [...f.s.tables.ownerAcceptanceRequests.values()].find(r => r.operationId === req.operationId);
  assert.equal(row.state, 'rejected');
  assert.equal(JSON.parse(row.receipt).code, 'VIEW_STALE');
  assert.equal(main(f), f.base);
  assert.equal(f.s.tables.projectWorkEvents.size, 0);
});

test('hosted acceptance uses the normal current-policy completion lifecycle', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'completed\n' });
  const lane = nativeExecute(
    f.store,
    { action: 'lane', intentId: view.intentId, name: 'Synthetic input' },
    f.store.revision(),
  ).result;
  writeFileSync(join(f.store.path(lane.id), 'a.txt'), 'completed\n');
  f.store.locked(() => {
    const data = f.store.load();
    data.autonomyPolicy.lifecycle.completeOnAccept = true;
    data.lanes.find(l => l.id === lane.id).head = view.head;
    data.views.find(v => v.id === view.id).inputs = [{ laneId: lane.id, head: view.head }];
    data.revision++;
    f.store.save(data);
  });
  await f.request(view);
  await consumeOwnerRequests(f.store, f.client);
  const data = f.store.load();
  assert.equal(data.lanes.find(l => l.id === lane.id).state, 'completed');
  assert.equal(data.intents.find(i => i.id === view.intentId).status, 'completed');
  assert.equal(main(f), view.head);
  assert.ok(data.automaticActions.length);
});

test('concurrent first-main requests compose disjoint changes against the retained native bootstrap', async t => {
  const f = fixture(t),
    a = f.addView({ 'a.txt': 'first a\n' }),
    b = f.addView({ 'b.txt': 'first b\n' });
  f.store.locked(() => {
    const data = f.store.load();
    data.channelMoves = [];
    data.revision++;
    f.store.save(data);
  });
  f.s.tables.projectWorkRecords.delete('channels:main');
  await f.request(a, { expectedMain: null });
  const req = await f.request(b, { expectedMain: null });
  await consumeOwnerRequests(f.store, f.client);
  await consumeOwnerRequests(f.store, f.client);
  const move = f.store.load().channelMoves.find(m => m.id === req.operationId);
  assert.equal(move.ownerRequest.expectedMain, null);
  assert.equal(move.ownerRequest.disjoint.base, f.base);
  assert.ok(f.source.ancestors(main(f)).has(a.head));
  assert.ok(f.source.ancestors(main(f)).has(b.head));
});

test('an unknown local reply after main moved remains pending and reconciles the same receipt', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'local reply lost\n' });
  const req = await f.request(view),
    original = WorkService.prototype.dispatch;
  let lose = true;
  WorkService.prototype.dispatch = async function (command, ...args) {
    const result = await original.call(this, command, ...args);
    if (lose && command.action === 'accept-channel') {
      lose = false;
      throw new Error('local reply lost');
    }
    return result;
  };
  t.after(() => {
    WorkService.prototype.dispatch = original;
  });
  await assert.rejects(consumeOwnerRequests(f.store, f.client), /local reply lost/);
  assert.equal(main(f), view.head);
  assert.equal([...f.s.tables.ownerAcceptanceRequests.values()][0].state, 'requested');
  await consumeOwnerRequests(f.store, f.client);
  assert.equal([...f.s.tables.ownerAcceptanceRequests.values()][0].state, 'accepted');
  assert.equal(f.store.load().channelMoves.filter(m => m.id === req.operationId).length, 1);
});

test('an independent pulled binding does not consume the canonical owner’s requests', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'original owner only\n' });
  const req = await f.request(view);
  updateHostState(f.store, state => {
    state.binding.acceptanceOwner = false;
  });
  const result = await consumeOwnerRequests(f.store, {
    mutation: async () => {
      throw new Error('must not contact hosted');
    },
  });
  assert.equal(result.consumed, 0);
  assert.equal(main(f), f.base);
  assert.equal([...f.s.tables.ownerAcceptanceRequests.values()][0].state, 'requested');
  assert.throws(() => acceptOwnerRequest(f.store, req), /bound native owner/);
});

test('independent pull activity cannot project its local acceptance as canonical hosted main', t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'independent source\n' });
  const lane = nativeExecute(
    f.store,
    { action: 'lane', intentId: view.intentId, name: 'Independent input' },
    f.store.revision(),
  ).result;
  f.store.locked(() => {
    const data = f.store.load();
    data.views.find(v => v.id === view.id).inputs = [{ laneId: lane.id, head: lane.head }];
    data.revision++;
    f.store.save(data);
  });
  const operationId = randomUUID();
  nativeExecute(
    f.store,
    {
      action: 'accept-channel',
      operationId,
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: f.base,
    },
    f.store.revision(),
  );
  updateHostState(f.store, state => {
    state.binding.acceptanceOwner = false;
    state.binding.autoSync = true;
  });
  queueAgentSync(
    f.store,
    { action: 'accept', viewId: view.id, expectedHead: view.head, expectedPrevious: f.base },
    { acceptanceId: operationId, viewId: view.id },
  );
  const pending = readHostState(f.store).agentSync.pending;
  assert.ok(pending.length);
  const entries = pending.flatMap(p => JSON.parse(p.metadata).entries);
  assert.ok(entries.some(e => e.collection === 'lanes'));
  assert.equal(
    entries.some(e => ['channels', 'channelMoves'].includes(e.collection)),
    false,
  );
});

test('legacy binding without an explicit role is not a canonical consumer', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'legacy must not land\n' });
  const req = await f.request(view);
  updateHostState(f.store, state => {
    delete state.binding.acceptanceOwner;
  });
  assert.equal(
    (
      await consumeOwnerRequests(f.store, {
        mutation: async () => {
          throw Error('must not contact hosted');
        },
      })
    ).consumed,
    0,
  );
  assert.throws(() => acceptOwnerRequest(f.store, req), /bound native owner/);
  assert.equal(main(f), f.base);
});

const lifecycleRequest = async (f, target, action, extra = {}) => {
  const collection = 'state' in target ? 'lanes' : 'intents';
  f.indexed(collection, target.id, target);
  return lifecycleBackend.request._handler(f.s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    command: JSON.stringify({
      action,
      collection,
      id: target.id,
      expectedHead: target.head ?? target.base,
      expectedState: target.state ?? target.status,
      reason: '',
      saveFirst: false,
      cascade: false,
      ...extra,
    }),
  });
};

test('owner lifecycle waits offline, completes and reopens without moving main; retries cannot reapply completion', async t => {
  const f = fixture(t),
    view = f.addView();
  const intent = f.store.select('intents', view.intentId);
  const req = await lifecycleRequest(f, intent, 'complete', { reason: 'Delivered and reviewed' });
  assert.equal(f.store.select('intents', intent.id).status, 'active');
  let lose = true;
  const transport = {
    mutation: async (ref, args) => {
      const result = await f.client.mutation(ref, args);
      if (lose && getFunctionName(ref) === 'projectOwnerSync:publish') {
        lose = false;
        throw Error('lost lifecycle publication');
      }
      return result;
    },
  };
  await assert.rejects(consumeOwnerRequests(f.store, transport), /lost lifecycle publication/);
  assert.equal(f.store.select('intents', intent.id).status, 'completed');
  assert.equal(f.store.select('intents', intent.id).lifecycle.at(-1).reason, 'Delivered and reviewed');
  nativeExecute(
    f.store,
    { action: 'intent-status', intentId: intent.id, status: 'active' },
    f.store.revision(),
  );
  await consumeOwnerRequests(f.store, f.client);
  assert.equal(
    [...f.s.tables.ownerAcceptanceRequests.values()].find(r => r.operationId === req.operationId).state,
    'accepted',
  );
  assert.equal(JSON.parse(f.s.tables.projectWorkRecords.get(`intents:${intent.id}`).value).status, 'active');
  await lifecycleRequest(f, f.store.select('intents', intent.id), 'reopen');
  await consumeOwnerRequests(f.store, f.client);
  assert.equal(f.store.select('intents', intent.id).status, 'active');
  const { applyOwnerLifecycle } = await import('../dist/owner-lifecycle.js');
  applyOwnerLifecycle(f.store, JSON.parse(req.lifecycle), req.operationId, { kind: 'person', name: 'owner' });
  assert.equal(f.store.select('intents', intent.id).status, 'active');
  assert.equal(
    f.store.select('intents', intent.id).lifecycle.filter(e => e.operation?.id === req.operationId).length,
    1,
  );
  assert.equal(main(f), f.base);
});

test('abandon preserves dirty edits unless save-first is explicit, then reopens the retained Lane', async t => {
  const f = fixture(t),
    view = f.addView();
  const lane = nativeExecute(
    f.store,
    { action: 'lane', intentId: view.intentId, name: 'Synthetic dirty Lane' },
    f.store.revision(),
  ).result;
  writeFileSync(join(f.store.path(lane.id), 'a.txt'), 'unsaved retained\n');
  const first = await lifecycleRequest(f, lane, 'abandon', { reason: 'No longer needed' });
  await consumeOwnerRequests(f.store, f.client);
  const rejected = [...f.s.tables.ownerAcceptanceRequests.values()].find(
    r => r.operationId === first.operationId,
  );
  assert.equal(JSON.parse(rejected.receipt).code, 'LANE_DIRTY');
  assert.equal(f.store.select('lanes', lane.id).state, 'active');
  const req = await lifecycleRequest(f, lane, 'abandon', { reason: 'No longer needed', saveFirst: true });
  await consumeOwnerRequests(f.store, f.client);
  const closed = f.store.select('lanes', lane.id);
  assert.equal(closed.state, 'abandoned');
  assert.notEqual(closed.head, lane.head);
  assert.equal(closed.lifecycle.at(-1).reason, 'No longer needed');
  assert.equal(closed.lifecycle.at(-1).actor.kind, 'person');
  assert.equal(
    [...f.s.tables.ownerAcceptanceRequests.values()].find(r => r.operationId === req.operationId).state,
    'accepted',
  );
  await lifecycleRequest(f, closed, 'reopen');
  await consumeOwnerRequests(f.store, f.client);
  assert.equal(f.store.select('lanes', lane.id).state, 'active');
  assert.equal(main(f), f.base);
});

test('lifecycle stale pins, foreign authority, changed retries and unsupported cancel are rejected', async t => {
  const f = fixture(t),
    view = f.addView(),
    intent = f.store.select('intents', view.intentId);
  const req = await lifecycleRequest(f, intent, 'complete');
  f.s.caller('stranger');
  await assert.rejects(lifecycleRequest(f, intent, 'reopen'), /project|owner/i);
  f.s.caller('owner');
  await assert.rejects(
    lifecycleBackend.request._handler(f.s.ctx, {
      projectId: 'project',
      operationId: req.operationId,
      command: req.lifecycle.replace('complete', 'reopen'),
    }),
    /original lifecycle/,
  );
  await assert.rejects(lifecycleRequest(f, intent, 'cancel'));
  nativeExecute(
    f.store,
    { action: 'intent-status', intentId: intent.id, status: 'abandoned' },
    f.store.revision(),
  );
  await consumeOwnerRequests(f.store, f.client);
  assert.equal([...f.s.tables.ownerAcceptanceRequests.values()][0].state, 'rejected');
  assert.equal(f.store.select('intents', intent.id).status, 'abandoned');
});

test('compensating revert accepts a new checked descendant while preserving a later disjoint change', async t => {
  const f = fixture(t),
    a = f.addView({ 'a.txt': 'first change\n' });
  await f.request(a);
  await consumeOwnerRequests(f.store, f.client);
  const b = f.addView({ 'b.txt': 'later change\n' }, main(f));
  await f.request(b, { expectedMain: main(f) });
  await consumeOwnerRequests(f.store, f.client);
  const before = main(f),
    revert = f.addView({ 'a.txt': 'base a\n' }, before);
  const work = new WorkService(f.root);
  const check = nativeExecute(
    f.store,
    {
      action: 'define-check',
      name: 'Synthetic revert bytes',
      executable: process.execPath,
      args: [
        '-e',
        "const fs=require('node:fs');if(fs.readFileSync('a.txt','utf8')!=='base a\\n'||fs.readFileSync('b.txt','utf8')!=='later change\\n')process.exit(1)",
      ],
    },
    f.store.revision(),
  ).result;
  const runId = randomUUID();
  await work.dispatch(
    {
      action: 'run-check',
      operationId: runId,
      viewId: revert.id,
      expectedHead: revert.head,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: work.status().environment.fingerprint,
    },
    f.store.revision(),
  );
  for (
    let i = 0;
    i < 300 &&
    !['passed', 'failed', 'cancelled', 'interrupted'].includes(f.store.select('runs', runId)?.status);
    i++
  )
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.store.select('runs', runId).status, 'passed');
  trustAgents(f.root);
  f.s.tables.cliCredentials.set('device', {
    _id: 'device',
    _creationTime: 1,
    credentialId: 'device',
    owner: 'owner',
    scope: 'cli',
    expiresAt: Date.now() + 60000,
    revoked: false,
  });
  f.s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'device' });
  const req = await f.request(revert, { expectedMain: before });
  assert.equal(req.actorKind, 'agent');
  await consumeOwnerRequests(f.store, f.client);
  assert.equal(main(f), revert.head);
  assert.ok(f.source.ancestors(main(f)).has(before));
  assert.ok(f.store.load().channelMoves.some(m => m.head === a.head));
  const files = f.source.state(main(f)).files;
  assert.equal(f.source.object(files.find(x => x.path === 'a.txt').blob).toString(), 'base a\n');
  assert.equal(f.source.object(files.find(x => x.path === 'b.txt').blob).toString(), 'later change\n');
  assert.ok(f.store.load().channelMoves.find(m => m.id === req.operationId));
});

test('an agent under trusted policy still needs passing exact-View evidence', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'unchecked agent proposal\n' });
  trustAgents(f.root);
  f.s.tables.cliCredentials.set('device', {
    _id: 'device',
    _creationTime: 1,
    credentialId: 'device',
    owner: 'owner',
    scope: 'cli',
    expiresAt: Date.now() + 60000,
    revoked: false,
  });
  f.s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'device' });
  const req = await f.request(view);
  await consumeOwnerRequests(f.store, f.client);
  const row = [...f.s.tables.ownerAcceptanceRequests.values()].find(r => r.operationId === req.operationId);
  assert.equal(row.state, 'rejected');
  assert.equal(JSON.parse(row.receipt).code, 'CHECK_REQUIRED');
  assert.equal(main(f), f.base);
});

test('hosted-work agent downscope keeps account JWT requests subject to agent policy', async t => {
  const f = fixture(t),
    view = f.addView({ 'a.txt': 'JWT agent proposal\n' });
  const req = await f.request(view, { agent: true });
  assert.equal(req.actorKind, 'agent');
  await consumeOwnerRequests(f.store, f.client);
  const row = [...f.s.tables.ownerAcceptanceRequests.values()].find(r => r.operationId === req.operationId);
  assert.equal(row.state, 'rejected');
  assert.equal(JSON.parse(row.receipt).code, 'REVIEW_REQUIRED');
  assert.equal(main(f), f.base);
  await assert.rejects(f.request(view, { operationId: req.operationId }), /original acceptance/);
});

test('Intent abandon requires explicit cascade and retains both Lane lifecycles without moving main', async t => {
  const f = fixture(t),
    view = f.addView();
  const intent = f.store.select('intents', view.intentId);
  const lanes = ['A', 'B'].map(
    name => nativeExecute(f.store, { action: 'lane', intentId: intent.id, name }, f.store.revision()).result,
  );
  const first = await lifecycleRequest(f, intent, 'abandon', { reason: 'Superseded outcome' });
  await consumeOwnerRequests(f.store, f.client);
  const row = [...f.s.tables.ownerAcceptanceRequests.values()].find(r => r.operationId === first.operationId);
  assert.equal(JSON.parse(row.receipt).code, 'INTENT_OPEN_LANES');
  assert.equal(f.store.select('intents', intent.id).status, 'active');
  const req = await lifecycleRequest(f, intent, 'abandon', { reason: 'Superseded outcome', cascade: true });
  await consumeOwnerRequests(f.store, f.client);
  for (const lane of lanes) {
    const result = f.store.select('lanes', lane.id);
    assert.equal(result.state, 'abandoned');
    assert.equal(result.lifecycle.at(-1).operation.id, req.operationId);
    assert.equal(result.lifecycle.at(-1).actor.kind, 'person');
  }
  assert.equal(f.store.select('intents', intent.id).status, 'abandoned');
  assert.equal(main(f), f.base);
});

test('overlap recovery recomposes on latest main and queues one real check without accepting; replay retains View/run pins', async t => {
  const f = fixture(t);
  const seed = f.addView({ 'a.txt': 'one\nmiddle\ntwo\n' });
  await f.request(seed);
  await consumeOwnerRequests(f.store, f.client);
  const original = f.addView({ 'a.txt': 'one\nmiddle\nreviewed two\n' }, seed.head);
  const advanced = f.addView({ 'a.txt': 'latest one\nmiddle\ntwo\n' }, seed.head);
  await f.request(advanced, { expectedMain: seed.head });
  await consumeOwnerRequests(f.store, f.client);
  await f.request(original, { expectedMain: seed.head });
  await consumeOwnerRequests(f.store, f.client);
  const prior = await backend.status._handler(f.s.ctx, { projectId: 'project', viewId: original.id });
  assert.equal(JSON.parse(prior.request.receipt).code, 'NEEDS_RECHECK');
  nativeExecute(
    f.store,
    {
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: [
        '-e',
        `if(require('node:fs').readFileSync('a.txt','utf8')!==${JSON.stringify('latest one\nmiddle\nreviewed two\n')})process.exit(1)`,
      ],
    },
    f.store.revision(),
  );
  const req = await f.request(original, { recheck: true, expectedMain: advanced.head });
  let lose = true;
  const flaky = {
    mutation: async (ref, args) => {
      const result = await f.client.mutation(ref, args);
      if (lose && getFunctionName(ref) === 'projectOwnerSync:publish') {
        lose = false;
        throw Error('lost recheck publication');
      }
      return result;
    },
  };
  await assert.rejects(consumeOwnerRequests(f.store, flaky), /lost recheck publication/);
  await consumeOwnerRequests(f.store, f.client);
  const status = await backend.status._handler(f.s.ctx, {
    projectId: 'project',
    viewId: original.id,
    channel: 'recheck',
  });
  const receipt = JSON.parse(status.request.receipt);
  assert.equal(receipt.recheck.sourceViewId, original.id);
  assert.equal(receipt.recheck.sourceHead, original.head);
  const next = f.store.select('views', receipt.recheck.viewId);
  assert.ok(f.source.ancestors(next.head).has(advanced.head));
  assert.ok(f.source.ancestors(next.head).has(original.head));
  const work = new WorkService(f.root);
  for (
    let i = 0;
    i < 300 &&
    !['passed', 'failed', 'cancelled', 'interrupted'].includes(
      f.store.select('runs', receipt.recheck.runId).status,
    );
    i++
  )
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.store.select('runs', receipt.recheck.runId).status, 'passed');
  assert.equal(main(f), advanced.head);
  assert.equal(f.store.load().runs.filter(run => run.viewId === next.id).length, 1);
  assert.equal(
    (await f.request(original, { recheck: true, operationId: req.operationId, expectedMain: advanced.head }))
      .receipt,
    status.request.receipt,
  );
  assert.equal(
    (await backend.status._handler(f.s.ctx, { projectId: 'project', viewId: original.id })).request.state,
    'rejected',
  );
  assert.equal(
    f.store.load().channelMoves.some(move => move.id === req.operationId),
    false,
  );
});

test('re-check retains an explicit conflict View instead of queuing a check or accepting overlapping bytes', async t => {
  const f = fixture(t),
    a = f.addView({ 'a.txt': 'main line\n' }),
    b = f.addView({ 'a.txt': 'reviewed line\n' });
  await f.request(a);
  await consumeOwnerRequests(f.store, f.client);
  const req = await f.request(b, { recheck: true, expectedMain: a.head });
  await consumeOwnerRequests(f.store, f.client);
  const row = [...f.s.tables.ownerAcceptanceRequests.values()].find(
    row => row.operationId === req.operationId,
  );
  const result = JSON.parse(row.receipt);
  assert.equal(result.code, 'COMPOSITION_CONFLICT');
  assert.equal(f.store.select('views', result.recheck.viewId).status, 'conflict');
  assert.equal(f.store.load().runs.length, 0);
  assert.equal(main(f), a.head);
});

test('reactive wake is read-only, scoped, epoch-fenced and selects the next request', async t => {
  const f = fixture(t);
  const input = { projectId: 'project', ownerId: f.ownerId };
  const pending = () => backend.pending._handler(f.s.ctx, input);
  const before = structuredClone(f.s.tables);
  assert.deepEqual(await pending(), { operationId: null, indexReady: true });
  assert.deepEqual(f.s.tables, before);
  const a = await f.request(f.addView());
  const b = await f.request(f.addView());
  assert.equal((await pending()).operationId, a.operationId);
  await consumeOwnerRequests(f.store, f.client);
  assert.equal((await pending()).operationId, b.operationId);
  await assert.rejects(
    backend.pending._handler(f.s.ctx, { ...input, ownerId: 'other' }),
    error => error.data.code === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    backend.pending._handler(f.s.ctx, { ...input, authorityEpoch: 9 }),
    error => error.data.code === 'SOURCE_AUTHORITY_STALE',
  );
  f.s.tables.projectWorkGenerations.get('generation').status = 'building';
  assert.equal((await pending()).indexReady, false);
  f.s.ctx.auth.getUserIdentity = async () => null;
  await assert.rejects(pending(), error => error.data.code === 'PROJECT_UNAVAILABLE');
});

function fakeSubscription() {
  const connections = [];
  return {
    connections,
    connect() {
      const client = {
        closed: 0,
        unsubscribed: 0,
        onUpdate(ref, args, update, error) {
          assert.equal(getFunctionName(ref), 'ownerAcceptance:pending');
          Object.assign(client, { args, update, error });
          return () => client.unsubscribed++;
        },
        async close() {
          client.closed++;
        },
      };
      connections.push(client);
      return client;
    },
  };
}
const settled = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

test('idle acceptance owner sends zero mutation calls for an hour, then claims each request once in three calls', async t => {
  const f = fixture(t),
    live = fakeSubscription();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  let calls = 0;
  const transport = {
    mutation: async (...args) => {
      calls++;
      return f.client.mutation(...args);
    },
  };
  const stop = startOwnerAcceptanceListener(
    f.store,
    assert.ifError,
    () => consumeOwnerRequests(f.store, transport),
    live.connect,
  );
  t.after(stop);
  const client = live.connections[0];
  assert.equal(client.args.ownerId, f.ownerId);
  client.update({ operationId: null, indexReady: true });
  t.mock.timers.tick(3_600_000);
  await settled();
  assert.equal(calls, 0);
  const a = await f.request(f.addView()),
    b = await f.request(f.addView());
  client.update({ operationId: a.operationId, indexReady: true });
  client.update({ operationId: a.operationId, indexReady: true });
  await settled();
  // Closing also waits for the real asynchronous local queue/acceptance work.
  await stop();
  assert.equal(calls, 3);
  assert.equal(f.s.tables.ownerAcceptanceRequests.size, 2);
  assert.equal(
    [...f.s.tables.ownerAcceptanceRequests.values()].find(r => r.operationId === b.operationId).state,
    'requested',
  );
});

test('subscription error reconnects with backoff without idle polling or duplicate acceptance', async t => {
  const f = fixture(t),
    live = fakeSubscription();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let calls = 0;
  const stop = startOwnerAcceptanceListener(
    f.store,
    () => {},
    async () => {
      calls++;
      return { consumed: 1, operationId: 'request' };
    },
    live.connect,
  );
  const first = live.connections[0];
  first.update({ operationId: 'request', indexReady: true });
  await settled();
  first.error(new Error('synthetic disconnect'));
  assert.equal(first.closed, 1);
  t.mock.timers.tick(999);
  await settled();
  assert.equal(live.connections.length, 1);
  t.mock.timers.tick(1);
  await settled();
  assert.equal(live.connections.length, 2);
  live.connections[1].update({ operationId: 'request', indexReady: true });
  await settled();
  assert.equal(calls, 1);
  t.mock.timers.tick(3_600_000);
  await settled();
  assert.equal(calls, 1);
  await stop();
  assert.equal(live.connections[1].closed, 1);
});

test('listener retries known interrupted requests and close waits for the active consumer', async t => {
  const f = fixture(t),
    live = fakeSubscription();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release,
    calls = 0,
    errors = 0;
  const stop = startOwnerAcceptanceListener(
    f.store,
    () => errors++,
    () => {
      calls++;
      return new Promise((_resolve, reject) => {
        release = reject;
      });
    },
    live.connect,
  );
  live.connections[0].update({ operationId: 'request', indexReady: true });
  let closed = false;
  const closing = stop().then(() => {
    closed = true;
  });
  await settled();
  assert.equal(closed, false);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1);
  release(new Error('synthetic interrupted consume'));
  await closing;
  assert.equal(errors, 1);
  t.mock.timers.tick(10_000);
  await stop();
  assert.equal(calls, 1);
});

test('owner start and index-ready event release sync backoff once, with no idle sync activity', async t => {
  const f = fixture(t),
    live = fakeSubscription();
  const operationId = randomUUID();
  updateHostState(f.store, state => {
    state.binding.autoSync = true;
    state.agentSync = {
      sequence: 1,
      pending: [
        {
          operationId,
          projectId: 'project',
          deployment: state.binding.deployment,
          activity: { sessionId: 'synthetic', sequence: 1 },
          metadata: JSON.stringify({ revision: 1, entries: [{ collection: 'lanes' }] }),
        },
      ],
      unprepared: JSON.stringify([state.binding.operationId, state.binding.backupId, undefined]),
      nextAttemptAt: Date.now() + 300_000,
    };
  });
  let wakes = 0;
  const stop = startOwnerAcceptanceListener(
    f.store,
    assert.ifError,
    async () => ({ consumed: 0 }),
    live.connect,
    () => {
      wakes++;
      return false;
    },
  );
  assert.equal(wakes, 1);
  assert.equal(readHostState(f.store).agentSync.nextAttemptAt, undefined);
  const client = live.connections[0];
  client.update({ operationId: null, indexReady: false });
  updateHostState(f.store, state => {
    state.agentSync.nextAttemptAt = Date.now() + 300_000;
  });
  client.update({ operationId: null, indexReady: true });
  assert.equal(wakes, 2);
  assert.equal(readHostState(f.store).agentSync.nextAttemptAt, undefined);
  client.update({ operationId: null, indexReady: true });
  assert.equal(wakes, 2);
  await stop();
});

test('pending wake reads at most five documents and writes none at double the 560-Lane dogfood scale', async t => {
  const f = fixture(t);
  for (let i = 0; i < 1120; i++)
    f.s.tables.ownerAcceptanceRequests.set(`synthetic-${i}`, {
      _id: `synthetic-${i}`,
      _creationTime: i,
      projectId: 'project',
      ownerId: f.ownerId,
      operationId: `operation-${i}`,
      state: 'requested',
    });
  let reads = 0,
    writes = 0;
  const db = f.s.ctx.db,
    get = db.get.bind(db),
    query = db.query.bind(db);
  db.get = async (...args) => {
    const value = await get(...args);
    reads += value ? 1 : 0;
    return value;
  };
  db.query = (...args) => {
    const q = query(...args);
    const take = q.take.bind(q);
    q.take = async count => {
      const rows = await take(count);
      reads += rows.length;
      return rows;
    };
    return q;
  };
  for (const name of ['insert', 'patch', 'replace', 'delete']) {
    const original = db[name].bind(db);
    db[name] = async (...args) => {
      writes++;
      return original(...args);
    };
  }
  const started = performance.now();
  const wake = await backend.pending._handler(f.s.ctx, { projectId: 'project', ownerId: f.ownerId });
  assert.equal(wake.operationId, 'operation-0');
  assert.ok(reads <= 5);
  assert.equal(writes, 0);
  t.diagnostic(
    JSON.stringify({
      requests: 1120,
      queryCalls: 1,
      documentsRead: reads,
      documentsWritten: writes,
      wallMs: performance.now() - started,
    }),
  );
});

test('known-request failure retries with backoff; a following request wakes without another poll', async t => {
  const f = fixture(t),
    live = fakeSubscription();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let calls = 0,
    errors = 0;
  const stop = startOwnerAcceptanceListener(
    f.store,
    () => errors++,
    async () => {
      calls++;
      if (calls === 1) throw new Error('synthetic lost reply');
      return { consumed: 1, operationId: calls === 2 ? 'first' : 'second' };
    },
    live.connect,
  );
  const client = live.connections[0];
  client.update({ operationId: 'first', indexReady: true });
  await settled();
  assert.equal(calls, 1);
  t.mock.timers.tick(999);
  await settled();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await settled();
  assert.equal(calls, 2);
  client.update({ operationId: 'second', indexReady: true });
  await settled();
  assert.equal(calls, 3);
  client.update({ operationId: null, indexReady: true });
  t.mock.timers.tick(3_600_000);
  await settled();
  assert.equal(calls, 3);
  assert.equal(errors, 1);
  await stop();
});

test('84-item metadata backlog retains a 168-call and bounded document budget with real backend fakes', async t => {
  const f = fixture(t);
  const pending = Array.from({ length: 84 }, (_, i) => ({
    operationId: randomUUID(),
    projectId: 'project',
    deployment: 'http://127.0.0.1:1',
    activity: {
      kind: 'activity',
      sessionId: randomUUID(),
      sequence: 1,
      name: 'Synthetic',
      environment: 'Synthetic',
      status: 'working',
      summary: 'Synthetic budget',
      context: {},
    },
    metadata: JSON.stringify({
      ownerId: f.ownerId,
      revision: i + 1,
      entries: [
        {
          collection: 'lanes',
          key: `lane-${i}`,
          parent: 'intent',
          value: { id: `lane-${i}`, state: 'active' },
        },
      ],
    }),
  }));
  updateHostState(f.store, state => {
    state.binding.autoSync = true;
    state.agentSync = { sequence: 84, pending };
  });
  let calls = 0,
    reads = 0,
    writes = 0;
  const db = f.s.ctx.db,
    get = db.get.bind(db),
    query = db.query.bind(db);
  db.get = async (...args) => {
    reads++;
    return get(...args);
  };
  db.query = (...args) => {
    const q = query(...args);
    for (const name of ['take', 'unique', 'collect']) {
      if (!q[name]) continue;
      const original = q[name].bind(q);
      q[name] = async (...args) => {
        const result = await original(...args);
        reads += Array.isArray(result) ? result.length : 1;
        return result;
      };
    }
    return q;
  };
  for (const name of ['insert', 'patch', 'replace', 'delete']) {
    const original = db[name].bind(db);
    db[name] = async (...args) => {
      writes++;
      return original(...args);
    };
  }
  const start = performance.now();
  await flushAgentSync(f.store, {
    mutation: async (ref, args) => {
      calls++;
      return (getFunctionName(ref) === 'projectOwnerSync:publish' ? sync : coordination).publish._handler(
        f.s.ctx,
        args,
      );
    },
  });
  assert.equal(readHostState(f.store).agentSync.pending.length, 0);
  assert.equal(calls, 168);
  assert.ok(reads <= 84 * 30);
  assert.ok(writes <= 84 * 12);
  t.diagnostic(
    JSON.stringify({
      items: 84,
      calls,
      documentsRead: reads,
      documentsWritten: writes,
      wallMs: performance.now() - start,
    }),
  );
});

test('reconnect retains owner scope and refreshes an authority epoch learned from the query error', async t => {
  const f = fixture(t),
    live = fakeSubscription();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = startOwnerAcceptanceListener(
    f.store,
    () => {},
    async () => ({ consumed: 0 }),
    live.connect,
  );
  live.connections[0].error(
    new ConvexError({
      code: 'SOURCE_AUTHORITY_STALE',
      message: 'Synthetic epoch change',
      authority: { mode: 'native-owner', epoch: 2 },
    }),
  );
  t.mock.timers.tick(1000);
  await settled();
  assert.equal(live.connections.length, 2);
  assert.equal(live.connections[1].args.projectId, 'project');
  assert.equal(live.connections[1].args.ownerId, f.ownerId);
  assert.equal(live.connections[1].args.authorityEpoch, 2);
  await stop();
});
