// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { hostedAgentActions } from '../dist/hosted-agent-contract.js';
import { readLaneEntry, recordLane } from '../dist/lane-registry.js';
import { readHostedCliStatus } from '../dist/hosted-cli-status.js';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { clientCacheRoot } from '../dist/root-paths.js';

const downloads = calls => calls.filter(call => call.name.startsWith('projectObjectDownloads')).length;
function stateHome(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-state-')),
    saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Serve checkout bytes through signed URLs, as the deployment does for start's checkout. */
function signedDownloads(t, s) {
  const mutation = s.exchange.client.mutation,
    original = globalThis.fetch;
  s.exchange.client.mutation = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectObjectDownloads:describe') return mutation(ref, args);
    s.calls.push({ name: 'projectObjectDownloads:describe', args });
    return args.digests.map(digest => ({
      digest,
      size: s.objects.get(digest).length,
      location: 'r2',
      url: `https://fixture.invalid/object/${digest}`,
    }));
  };
  globalThis.fetch = async url => new Response(s.objects.get(String(url).split('/').at(-1)));
  t.after(() => (globalThis.fetch = original));
}

test('start reports the Lane before its checkout and opens it at the chosen path', async t => {
  stateHome(t);
  const s = agentFixture(t);
  signedDownloads(t, s);
  const path = join(s.root, '..', 'lanes', 'mine'),
    transport = s.transport();
  const started = [];
  transport.onStarted = lane => started.push({ ...lane, downloadsSoFar: downloads(s.calls) });
  const response = await transport.dispatch('start', { outcome: 'Placed Lane', path });
  assert.deepEqual(started, [{ laneId: s.lane.laneId, path, downloadsSoFar: 0 }]);
  const real = join(realpathSync(join(s.root, '..', 'lanes')), 'mine');
  assert.equal(response.result.path, real);
  assert(existsSync(join(path, '.forge', 'hosted-lane.json')));
  assert.deepEqual(response.result.dependencies, { status: 'none' });
  assert.equal(readLaneEntry(s.lane.laneId).root, real);
  assert.equal(readLaneEntry(s.lane.laneId).outcome, 'Placed Lane');
  // path and open are client placement, not request identity: the server request is unchanged.
  const args = s.calls.find(call => call.name === 'projectHostedStart:start').args,
    request = args.request ? JSON.parse(args.request) : args;
  assert.equal(request.intent.outcome, 'Placed Lane');
  assert(!('path' in request) && !('open' in request));
});

test('starting a follow-up in a completed Lane folder refuses before creating another Lane', async t => {
  stateHome(t);
  const s = agentFixture(t);
  signedDownloads(t, s);
  const path = join(s.root, '..', 'finished');
  const first = { outcome: 'First change', path, operationId: randomUUID() };
  s.lane.state = 'completed';
  await s.transport().dispatch('start', first);
  const completed = s.lane.laneId;
  assert.equal((await s.transport().dispatch('start', first)).result.lane.laneId, completed);
  const inside = new HostedAgentTransport(path, s.address, s.exchange);
  const edits = join(path, 'follow-up.txt');
  writeFileSync(edits, 'keep this edit');
  s.lane.laneId = randomUUID();
  s.lane.state = 'active';
  const before = s.calls.length;
  const journals = join(clientCacheRoot(path), 'agent');
  const journalNames = () =>
    existsSync(journals)
      ? readdirSync(journals).filter(name => name.startsWith('auto-') || /^[0-9a-f-]{36}\.json$/.test(name))
      : [];
  const originals = journalNames();
  let retry;
  await assert.rejects(
    inside.dispatch('start', { outcome: 'Follow-up change', path, carryEdits: true }),
    error => {
      assert.equal(error.code, 'WORK_CONFLICT');
      assert(error.message.includes(completed));
      assert.match(error.recovery.command, / start /);
      retry = error.recovery.next.parameters;
      assert.deepEqual(retry, { outcome: 'Follow-up change', carryEdits: true });
      return true;
    },
  );
  assert(!s.calls.slice(before).some(call => call.name === 'projectHostedStart:start'));
  assert.deepEqual(journalNames(), originals, 'a refused start records no operation or auto index');
  assert.equal(readHostedLaneCheckout(path).selection.laneId, completed);
  assert.equal(readFileSync(edits, 'utf8'), 'keep this edit');
  const followUp = await inside.dispatch('start', retry);
  assert.equal(followUp.result.lane.laneId, s.lane.laneId);
  assert.equal(followUp.result.previousLane, undefined);
  assert.notEqual(followUp.result.path, realpathSync(path));
});

test('start sends a local hook opt-out only to a server that accepts it, on the existing mutation', async t => {
  stateHome(t);
  const config = mkdtempSync(join(tmpdir(), 'forge-hook-config-'));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  const settings = join(config, 'client.json');
  const previous = process.env.FORGE_CLIENT_SETTINGS;
  process.env.FORGE_CLIENT_SETTINGS = settings;
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_CLIENT_SETTINGS;
    else process.env.FORGE_CLIENT_SETTINGS = previous;
  });
  writeFileSync(settings, JSON.stringify({ firstWriteHooks: false }));
  const s = agentFixture(t);
  s.caps.features = ['agent-slug'];
  const transport = s.transport();
  await transport.dispatch('start', { outcome: 'Older server', open: false });
  s.caps.features.push('agent-hooks-state');
  s.lane.laneId = randomUUID();
  await transport.dispatch('start', { outcome: 'Current server', open: false });
  const starts = s.calls.filter(call => call.name === 'projectHostedStart:start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].args.hooks, undefined);
  assert.equal(starts[1].args.hooks, 'off');
});

test('a completed checkout exposes the captured Item id returned on the existing start mutation', async t => {
  stateHome(t);
  const s = agentFixture(t);
  s.caps.features = ['start-planning-item'];
  signedDownloads(t, s);
  const mutate = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    const result = await mutate(ref, args);
    if (getFunctionName(ref) !== 'projectHostedStart:start') return result;
    const started = JSON.parse(result);
    return JSON.stringify({ ...started, planningItemId: started.intentId });
  };
  const path = join(s.root, '..', 'lanes', 'captured');
  const reply = await s.transport().dispatch('start', { outcome: 'Publish the linked Item', path });
  const starts = s.calls.filter(call => call.name === 'projectHostedStart:start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].args.planningItemIdVersion, 1);
  assert.equal(reply.result.planningItemId, s.lane.intentId);
});

test('Lane status names a live approval and keeps the status call budget for old and settled entries', async t => {
  stateHome(t);
  const s = agentFixture(t);
  signedDownloads(t, s);
  const path = join(s.root, '..', 'lanes', 'status');
  const started = await s.transport().dispatch('start', { outcome: 'Observe a held landing', path });
  const root = started.result.path;
  const transport = new HostedAgentTransport(root, s.address, s.exchange);
  const operationId = randomUUID();
  recordLane({ laneId: s.lane.laneId, landing: { operationId, at: Date.now() } });
  const review = { approver: 'river', url: 'https://fixture.invalid/approve?selection=fixture' };
  let pending = true;
  const query = s.exchange.client.query;
  s.exchange.client.query = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectHostedFinishObserve:page') {
      s.calls.push({ name, args });
      assert.equal(args.operationId, operationId);
      return {
        pendingAttempt: null,
        submission: {
          operationId,
          phase: pending ? 'ready' : 'landed',
          observation: pending
            ? { state: 'pending', pendingReason: 'waiting-for-review' }
            : { state: 'landed' },
        },
        ...(pending ? review : {}),
      };
    }
    return query(ref, args);
  };
  const capabilities = 'projectHostedAgent:capabilities';
  const observation = 'projectHostedFinishObserve:page';
  const overlap = 'projectHostedOverlaps:read';
  const status = async expected => {
    s.calls.length = 0;
    const result = await readHostedCliStatus(root, transport);
    assert.deepEqual(
      s.calls.map(call => call.name),
      expected,
    );
    return result;
  };
  assert.equal((await status([capabilities])).value.landingHold, undefined, 'older server adds no call');
  s.caps.overlapVersion = 1;
  const held = await status([capabilities, observation]);
  assert(held.text.includes(`Held, waiting for @river. Open ${review.url}`));
  assert.deepEqual(held.value.landingHold.review, review);
  pending = false;
  assert.equal((await status([capabilities, observation])).value.landingHold, undefined);
  assert.equal(readLaneEntry(s.lane.laneId).landing, null);
  assert.equal((await status([capabilities, overlap])).value.landingHold, undefined);
});

test('start open:false returns pins only, with no checkout download', async t => {
  stateHome(t);
  const s = agentFixture(t),
    transport = s.transport();
  const started = [];
  transport.onStarted = lane => started.push(lane);
  const response = await transport.dispatch('start', {
    outcome: 'Pins only',
    open: false,
    path: join(s.root, '..', 'unused'),
  });
  assert.equal(response.result.lane.laneId, s.lane.laneId);
  assert.equal(response.result.path, undefined);
  assert.deepEqual(started, [{ laneId: s.lane.laneId, path: null }]);
  assert.equal(downloads(s.calls), 0);
  assert(!existsSync(join(s.root, '..', 'unused')));
  await assert.rejects(transport.dispatch('start', { outcome: 'Bad', open: 'no' }), { code: 'BAD_ARGUMENT' });
});

test('clone defaults keep full Lane identity and recover the same path after folded titles collide', async t => {
  stateHome(t);
  const s = agentFixture(t);
  signedDownloads(t, s);
  mkdirSync(join(s.root, '.forge'), { recursive: true });
  writeFileSync(join(s.root, '.forge', 'hosted-main.json'), JSON.stringify({ selection: s.main }));
  const parent = `${realpathSync(s.root)}.forge-client/lanes`;
  const command = { outcome: '../ Révise tax rules!', operationId: randomUUID() };
  const firstId = '01234567-0000-4000-8000-000000000001';
  s.lane.laneId = firstId;
  const start = await s.transport().dispatch('start', command);
  const first = join(parent, 'revise-tax-rules-01234567');
  assert.equal(start.result.path, first);
  assert.equal(start.result.lane.laneId, firstId);
  assert.equal(readHostedLaneCheckout(first).selection.laneId, firstId);

  const second = { outcome: 'Revise tax rules', operationId: randomUUID() };
  s.lane.laneId = '89abcdef-0000-4000-8000-000000000002';
  const sibling = await s.transport().dispatch('start', second);
  assert.equal(sibling.result.path, join(parent, 'revise-tax-rules-89abcdef'));
  // Two different ids with the same prefix must never share a checkout or its journal.
  s.lane.laneId = '01234567-0000-4000-8000-000000000003';
  const collision = await s.transport().dispatch('start', { ...second, operationId: randomUUID() });
  assert.equal(collision.result.path, join(parent, s.lane.laneId));
  assert.equal(readHostedLaneCheckout(first).selection.laneId, firstId);

  s.lane.laneId = firstId;
  const open = { laneId: firstId, operationId: randomUUID() };
  assert.equal((await s.transport().dispatch('open', open)).result.root, first);
  rmSync(first, { recursive: true });
  // Explicit operation ids name their receipts. The ordinary recovery opens the same folder.
  assert.equal((await s.transport().dispatch('open', { laneId: firstId })).result.root, first);
  assert.equal(readHostedLaneCheckout(first).selection.laneId, firstId);
  rmSync(first, { recursive: true });
  assert.equal((await s.transport().dispatch('start', command)).result.path, first);
  assert.equal(readHostedLaneCheckout(first).selection.laneId, firstId);
  assert(!existsSync(join(parent, firstId)));
});

test('start and open leave an existing UUID checkout at its original path', async t => {
  stateHome(t);
  const s = agentFixture(t);
  signedDownloads(t, s);
  mkdirSync(join(s.root, '.forge'), { recursive: true });
  writeFileSync(join(s.root, '.forge', 'hosted-main.json'), JSON.stringify({ selection: s.main }));
  const path = join(`${realpathSync(s.root)}.forge-client`, 'lanes', s.lane.laneId);
  await s.transport().dispatch('start', { outcome: 'An earlier build', path });
  const original = readFileSync(join(path, 'lane-edit.txt'), 'utf8');
  assert.equal((await s.transport().dispatch('start', { outcome: 'An earlier build' })).result.path, path);
  const reopened = await s.transport().dispatch('open', { laneId: s.lane.laneId });
  assert.equal(reopened.result.root, path);
  assert.equal(readFileSync(join(path, 'lane-edit.txt'), 'utf8'), original);
});

test('parallel starts with the same title and id prefix claim different checkout roots', async t => {
  stateHome(t);
  const s = agentFixture(t);
  signedDownloads(t, s);
  mkdirSync(join(s.root, '.forge'), { recursive: true });
  writeFileSync(join(s.root, '.forge', 'hosted-main.json'), JSON.stringify({ selection: s.main }));
  const ids = ['1234abcd-0000-4000-8000-000000000001', '1234abcd-0000-4000-8000-000000000002'];
  const operations = new Map(ids.map(id => [randomUUID(), id]));
  const mutation = s.exchange.client.mutation,
    query = s.exchange.client.query;
  s.exchange.client.mutation = (ref, args) => {
    if (getFunctionName(ref) !== 'projectHostedStart:start') return mutation(ref, args);
    return {
      schema: 1,
      operationId: args.operationId,
      intentId: s.lane.intentId,
      lane: { ...s.lane, laneId: operations.get(args.operationId) },
      at: '2026-01-01T00:00:00.000Z',
    };
  };
  s.exchange.client.query = (ref, args) =>
    getFunctionName(ref) === 'projectHostedLanes:select'
      ? { ...s.lane, laneId: args.laneId }
      : query(ref, args);
  const replies = await Promise.all(
    [...operations.keys()].map(operationId =>
      s.transport().dispatch('start', { outcome: 'Concurrent update', operationId }),
    ),
  );
  const paths = replies.map(reply => reply.result.path);
  assert.equal(new Set(paths).size, 2);
  assert.equal(paths.filter(path => path.endsWith('concurrent-update-1234abcd')).length, 1);
  assert.deepEqual(
    paths.map(path => readHostedLaneCheckout(path).selection.laneId),
    ids,
  );
});

test('a new titled sibling leaves an unrelated legacy short folder alone', async t => {
  stateHome(t);
  const s = agentFixture(t);
  signedDownloads(t, s);
  const path = join(s.root, '..', 'working');
  const first = await s.transport().dispatch('start', { outcome: 'First Lane', path });
  s.lane.laneId = 'c0ffee12-0000-4000-8000-000000000001';
  const occupied = `${first.result.path}-c0ffee12`;
  mkdirSync(occupied);
  writeFileSync(join(occupied, 'keep.txt'), 'unrelated');
  const response = await new HostedAgentTransport(first.result.path, s.address, s.exchange).dispatch(
    'start',
    {
      outcome: 'Read tax rules',
      model: 'unknown',
    },
  );
  assert.equal(response.result.path, join(first.result.path, '..', 'read-tax-rules-c0ffee12'));
  assert.equal(readFileSync(join(occupied, 'keep.txt'), 'utf8'), 'unrelated');
});

test('version skew names the upgrade step instead of a bare unsupported action', async t => {
  const s = agentFixture(t);
  await assert.rejects(s.transport().dispatch('teleport', { secret: 'private-value' }), error => {
    assert.equal(error.code, 'HOSTED_ACTION_UNSUPPORTED');
    assert.match(error.message, /Use capabilities/);
    assert.doesNotMatch(error.message, /Upgrade nforge/);
    assert.doesNotMatch(error.message, /private-value/);
    return true;
  });
  assert.equal(s.calls.length, 0);
  // A newer server advertises an action this CLI does not know: tolerated, then named on use.
  s.caps.actions = [...hostedAgentActions, 'teleport'];
  const discovered = await s.transport().dispatch('capabilities', {});
  assert(!discovered.result.actions.includes('teleport'));
  const calls = s.calls.length;
  await assert.rejects(s.transport().dispatch('teleport', {}), error => {
    assert.equal(error.code, 'CLI_UPGRADE_REQUIRED');
    assert.match(error.message, /offers hosted action teleport/);
    return true;
  });
  assert.equal(s.calls.length, calls, 'the refusal makes no network call');
  // An older server lacks an action this CLI knows.
  s.caps.actions = ['capabilities'];
  await assert.rejects(s.transport().dispatch('start', { outcome: 'Old server' }), error => {
    assert.equal(error.code, 'HOSTED_ACTION_UNSUPPORTED');
    assert.match(error.message, /does not offer hosted action start/);
    assert.match(error.message, /Use capabilities/);
    assert.doesNotMatch(error.message, /Retry the original/);
    return true;
  });
});

test('the land submitter replays its own finish while the save job runs, with identical parameters', async t => {
  const root = join(mkdtempSync(join(tmpdir(), 'forge-land-')), 'lane');
  t.after(() => rmSync(join(root, '..'), { recursive: true, force: true }));
  const address = { url: 'https://fixture.invalid', projectId: 'project' };
  const saveOperationId = randomUUID(),
    seen = [];
  const replies = [
    { phase: 'save', saveOperationId, progress: { status: 'retryable' } },
    { phase: 'save', saveOperationId, progress: { status: 'retryable' } },
    { phase: 'finish', submission: { phase: 'queued' } },
  ];
  const transport = {
    dispatch: async (action, command) => {
      seen.push([action, structuredClone(command)]);
      return { schema: 1, transport: 'hosted', action, operationId: randomUUID(), result: replies.shift() };
    },
  };
  const command = { laneId: randomUUID(), message: "It's multi\nline" };
  const response = await submitHostedLand(root, command, address, transport);
  assert.equal(response.result.submission.phase, 'queued');
  assert.equal(seen.length, 3);
  for (const [action, sent] of seen) assert.deepEqual([action, sent], ['finish', command]);
  // A failed save stops the loop: the agent sees it at once.
  replies.push({ phase: 'save', saveOperationId, progress: { status: 'failed' } });
  seen.length = 0;
  assert.equal((await submitHostedLand(root, command, address, transport)).result.progress.status, 'failed');
  assert.equal(seen.length, 1);
});

test('start from inside a Lane root places the new Lane beside it, never nested (6bde4ba6)', async t => {
  stateHome(t);
  const s = agentFixture(t);
  signedDownloads(t, s);
  const clone = join(s.root, '..', 'clone.forge-client', 'lanes'),
    first = join(clone, s.lane.laneId);
  await s.transport().dispatch('start', { outcome: 'First Lane', path: first });
  assert(existsSync(join(first, '.forge', 'hosted-lane.json')));
  // A second Lane starts from the first Lane's own folder (the shell is inside it).
  s.lane.laneId = randomUUID();
  const inside = Object.assign(new HostedAgentTransport(first, s.address, s.exchange), {
    agentSession: 'fixture-agent-session',
  });
  // hostedRootLanePath(Lane root) is true, so the start opens a sibling even when the root is a Lane.
  const response = await inside.dispatch('start', { outcome: 'Second Lane' });
  const sibling = join(realpathSync(clone), `second-lane-${s.lane.laneId.slice(0, 8)}`);
  assert.equal(response.result.path, sibling);
  assert(!existsSync(join(first + '.forge-client', 'lanes', s.lane.laneId)), 'not nested');
  assert(existsSync(join(sibling, '.forge', 'hosted-lane.json')));
});

for (const holders of [false, true])
  test(`1d784a4a: open with takeover from another folder ${holders ? 'takes the Lane once, then checks out' : 'opens it as usual when the server has no Lane holders'}`, async t => {
    stateHome(t);
    const s = agentFixture(t);
    signedDownloads(t, s);
    const clone = join(s.root, '..', 'clone.forge-client', 'lanes'),
      first = join(clone, s.lane.laneId);
    await s.transport().dispatch('start', { outcome: 'First Lane', path: first });
    // An earlier builder's Lane, opened from this Lane's folder (the project folder takes the same path).
    s.lane.laneId = randomUUID();
    let takes = 0;
    if (holders) {
      s.caps.features = [...(s.caps.features ?? []), 'lane-holder-v1'];
      const original = s.exchange.client.mutation.bind(s.exchange.client);
      s.exchange.client.mutation = async (ref, args) => {
        if (getFunctionName(ref) !== 'projectHostedHolders:take') return original(ref, args);
        takes++;
        const request = JSON.parse(args.request);
        assert.equal(request.takeover, true);
        assert.equal(request.reason, 'The previous builder finished');
        return JSON.stringify({ status: 'completed', result: { lane: s.lane }, observedLane: s.lane });
      };
    }
    const inside = Object.assign(new HostedAgentTransport(first, s.address, s.exchange), {
      agentSession: 'fixture-agent-session',
    });
    const response = await inside.dispatch('open', {
      laneId: s.lane.laneId,
      takeover: true,
      reason: 'The previous builder finished',
    });
    const sibling = join(realpathSync(clone), s.lane.laneId);
    assert.equal(response.result.root, sibling);
    assert(existsSync(join(sibling, '.forge', 'hosted-lane.json')));
    assert.equal(takes, holders ? 1 : 0);
  });
