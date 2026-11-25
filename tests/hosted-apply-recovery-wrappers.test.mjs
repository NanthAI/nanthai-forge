// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { assertAgentResponseShape } from './agent-response-shape.mjs';
import { describeFailure } from '../dist/system-errors.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { digest } from '../dist/hash.js';
import { listKeptApply } from '../dist/hosted-apply-kept.js';

// Production wrapper path: the CLI (hostedAgentCli) and MCP (forge_task) both reach these actions
// through HostedAgentTransport, and both print describeFailure(error) for a refusal. Each B2 case
// runs through both real wrappers.
const jobs = f => [...f.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'job').length;

async function opened(t, wrapper) {
  const { hostedAgentCli } = await import('../dist/hosted-agent-cli.js');
  const { registerHostedAgentWorkflow } = await import('../dist/mcp-hosted-agent.js');
  const s = await resolutionFixture(t, { overlap: false }),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const transport = s.transport(),
    tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, _config, call) {
          tools.set(name, call);
        },
      },
      transport,
    ),
  );
  const invoke = async (action, command) => {
    if (wrapper === 'cli') {
      try {
        return await hostedAgentCli(s.root, action, command, s.address, transport);
      } catch (error) {
        return { error: describeFailure(error) };
      }
    }
    const reply = await tools.get('forge_task')({ command: { action, ...command } }, {});
    return JSON.parse(reply.content[0].text);
  };
  return { s, f, root: fs.realpathSync(s.root), invoke };
}

/** Execute exactly the advertised continuation, then replay the original source action. */
async function finish(s, f, invoke, retained, command) {
  const { action, ...next } = retained.next;
  assert.equal(action, 'recover-apply');
  const before = jobs(f);
  const recovered = await invoke(action, next);
  assert(!recovered.error, JSON.stringify(recovered.error));
  assert.equal(recovered.result.status, 'applied');
  assert.equal(recovered.result.applyOperationId, retained.applyOperationId);
  const replay = await invoke('sync', command);
  assert(!replay.error, JSON.stringify(replay.error));
  assert.equal(replay.operationId, command.operationId, 'the original source identity is kept');
  assert.equal(jobs(f), before, 'no new source job');
  const remote = await f.readLane(f.lane.laneId);
  assert.equal(readHostedLaneCheckout(s.root).selection.head, remote.head, 'exact target applied');
  return recovered;
}

for (const wrapper of ['cli', 'mcp'])
  test(`B2 missing marker (${wrapper}): a marker removed between source submission and the first local apply keeps its baseline, and the advertised action progresses`, async t => {
    const { s, f, root, invoke } = await opened(t, wrapper);
    f.moveMain({ overlap: false });
    const original = s.exchange.client.mutation,
      marker = join(root, '.forge', 'hosted-lane.json');
    let removed = false;
    s.exchange.client.mutation = async (ref, args) => {
      const result = await original(ref, args);
      if (getFunctionName(ref) === 'projectHostedSyncJobs:submit' && !removed) {
        removed = true;
        fs.rmSync(marker);
      }
      return result;
    };
    const command = { laneId: f.lane.laneId, operationId: randomUUID(), apply: true };
    let first;
    try {
      first = await invoke('sync', command);
    } finally {
      s.exchange.client.mutation = original;
    }
    assert(removed, 'the marker was removed after source submission');
    assert(first.error, 'the apply stops');
    assertAgentResponseShape(first, s.root, { sourceCompleted: true });
    await finish(s, f, invoke, first.error.recovery, command);
  });

// Dogfood 2026-11-07 (118a5539 comment): `save --sync` with one unsaved edit stopped with source
// done and the local apply pending. Incident 48835eea: a sync that saved only after a merge left
// edits unsaved on an up-to-date sync and sent clashing ones to kept-apply. `save --sync` now saves
// first (Git's commit-before-pull), so the merge carries the edit and the folder equals the result.
test('48835eea: save --sync saves an unsaved edit before it syncs, so the merge carries it and nothing stays unsaved', async t => {
  const { s, f, root } = await opened(t, 'cli');
  f.moveMain({ overlap: false }); // main adds accepted.txt only
  fs.writeFileSync(join(root, 'a.txt'), 'unsaved local edit\n');
  const command = { laneId: f.lane.laneId, operationId: randomUUID(), apply: true };
  const synced = await s.transport().dispatch('sync', command);
  const remote = await f.readLane(f.lane.laneId);
  assert.equal(synced.result.saved.status, 'completed');
  assert.equal(synced.result.applied.head, remote.head, 'the merge is the last head: no save on top');
  assert.equal(readHostedLaneCheckout(root).selection.head, remote.head);
  assert.equal(fs.readFileSync(join(root, 'a.txt'), 'utf8'), 'unsaved local edit\n', 'edit kept in place');
  assert(fs.existsSync(join(root, 'accepted.txt')), 'main change installed');
  assert.equal(synced.result.applied.displacedRecovery, undefined);
  const saved = readHostedLaneCheckout(root).state.files.find(file => file.path === 'a.txt');
  assert.equal(saved.blob, digest(Buffer.from('unsaved local edit\n')));
});

test('48835eea: an unsaved edit on a file main changed is saved first, so the clash is a conflict to resolve and nothing goes to kept-apply', async t => {
  const { s, f, root } = await opened(t, 'cli');
  f.moveMain({ overlap: true }); // main changes a.txt
  fs.writeFileSync(join(root, 'a.txt'), 'unsaved local edit\n');
  const before = (await f.readLane(f.lane.laneId)).head;
  const synced = await s.transport().dispatch('sync', {
    laneId: f.lane.laneId,
    operationId: randomUUID(),
    apply: true,
  });
  assert.equal(synced.result.saved.status, 'completed');
  assert(synced.result.conflict, 'the clash is reported as a conflict');
  assert.notEqual((await f.readLane(f.lane.laneId)).head, before, 'the edit is in the saved Lane head');
  assert.deepEqual(listKeptApply(root).entries, [], 'nothing was moved to kept-apply');
});
