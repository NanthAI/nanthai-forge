// SPDX-License-Identifier: Apache-2.0
// Board Lane 4 (Issue 9c8490a4): automatic file claim on first write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardFixture } from './board-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { rememberBoardServerFeatures } from '../dist/board-local.js';
import { readHostedEditPeers, hostedEditContext } from '../dist/agent-edit-hosted.js';
import {
  queueBoardClaim,
  drainClaimSpool,
  acquireClaimLock,
  CLAIM_LOCK_STALE_MS,
} from '../dist/board-claim-queue.js';
import { runClaimSender } from '../dist/board-claim-sender.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { effectiveAgentDefaults, AGENT_DEFAULTS } from '../dist/agent-parallel-defaults.js';
import { editedPolicy, policyPreset } from '../dist/autonomy-policy.js';
import { runResourceWorker } from './resource-budget.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';

const claims = await import(moduleUrl('../convex/projectBoardClaims.ts'));
const delivery = await import(moduleUrl('../convex/projectBoardDelivery.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;

function fixture() {
  const f = boardFixture();
  for (const name of ['projectBoardClaims', 'projectHostedPresence']) f.tables[name] ??= new Map();
  let writes = 0;
  for (const method of ['insert', 'patch', 'replace', 'delete']) {
    const run = f.ctx.db[method];
    f.ctx.db[method] = async (...args) => {
      writes++;
      return run(...args);
    };
  }
  const claim = async (args, actor = 'writer') => {
    writes = 0;
    const result = await f.invoke(
      claims.claim,
      'projectBoardClaims:claim',
      { projectId: 'project', laneId: f.lanes.A, ...args },
      actor,
    );
    return { ...result, writes };
  };
  const rows = () => [...f.tables.projectBoardClaims.values()];
  const laneRow = key =>
    [...f.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === f.lanes[key]);
  const save = (key, paths) => (laneRow(key).changes = JSON.stringify(paths.map(path => ({ path }))));
  const deliver = (args = {}) =>
    delivery.boardDelivery(f.ctx, {
      projectId: 'project',
      viewer: 'writer',
      laneId: f.lanes.A,
      intentId: f.issue,
      after: Number.MAX_SAFE_INTEGER,
      path: 'src/x.ts',
      autoClaim: { open: true, saved: new Set() },
      ...args,
    });
  return { f, claim, rows, laneRow, save, deliver };
}

test('claim (server): unsaved first-write paths once; saved, held, closed and others write nothing', async () => {
  const { f, claim, rows, save } = fixture();
  const first = await claim({ paths: ['src/a.ts', 'src/b.ts'] });
  assert.equal(first.status, 'ok');
  assert.equal(first.claimed, 2);
  assert.deepEqual(
    rows().map(row => [row.path, row.laneId, row.author]),
    [
      ['src/a.ts', f.lanes.A, 'writer'],
      ['src/b.ts', f.lanes.A, 'writer'],
    ],
  );
  console.log(`claim 2 new paths: ${f.invoke.reads} index reads, ${first.writes} writes`);
  assert.equal(first.writes, 2, 'one row per new path, no counters');
  assert(f.invoke.reads <= 12, `claim reads ${f.invoke.reads}`);
  const again = await claim({ paths: ['src/a.ts'] });
  assert.equal(again.claimed, 0);
  assert.equal(again.writes, 0, 'a path already claimed writes nothing');
  // Saving a path ends its claim: the Lane's next claim removes it, and saved paths are skipped.
  save('A', ['src/a.ts']);
  const after = await claim({ paths: ['src/a.ts', 'src/c.ts'] });
  assert.equal(after.claimed, 1);
  assert.deepEqual(
    rows()
      .map(row => row.path)
      .sort(),
    ['src/b.ts', 'src/c.ts'],
  );
  assert.equal(after.writes, 2, '1 delete (saved) + 1 insert');
  // Only the caller's own open Lane.
  assert.equal((await claim({ laneId: f.lanes.B, paths: ['src/d.ts'] })).status, 'closed');
  assert.equal((await claim({ laneId: f.lanes.C, paths: ['src/d.ts'] }, 'owner')).status, 'closed');
  // Write members only.
  await assert.rejects(claim({ paths: ['src/d.ts'] }, 'reader'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(claim({ paths: ['src/d.ts'] }, 'outsider'), code('PROJECT_UNAVAILABLE'));
  // Bounded, repository-relative input.
  await assert.rejects(claim({ paths: [] }), code('BAD_ARGUMENT'));
  await assert.rejects(claim({ paths: Array.from({ length: 11 }, (_, i) => `f${i}`) }), code('BAD_ARGUMENT'));
  await assert.rejects(claim({ paths: ['../x'] }), code('BAD_ARGUMENT'));
  await assert.rejects(claim({ paths: ['/srv/x'] }), code('BAD_ARGUMENT'));
  assert.equal(rows().length, 2);
});

test('claim (server): project policy off, board off and suspended accounts write nothing', async () => {
  const { f, claim, rows } = fixture();
  f.tables.hostedProjects.get('project').autonomyPolicy = { agentDefaults: { autoClaim: false } };
  assert.deepEqual(await claim({ paths: ['src/a.ts'] }), { status: 'off', claimed: 0, writes: 0 });
  delete f.tables.hostedProjects.get('project').autonomyPolicy;
  f.tables.boardSwitches.set('s1', { _id: 's1', key: 'project:project', off: true, at: 0 });
  assert.equal((await claim({ paths: ['src/a.ts'] })).status, 'off');
  f.tables.boardSwitches.set('s1', { _id: 's1', key: 'account:writer', off: true, at: 0 });
  assert.equal((await claim({ paths: ['src/a.ts'] })).status, 'off');
  assert.equal(rows().length, 0);
});

test('claim (server): per-Lane live cap, no note counters, lazy expiry', async () => {
  const { f, claim, rows } = fixture();
  let capped = 0;
  for (let batch = 0; batch < 4; batch++) {
    const result = await claim({
      paths: Array.from({ length: 10 }, (_, i) => `src/f${batch * 10 + i}.ts`),
    });
    capped += result.capped ?? 0;
    assert(result.writes <= 10);
  }
  assert.equal(rows().length, claims.BOARD_CLAIM_LANE_CAP);
  assert.equal(capped, 40 - claims.BOARD_CLAIM_LANE_CAP);
  console.log(`claim at cap: ${f.invoke.reads} index reads`);
  assert(f.invoke.reads <= claims.BOARD_CLAIM_LANE_CAP + 15, `reads at cap ${f.invoke.reads}`);
  // Claims are not notes: no note, inbox, rate-window or account rows.
  for (const table of [
    'projectBoardMessages',
    'projectBoardInboxes',
    'projectBoardSenders',
    'projectBoardProjects',
    'boardAccounts',
    'boardEvidence',
  ])
    assert.equal(f.tables[table].size, 0, table);
  // Expired rows of other Lanes go 10 at a time on the next claim; no cron.
  for (let i = 0; i < 12; i++)
    f.tables.projectBoardClaims.set(`old-${i}`, {
      _id: `old-${i}`,
      _creationTime: i,
      projectId: 'project',
      laneId: f.lanes.B,
      path: `old/${i}`,
      author: 'owner',
      at: 1,
      expiresAt: 2 + i,
    });
  await claim({ paths: ['src/f0.ts'] });
  assert.equal(rows().filter(row => row.laneId === f.lanes.B).length, 2);
});

test('first-write read (server): other Lanes claims as touching, hidden once saved or closed; claim decision', async () => {
  const { f, claim, laneRow, save, deliver } = fixture();
  await claim({ laneId: f.lanes.B, paths: ['src/x.ts'] }, 'owner');
  const seen = await deliver();
  assert.deepEqual(
    seen.touching.map(row => [row.author, row.fromLaneId]),
    [['owner', f.lanes.B]],
  );
  assert.equal(seen.claim, 'send', 'my Lane has not claimed or saved src/x.ts');
  assert.equal(seen.messages.length, 0);
  console.log(`first-write read with claims: ${f.invoke.reads} index reads`);
  // Decision: saved or already claimed by me -> no call at all.
  assert.equal((await deliver({ autoClaim: { open: true, saved: new Set(['src/x.ts']) } })).claim, undefined);
  await claim({ paths: ['src/x.ts'] });
  assert.equal((await deliver()).claim, undefined, 'already held: no claim call');
  // My own claim is never shown to me; owner's view shows mine.
  const ownerView = await deliver({ viewer: 'owner', laneId: f.lanes.B });
  assert.deepEqual(
    ownerView.touching.map(row => row.fromLaneId),
    [f.lanes.A],
  );
  // The claimant saved the path: the saved-path overlap covers it, the claim is hidden.
  save('B', ['src/x.ts']);
  assert.equal((await deliver())?.touching, undefined);
  save('B', []);
  // In-memory peers (the overlap read's window) answer without a read.
  const hidden = await deliver({
    autoClaim: { open: true, saved: new Set(), peers: () => ({ open: true, saved: new Set(['src/x.ts']) }) },
  });
  assert.equal(hidden?.touching, undefined);
  // The claimant closed: hidden.
  laneRow('B').open = false;
  assert.equal((await deliver())?.touching, undefined);
  laneRow('B').open = true;
  // Readers and strangers get nothing; policy off hides claims and stops new ones.
  assert.equal(await deliver({ viewer: 'reader' }), undefined);
  assert.equal(await deliver({ viewer: 'outsider' }), undefined);
  f.tables.hostedProjects.get('project').autonomyPolicy = { agentDefaults: { autoClaim: false } };
  assert.equal(await deliver(), undefined);
  delete f.tables.hostedProjects.get('project').autonomyPolicy;
  // Without the claim arg (older CLI) the field is what it was: no touching, no decision.
  const old = await deliver({ autoClaim: undefined, after: 0 });
  assert.equal(old, undefined);
});

test('policy: agentDefaults.autoClaim defaults on and set-policy turns it off', () => {
  assert.equal(AGENT_DEFAULTS.autoClaim, true);
  assert.equal(effectiveAgentDefaults(undefined).autoClaim, true);
  const policy = editedPolicy(policyPreset('trusted'), {
    action: 'set-policy',
    operationId: randomUUID(),
    agentDefaults: { autoClaim: false },
  });
  assert.equal(policy.agentDefaults.autoClaim, false);
  assert.equal(effectiveAgentDefaults(policy.agentDefaults).autoClaim, false);
});

function hookTarget(root) {
  return {
    root,
    laneId: randomUUID(),
    path: 'tests/x.test.mjs',
    project: 'p1',
    url: 'https://fixture.invalid',
  };
}
async function withState(run) {
  const state = mkdtempSync(join(tmpdir(), 'board-claims-state-'));
  const root = mkdtempSync(join(tmpdir(), 'board-claims-root-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}
const evidence = {
  count: 0,
  coverage: 'hosted',
  scope: 'saved-paths',
  unsavedEdits: 'unavailable',
  items: [],
};

test('first-write hook: one query asks to claim; claim queued off the hook path; touching lines', async () => {
  await withState(async root => {
    const target = hookTarget(root);
    const peerLane = randomUUID();
    const calls = [],
      queued = [];
    const query = async (name, args) => {
      calls.push([name, args]);
      return JSON.stringify({
        peerEvidence: evidence,
        ...(args.board?.claim
          ? {
              board: {
                messages: [],
                more: 0,
                cursor: 0,
                touching: [{ author: 'peer-h', fromLaneId: peerLane, at: Date.now() - 6 * 60_000 }],
                claim: 'send',
              },
            }
          : {}),
      });
    };
    // Server without board-claims: today's board arg, nothing queued.
    rememberBoardServerFeatures('p1', ['agent-board', 'board-wait']);
    await readHostedEditPeers(target, query, value => queued.push(value));
    assert.deepEqual(calls[0][1].board, { after: 0 });
    assert.equal(queued.length, 0);
    rememberBoardServerFeatures('p1', ['agent-board', 'board-wait', 'board-claims']);
    const result = await readHostedEditPeers(target, query, value => queued.push(value));
    assert.equal(calls.length, 2, 'still one query per first write');
    assert.deepEqual(calls[1][1].board, { after: 0, claim: true });
    assert.deepEqual(queued, [
      { root, laneId: target.laneId, project: 'p1', url: target.url, path: 'tests/x.test.mjs' },
    ]);
    const context = hostedEditContext(result);
    assert.match(
      context,
      new RegExp(
        `\\nClaim on tests/x\\.test\\.mjs: @peer-h \\(Lane ${peerLane.slice(0, 8)}\\) is editing it, unsaved, first write 6m ago\\.`,
      ),
    );
    assert(!context.includes(peerLane), 'Lane prefix only');
    assert(context.length <= 1800);
  });
});

test('claim queue + sender: one sender per Lane, first writes in one window share one mutation', async () => {
  await withState(async root => {
    const lane = { root, laneId: randomUUID(), project: 'p1', url: 'https://fixture.invalid' };
    const started = [];
    assert.equal(
      queueBoardClaim({ ...lane, path: 'a.ts' }, value => started.push(value)),
      'started',
    );
    assert.equal(
      queueBoardClaim({ ...lane, path: 'b.ts' }, value => started.push(value)),
      'queued',
    );
    assert.equal(
      queueBoardClaim({ ...lane, path: 'a.ts' }, value => started.push(value)),
      'queued',
    );
    assert.deepEqual(started, [lane], 'the hook starts at most one sender');
    const sent = [];
    const calls = await runClaimSender(lane, {
      windowMs: 5,
      mutate: async args => sent.push(args),
    });
    assert.equal(calls, 1);
    assert.deepEqual(sent, [{ projectId: 'p1', laneId: lane.laneId, paths: ['a.ts', 'b.ts'] }]);
    const lock = join(clientCacheRoot(root), 'board', `${lane.laneId}.claims.lock`);
    assert.equal(existsSync(lock), false, 'the sender releases its lock');
    assert.deepEqual(drainClaimSpool(root, lane.laneId), []);
    // A stale lock (dead sender) is replaced by the next first write.
    mkdirSync(join(clientCacheRoot(root), 'board'), { recursive: true });
    writeFileSync(lock, '{}');
    const old = new Date(Date.now() - CLAIM_LOCK_STALE_MS - 1000);
    utimesSync(lock, old, old);
    assert.equal(
      queueBoardClaim({ ...lane, path: 'c.ts' }, value => started.push(value)),
      'started',
    );
    assert.equal(acquireClaimLock(root, lane.laneId), false);
    // 25 paths: chunks of 10; a failing send drops the batch and still releases the lock.
    for (let i = 0; i < 25; i++) queueBoardClaim({ ...lane, path: `p${i}.ts` }, () => {});
    const chunks = [];
    await runClaimSender(lane, { windowMs: 5, mutate: async args => chunks.push(args.paths.length) });
    assert.deepEqual(chunks, [10, 10, 6]);
    queueBoardClaim({ ...lane, path: 'z.ts' }, () => {});
    await runClaimSender(lane, {
      windowMs: 5,
      mutate: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(existsSync(lock), false);
  });
});

test('real hook with claims on: one query, CPU p95 under 200 ms, claims batched by the detached sender', t => {
  const measured = runResourceWorker('./board-claims-budget-worker.mjs');
  t.diagnostic(JSON.stringify(measured));
  console.log(`hook with claims: ${JSON.stringify(measured)}`);
});

test('overlap read (real query): touching is handle-mapped, claim decision rides on the one read', async () => {
  const s = await saveFixture('original', 'a.txt');
  const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
  const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
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
    'base',
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
    await s.transaction('claim', claims.claim, {
      projectId: s.projectId,
      laneId: peer.id,
      paths: ['src/new.ts'],
    }),
  );
  assert.equal(claimed.claimed, 1);
  const read = board =>
    s.transaction('read', overlaps.read, {
      projectId: s.projectId,
      laneId: lane.id,
      path: 'src/new.ts',
      detail: true,
      items: 5,
      ...(board ? { board } : {}),
    });
  const raw = await read({ after: 0, claim: true });
  const value = JSON.parse(raw);
  assert.deepEqual(
    value.board.touching.map(row => [row.author, row.fromLaneId]),
    [['owner-h', peer.id]],
  );
  assert.equal(value.board.claim, 'send');
  assert(!raw.includes('"author":"owner"'), 'no account id');
  // A CLI without board-claims (board {after}) or without the board gets today's reply.
  assert.equal('board' in JSON.parse(await read({ after: 0 })), false);
  assert.equal('board' in JSON.parse(await read()), false);
});
