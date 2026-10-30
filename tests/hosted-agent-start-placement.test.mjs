// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { hostedAgentActions } from '../dist/hosted-agent-contract.js';
import { readLaneEntry } from '../dist/lane-registry.js';
import { submitHostedLand } from '../dist/hosted-land-cli.js';

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
      location: 'convex',
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

test('version skew names the upgrade step instead of a bare unsupported action', async t => {
  const s = agentFixture(t);
  await assert.rejects(s.transport().dispatch('teleport', { secret: 'private-value' }), error => {
    assert.equal(error.code, 'HOSTED_ACTION_UNSUPPORTED');
    assert.match(error.message, /Upgrade nforge/);
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
    assert.match(error.message, /may predate nforge .*deploy the matching Forge server/);
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
