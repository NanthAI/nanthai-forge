// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { readLaneEntry } from '../dist/lane-registry.js';

function stateHome(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-state-')),
    saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
}

/** Checkout bytes arrive through signed URLs; `gate.hold` stalls them, `gate.fail` breaks them. */
function gatedDownloads(t, s) {
  const mutation = s.exchange.client.mutation,
    original = globalThis.fetch,
    gate = { hold: null, fail: false };
  s.exchange.client.mutation = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectObjectDownloads:describe') return mutation(ref, args);
    return args.digests.map(digest => ({
      digest,
      size: s.objects.get(digest).length,
      location: 'convex',
      url: `https://fixture.invalid/object/${digest}`,
    }));
  };
  globalThis.fetch = async url => {
    if (gate.hold) await gate.hold;
    if (gate.fail) throw new Error('checkout download broke');
    return new Response(s.objects.get(String(url).split('/').at(-1)));
  };
  t.after(() => (globalThis.fetch = original));
  return gate;
}

const starts = s => s.calls.filter(call => call.name === 'projectHostedStart:start').length;

test('a stalled checkout after the durable start still returns the Lane and its exact replay', async t => {
  stateHome(t);
  const s = agentFixture(t),
    gate = gatedDownloads(t, s),
    path = join(s.root, '..', 'lanes', 'held');
  let release;
  gate.hold = new Promise(resolve => (release = resolve));
  const transport = s.transport();
  transport.startBoundMs = 150;
  const command = { outcome: 'Held checkout', path };
  const response = await transport.dispatch('start', command);
  assert.equal(response.result.lane.laneId, s.lane.laneId);
  assert.equal(response.result.checkout.status, 'incomplete');
  assert.equal(response.result.checkout.reason, 'timeout');
  assert.equal(response.result.path, path);
  assert.equal(response.result.continuation.reason, 'stalled');
  assert(transport.abandonedStart);
  const replay = response.result.continuation.command;
  assert(replay.startsWith('nforge agent '));
  assert(replay.includes(response.operationId) && replay.includes('Held checkout'));
  assert.equal(starts(s), 1);
  // Release the hold, then replay the same operation: the same Lane materializes once.
  release();
  gate.hold = null;
  const replayed = await s.transport().dispatch('start', { ...command, operationId: response.operationId });
  assert.equal(replayed.result.lane.laneId, s.lane.laneId);
  assert.equal(replayed.result.checkout.status, undefined);
  assert(existsSync(join(path, '.forge', 'hosted-lane.json')));
  assert.equal(replayed.result.continuation, undefined);
  assert.equal(replayed.operationId, response.operationId);
  assert.equal(readLaneEntry(s.lane.laneId).outcome, 'Held checkout');
  assert.equal(starts(s), 2, 'the replay reconciles the retained start');
});

test('a failed checkout after the durable start returns the Lane, the code and the replay', async t => {
  stateHome(t);
  const s = agentFixture(t),
    gate = gatedDownloads(t, s),
    path = join(s.root, '..', 'lanes', 'broken');
  gate.fail = true;
  const response = await s.transport().dispatch('start', { outcome: 'Broken checkout', path });
  assert.equal(response.result.lane.laneId, s.lane.laneId);
  assert.equal(response.result.checkout.status, 'incomplete');
  assert.equal(response.result.checkout.reason, 'failed');
  assert.equal(typeof response.result.checkout.code, 'string');
  assert.equal(response.result.continuation.reason, 'failed');
  assert(response.result.continuation.command.includes(response.operationId));
  gate.fail = false;
  const replayed = await s
    .transport()
    .dispatch('start', { outcome: 'Broken checkout', path, operationId: response.operationId });
  assert(existsSync(join(path, '.forge', 'hosted-lane.json')));
  assert.equal(replayed.result.lane.laneId, s.lane.laneId);
});

test('a healthy start carries no continuation and adds no Lane-start call', async t => {
  stateHome(t);
  const s = agentFixture(t);
  gatedDownloads(t, s);
  const response = await s.transport().dispatch('start', {
    outcome: 'Healthy',
    path: join(s.root, '..', 'lanes', 'healthy'),
  });
  assert.equal(response.result.continuation, undefined);
  assert.equal(response.result.checkout.status, undefined);
  assert.equal(starts(s), 1);
});

test('a start with no placement names the replay that opens the same Lane', async t => {
  stateHome(t);
  const s = agentFixture(t),
    response = await s.transport().dispatch('start', { outcome: 'Unplaced' });
  assert.equal(response.result.path, undefined);
  assert.equal(response.result.continuation.reason, 'no-placement');
  assert(response.result.continuation.command.includes(response.operationId));
  assert(
    response.result.continuation.command.includes(response.result.continuation.path.replaceAll("'", '')),
  );
  assert(!existsSync(response.result.continuation.path));
});
