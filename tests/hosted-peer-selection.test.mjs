// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { recordLane } from '../dist/lane-registry.js';
import { describeFailure } from '../dist/system-errors.js';
import { setup } from './hosted-overlaps-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const { now } = await import(moduleUrl('../convex/projectNowOverlaps.ts'));

test('a0359cb6: project-root peers selects its session Lane or returns shared saved paths on the first call', async t => {
  const { s, lane, peer, exchange, transport } = await setup(t);
  const first = transport(lane);
  const second = transport(peer);
  await first.dispatch('save', { operationId: randomUUID(), message: 'first' });
  await second.dispatch('save', { operationId: randomUUID(), message: 'second' });

  const root = join(dirname(first.root), 'project');
  mkdirSync(root);
  const project = new HostedAgentTransport(root, first.address, exchange);
  project.agentSession = 'peers-root-regression';
  const runSlug = project.agentSlug();
  assert(runSlug);
  const register = (laneId, folder, agent = runSlug) =>
    recordLane({ ...first.address, laneId, root: folder, agent });
  const cli = async (input = {}) => {
    calls.length = 0;
    return (await hostedAgentCli(root, 'peers', input, first.address, project)).result;
  };
  const calls = [];
  let actor = 'owner';
  const query = exchange.client.query;
  exchange.client.query = async (ref, args) => {
    const name = getFunctionName(ref);
    calls.push(name);
    return name === 'projectNowOverlaps:now' ? s.call(name, now, args, actor) : query(ref, args);
  };

  const shared = (await cli()).peerEvidence;
  assert.equal(shared.scope, 'project-saved-paths');
  assert.deepEqual(shared.edits.map(edit => edit.laneId).sort(), [lane.id, peer.id].sort());
  assert(shared.edits.every(edit => edit.paths.join() === 'a.txt'));
  assert.deepEqual(calls, ['projectNowOverlaps:now']);
  assert.deepEqual((await cli({ path: 'other.txt' })).peerEvidence.edits, []);

  register(lane.id, first.root);
  register(peer.id, second.root, 'different-agent');
  register(randomUUID(), join(root, 'missing'));
  const inferred = await cli();
  assert.equal(inferred.laneId, lane.id);
  assert.equal(inferred.conflictNotice.items[0].with, peer.id);
  assert.deepEqual(calls, ['projectHostedOverlaps:read']);
  assert.equal((await cli({ laneId: peer.id })).laneId, peer.id);
  assert.equal((await cli({ laneId: null })).peerEvidence.scope, 'project-saved-paths');
  assert.equal((await first.dispatch('peers', {})).result.laneId, lane.id);

  await assert.rejects(cli({ laneId: randomUUID(), path: 'a.txt' }), error => {
    const failure = describeFailure(error, { root });
    assert.equal(failure.code, 'NOT_FOUND');
    assert.equal(failure.next, `nforge agent '${root}' peers '{"laneId":null,"path":"a.txt"}'`);
    assert(failure.message.includes(failure.next));
    return true;
  });

  register(peer.id, second.root);
  assert.equal((await cli()).peerEvidence.scope, 'project-saved-paths');
  assert.deepEqual(calls, ['projectNowOverlaps:now']);
  actor = 'outsider';
  await assert.rejects(cli(), error => describeFailure(error).code === 'PROJECT_UNAVAILABLE');
});
