// SPDX-License-Identifier: Apache-2.0
// Item 0487bccb (friction 133b5a79): once a claiming Lane saves, its automatic claim hides, so a first
// write to that saved-but-unlanded file showed nothing in the hook. The same one read already returns
// the saved-path evidence; the hook now names that Lane. Incident replay: the real overlap query, then
// its recorded reply through the Claude Code, Codex and Antigravity hook shapes.
import { testDeploymentOrigin } from './trusted-origin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { hostedEditServer, hostedMarker, laneB } from './hosted-edit-fixture.mjs';
import { rememberBoardServerFeatures } from '../dist/board-local.js';
import { readHostedEditPeers, hostedEditContext, savedLine } from '../dist/agent-edit-hosted.js';
import { runEditHook } from '../dist/agent-edit-hook.js';
import { antigravityHook } from '../dist/agent-antigravity-hook.js';
import { COORDINATE_HINT } from '../dist/member-data-notice.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { hostedOverlapAdvice } from '../dist/hosted-overlap.js';

const claims = await import(moduleUrl('../convex/projectBoardClaims.ts'));
const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
const FILE = 'src/x.ts';

/** Lane A (peer) claims FILE on its first write, then saves it; Lane B (mine) has saved nothing. */
async function incident() {
  const s = await saveFixture('original', 'a.txt');
  // Synthetic dated Lanes: this replays open-peer reads, not dormancy (tests/hosted-dormant.test.mjs).
  s.patch('hostedProjects', s.projectId, {
    autonomyPolicy: { ...policyPreset('trusted'), agentDefaults: { dormantAfterDays: 0 } },
  });
  for (const name of ['projectBoardClaims', 'projectHostedPresence', 'boardSwitches', 'projectBoardInboxes'])
    s.tables[name] ??= new Map();
  const lane = JSON.parse(
    [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane').value,
  );
  const peer = { ...lane, id: randomUUID(), intentId: randomUUID() };
  await s.transaction(
    'peer',
    {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: null,
          record: peer,
          overlap: { baseSequence: 0, intent: 'Peer change' },
        }),
    },
    {},
  );
  await s.transaction(
    'mine',
    {
      _handler: ctx =>
        tracking.trackHostedOverlapLane(ctx, s.projectId, lane, { baseSequence: 0, intent: 'My change' }),
    },
    {},
  );
  s.insert('projectHostedChannels', {
    projectId: s.projectId,
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify({
      schema: 2,
      projectId: s.projectId,
      snapshotId: 'seed',
      sourceRevision: 0,
      channel: 'main',
      head: lane.head,
      authority: { mode: 'server', epoch: 1 },
      receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
    }),
  });
  s.insert('forgeAccounts', { owner: 'owner', handle: 'owner-h' });
  const claimed = JSON.parse(
    await s.transaction('claim', claims.claim, { projectId: s.projectId, laneId: peer.id, paths: [FILE] }),
  );
  assert.equal(claimed.claimed, 1);
  const peerRow = () => [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === peer.id);
  // Lane A saves FILE (not landed): a real record write with a new head, as a save makes it.
  const save = async () => {
    const head = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === peer.id);
    await s.transaction(
      'save',
      {
        _handler: ctx =>
          records.writeHostedRecord(ctx, {
            projectId: s.projectId,
            actor: 'owner',
            authorityEpoch: 1,
            expectedVersion: head.version,
            record: { ...peer, version: head.version + 1, head: 'c'.repeat(64) },
            overlap: {
              changes: [{ path: FILE, before: null, after: { blob: 'b'.repeat(64), mode: 'file' } }],
              complete: true,
            },
          }),
      },
      {},
    );
  };
  let reads = 0;
  const query = (name, args) => {
    reads++;
    assert.equal(name, 'projectHostedOverlaps:read');
    return s.transaction('read', overlaps.read, args);
  };
  return { s, lane, peer, save, peerRow, query, reads: () => reads };
}

function target(t, project, laneId) {
  const root = mkdtempSync(join(tmpdir(), 'forge-saved-peer-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, 'state');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  rememberBoardServerFeatures(project, ['agent-board', 'board-claims']);
  return { root, laneId, project, url: 'https://synthetic.invalid', path: FILE };
}

test('incident replay (real query): a peer that saved the file, not landed, is named by the hook', async t => {
  const x = await incident();
  const where = target(t, x.s.projectId, x.lane.id);
  const queued = [];
  // Before the save: the automatic claim shows (unchanged).
  const before = await readHostedEditPeers(where, x.query, path => queued.push(path));
  assert.match(before.board.claims[0], /^Claim on src\/x\.ts: @owner-h \(Lane .{8}\) is editing it, unsaved/);
  // After the save the claim hides; the saved-path evidence on the same reply names Lane A.
  await x.save();
  const after = await readHostedEditPeers(where, x.query, path => queued.push(path));
  assert.deepEqual(after.board.claims, [
    `Saved on ${FILE}: @owner-h (Lane ${x.peer.id.slice(0, 8)}) has saved changes to it, not landed yet.`,
  ]);
  const context = hostedEditContext(after);
  assert.ok(context.includes(`Lane ${x.peer.id.slice(0, 8)}`));
  assert.equal(context.split('\n').filter(line => line === COORDINATE_HINT).length, 1);
  assert.equal(x.reads(), 2, 'one bounded read per first write, nothing added');
  // Lane A closes (lands or is abandoned): nothing to warn about.
  x.peerRow().open = false;
  const closed = await readHostedEditPeers(where, x.query, () => {});
  assert.equal(closed.board?.claims.some(line => line.startsWith('Saved on')) ?? false, false);
});

test('a peer that saved and still holds a live claim is named once, as the claim', async t => {
  const x = await incident();
  const where = target(t, x.s.projectId, x.lane.id);
  await x.save();
  // Older server shape: touching still lists the Lane beside its saved-path evidence.
  const value = JSON.parse(
    await x.query('projectHostedOverlaps:read', {
      projectId: x.s.projectId,
      laneId: x.lane.id,
      path: FILE,
      board: { after: 0, claim: true },
    }),
  );
  value.board = {
    messages: [],
    more: 0,
    cursor: 0,
    touching: [{ author: 'owner-h', fromLaneId: x.peer.id, at: 1_767_225_600_000 }],
  };
  const result = await readHostedEditPeers(
    where,
    async () => JSON.stringify(value),
    () => {},
  );
  assert.equal(result.board.claims.length, 1);
  assert.match(result.board.claims[0], /is editing it, unsaved/);
});

test('savedLine stays one bounded line', () => {
  const line = savedLine('p/'.repeat(200), { actor: 'a'.repeat(300), lane: 'f'.repeat(36) });
  assert.ok(line.length <= 240);
  assert.equal(line.includes('\n'), false);
  assert.match(savedLine('a.ts', { lane: 'abcdef0123' }), /^Saved on a\.ts: a member \(Lane abcdef01\)/);
});

/** The real reply for the saved-but-unlanded file, recorded once and served to the client hooks. */
async function recordedReply() {
  const x = await incident();
  await x.save();
  const value = JSON.parse(
    await x.query('projectHostedOverlaps:read', {
      projectId: x.s.projectId,
      laneId: x.lane.id,
      path: FILE,
      board: { after: 0, claim: true },
    }),
  );
  // The hook's own Lane in the client fixture is laneB: rename mine in the recorded participants.
  for (const item of value.peerEvidence.items)
    for (const row of item.participants) if (row.lane === x.lane.id) row.lane = laneB;
  return { reply: JSON.stringify(value), peer: x.peer.id.slice(0, 8) };
}

async function clients(t) {
  const { reply, peer } = await recordedReply();
  const root = mkdtempSync(join(tmpdir(), 'forge-saved-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = await hostedEditServer({ [FILE]: reply });
  t.after(() => server.close());
  const saved = Object.fromEntries(
    ['FORGE_AUTH_TOKEN', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'].map(name => [name, process.env[name]]),
  );
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  process.env.FORGE_AUTH_TOKEN = 'synthetic-only';
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.XDG_STATE_HOME = join(root, 'state');
  testDeploymentOrigin(server.url);
  const lane = join(root, 'lane');
  hostedMarker(lane, server.url);
  rememberBoardServerFeatures('synthetic-project', ['agent-board', 'board-claims']);
  const line = new RegExp(
    `^Saved on src/x\\.ts: @owner-h \\(Lane ${peer}\\) has saved changes to it, not landed yet\\.$`,
    'm',
  );
  return { root, lane, server, line };
}

test('Claude Code Write: first write to the saved-but-unlanded file names Lane A; a second write reads nothing', async t => {
  const c = await clients(t);
  const write = {
    cwd: c.root,
    session_id: 'claude-session',
    tool_name: 'Write',
    tool_input: { file_path: join(c.lane, FILE) },
  };
  const first = Atomics.load(c.server.counts, 0);
  assert.match(runEditHook('--auto', '', write).hookSpecificOutput.additionalContext, c.line);
  assert.equal(Atomics.load(c.server.counts, 0) - first, 1, 'one read on the first write');
  assert.deepEqual(runEditHook('--auto', '', write), {});
  assert.equal(Atomics.load(c.server.counts, 0) - first, 1, 'no read on a later write');
});

test('Codex apply_patch: first write to the saved-but-unlanded file names Lane A', async t => {
  const c = await clients(t);
  const output = runEditHook('--auto', '', {
    cwd: c.lane,
    session_id: 'codex-thread',
    tool_name: 'apply_patch',
    tool_input: { patch: `*** Update File: ${FILE}` },
  });
  assert.match(output.hookSpecificOutput.additionalContext, c.line);
});

test('Antigravity PostToolUse: the saved-peer notice reaches the next model call once', async t => {
  const c = await clients(t);
  assert.deepEqual(
    await antigravityHook({
      hookEventName: 'PostToolUse',
      conversationId: 'agy-saved',
      cwd: c.lane,
      toolCall: { id: 'call-1', name: 'write_file', args: { Path: join(c.lane, FILE), Content: 'x' } },
    }),
    {},
  );
  const injected = await antigravityHook({ hookEventName: 'PreInvocation', conversationId: 'agy-saved' });
  assert.match(injected.injectSteps[0].systemMessage.systemMessage, c.line);
  assert.deepEqual(
    await antigravityHook({ hookEventName: 'PreInvocation', conversationId: 'agy-saved' }),
    {},
  );
});

test('a path read marks a superseded peer, so the hook can skip it while peers(path) still lists it', () => {
  const lane = (laneId, changes, extra = {}) => ({
    laneId,
    intentId: laneId,
    intent: 'goal',
    actor: 'owner',
    head: `${laneId[0]}`.repeat(64),
    baseHead: 'a'.repeat(64),
    baseSequence: 0,
    open: true,
    changes: JSON.stringify(changes),
    complete: true,
    ...extra,
  });
  const change = [{ path: FILE, before: null, after: { blob: 'b'.repeat(64), mode: 'file' } }];
  const mine = lane('11111111-1111-4111-8111-111111111111', []);
  const live = lane('22222222-2222-4222-8222-222222222222', change);
  const quiet = lane('33333333-3333-4333-8333-333333333333', change, {
    superseded: { laneHead: '3'.repeat(64) },
  });
  const { overlaps } = hostedOverlapAdvice(
    mine,
    [live, quiet],
    null,
    { head: 'a'.repeat(64), sourceRevision: 0 },
    true,
    5,
    FILE,
  );
  assert.deepEqual(
    overlaps.items.map(item => [item.lanes.find(id => id !== mine.laneId).slice(0, 1), item.superseded]),
    [
      ['2', undefined],
      ['3', true],
    ],
  );
});
