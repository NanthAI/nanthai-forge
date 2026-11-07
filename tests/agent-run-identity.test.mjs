// SPDX-License-Identifier: Apache-2.0
// Issue d730121f: agent runs on one account tell each other apart in idle hints, presence and
// overlap notices, and on receipts. A run is the agent session slug (c29d0780); no new auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLaneEntry, recordLane } from '../dist/lane-registry.js';
import { housekeepingLines, laneHousekeeping } from '../dist/lane-prune.js';
import { agentSlug } from '../dist/agent-slug-session.js';
import { landingAgentRun } from '../dist/agent-slug.js';
import { presenceNotice, rankPresence } from '../dist/hosted-presence.js';
import { hostedOverlapAdvice } from '../dist/hosted-overlap.js';
import { hostedOverlapNotice, overlapBanner } from '../dist/hosted-overlap-notice.js';
import { slimReceipt } from '../dist/receipt-slim.js';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
import { hostedLaneSchema } from '../dist/hosted-lane.js';
import { moduleUrl } from './convex-module.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const landing = await import(moduleUrl('../convex/projectHostedLanding.ts'));

const hour = 3_600_000;
const address = { url: 'https://fixture.invalid', projectId: 'project' };
function stateHome(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-run-identity-')),
    saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(directory, 'state');
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function checkout(directory, laneId) {
  const root = join(directory, laneId);
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge', 'hosted-lane.json'),
    JSON.stringify({ url: address.url, selection: { laneId, projectId: address.projectId } }),
  );
  return root;
}

test('incident replay (wave 5, 76dd1957): run B never lists run A’s idle Lane as its own or offers to abandon it', async t => {
  const directory = stateHome(t);
  const now = Date.now();
  const runA = agentSlug('session-a'),
    runB = agentSlug('session-b');
  assert.notEqual(runA, runB);
  // Run A's Lane, idle 64 h like 76dd1957; an older entry from before run ids; run B's own idle Lane.
  const lanes = { a: randomUUID(), old: randomUUID(), b: randomUUID() };
  recordLane(
    {
      laneId: lanes.a,
      root: checkout(directory, lanes.a),
      ...address,
      agent: runA,
      lastActionAt: now - 64 * hour,
    },
    now,
  );
  recordLane(
    { laneId: lanes.old, root: checkout(directory, lanes.old), ...address, lastActionAt: now - 30 * hour },
    now,
  );
  recordLane(
    {
      laneId: lanes.b,
      root: checkout(directory, lanes.b),
      ...address,
      agent: runB,
      lastActionAt: now - 5 * hour,
    },
    now,
  );
  const reads = [];
  const readStates = async (_address, laneIds) => {
    reads.push(laneIds.length);
    return new Map(laneIds.map(id => [id, 'active']));
  };
  const settings = { autoPruneHours: 0, idleLaneHours: 4 };
  const asB = await laneHousekeeping({ readStates, address, apply: false, settings, now, run: runB });
  assert.deepEqual(
    asB.idle.map(lane => lane.laneId),
    [lanes.b],
    'only run B’s own Lane is yours',
  );
  assert.deepEqual(
    asB.otherRuns.map(lane => [lane.laneId, lane.run]).sort(),
    [
      [lanes.a, 'other'],
      [lanes.old, 'unknown'],
    ].sort(),
  );
  const lines = housekeepingLines('/root', asB.idle, { count: 0, bytes: 0 }, true, asB.otherRuns).join('\n');
  // The abandon command is offered once, for run B's own Lane; the peer Lanes are named, not offered.
  assert.equal(lines.match(/ abandon '/g)?.length, 1);
  assert.match(lines, new RegExp(`^  ${lanes.b} 5h`, 'm'));
  assert.doesNotMatch(lines, new RegExp(`^  ${lanes.a}`, 'm'));
  assert.match(lines, /Idle Lanes of other agent runs on this account \(not yours; leave them\): 2:/);
  assert.match(lines, new RegExp(`${lanes.old.slice(0, 8)} 30h \\(unknown run\\)`));
  // Run A sees its own Lane as its own; a person (operator) never claims an agent run's Lane.
  const asA = await laneHousekeeping({ readStates, address, apply: false, settings, now, run: runA });
  assert.deepEqual(
    asA.idle.map(lane => lane.laneId),
    [lanes.a],
  );
  const person = await laneHousekeeping({ readStates, address, apply: false, settings, now, run: null });
  assert.deepEqual(person.idle, []);
  // An explicit `nforge prune` (the operator asks; no run given) still lists every idle Lane.
  const prune = await laneHousekeeping({ readStates, address, apply: false, settings, now });
  assert.equal(prune.idle.length, 3);
  assert.deepEqual(prune.otherRuns, []);
  // Budget: one batched state read per housekeeping pass, as before.
  assert.deepEqual(reads, [3, 3, 3, 3]);
  // The brief receipt keeps the counts.
  const slim = slimReceipt({
    transport: 'hosted',
    action: 'start',
    localLanes: { idle: asB.idle, otherRuns: asB.otherRuns, pruned: { count: 0, bytes: 0 } },
    result: {},
  });
  assert.deepEqual(slim.localLanes, { idle: 1, otherRuns: 2 });
});

test('start records the starting run on the local Lane entry; a person records null', async t => {
  stateHome(t);
  const s = agentFixture(t);
  // Housekeeping forgets entries whose root is gone; the fixture's client folder must exist.
  mkdirSync(s.root, { recursive: true });
  await s.transport('session-alpha').dispatch('start', { outcome: 'Run identity', open: false });
  assert.equal(readLaneEntry(s.lane.laneId).agent, agentSlug('session-alpha'));
  s.lane.laneId = randomUUID();
  await s.transport(null).dispatch('start', { outcome: 'Person', open: false });
  assert.equal(readLaneEntry(s.lane.laneId).agent, null);
});

const presenceRow = (laneId, intentId, agent, paths = []) => ({
  laneId,
  intentId,
  actor: 'acct',
  ...(agent ? { agent } : {}),
  goal: 'Agent run identity',
  paths,
  pathCount: paths.length,
  at: Date.now(),
});

test('presence: a run’s own earlier Lanes and its resolution origin are never "another agent"', () => {
  const intentId = randomUUID();
  const origin = randomUUID(),
    sibling = randomUUID(),
    peer = randomUUID(),
    me = randomUUID();
  const rows = [
    presenceRow(origin, intentId, 'azure-ibis', ['src/a.ts']),
    presenceRow(sibling, intentId, 'azure-ibis'),
    presenceRow(peer, intentId, 'brave-falcon'),
  ];
  const base = { laneId: me, intentId, goal: 'Agent run identity', paths: ['src/a.ts'], actor: 'acct' };
  const ranked = rankPresence({ ...base, agent: 'azure-ibis', origin }, rows, Date.now());
  assert.deepEqual(
    ranked.lanes.map(lane => lane.laneId),
    [peer],
  );
  assert.match(
    presenceNotice({ ...ranked.lanes[0], actor: 'owner-h/brave-falcon' }, Date.now()),
    /^Another agent on your account \(owner-h\/brave-falcon\)/,
  );
  // A restarted session (other slug) still never hears about the Lane it resolves.
  const restarted = rankPresence({ ...base, agent: 'quiet-otter', origin }, rows, Date.now());
  assert(!restarted.lanes.some(lane => lane.laneId === origin));
  assert(
    restarted.lanes.some(lane => lane.laneId === sibling),
    'another run’s Lane still shows',
  );
  // Without a run id (old Lanes, a person) nothing is hidden beyond the resolution origin.
  assert.equal(rankPresence(base, rows, Date.now()).lanes.length, 3);
});

async function startProject() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  s.insert('forgeAccounts', { owner: 'owner', handle: 'owner-h' });
  const head = 'a'.repeat(64);
  await s.call('seed', channels.seed, {
    projectId,
    actor: 'owner',
    operationId: randomUUID(),
    selection: JSON.stringify({
      schema: 2,
      projectId,
      snapshotId: randomUUID(),
      sourceRevision: 0,
      channel: 'main',
      head,
      authority: { mode: 'server', epoch: 1 },
      receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
    }),
  });
  const begin = async (intent, agent) =>
    JSON.parse(
      await s.call('start', start.start, {
        projectId,
        operationId: randomUUID(),
        authorityEpoch: 1,
        expectedMain: { head, receiptId: 'main-0' },
        intent,
        ...(agent ? { agent } : {}),
      }),
    );
  return { s, projectId, begin };
}

test('incident replay (wave 5, b2cfa7a4 over cf63ce32): a resolution Lane over its own earlier Lane gets no "another agent" notice', async () => {
  const { s, projectId, begin } = await startProject();
  const original = await begin({ kind: 'new', outcome: 'Agent identities' }, 'azure-ibis');
  const peer = await begin({ kind: 'existing', intentId: original.intentId }, 'brave-falcon');
  // The sync conflict opens a resolution sibling server-side: a new Lane record with no agent metadata.
  const resolutionId = randomUUID();
  await s.call(
    'resolve',
    {
      _handler: async ctx => {
        const row = await records.readHostedRecord(ctx, {
          projectId,
          actor: 'owner',
          kind: 'lane',
          key: original.lane.laneId,
        });
        const lane = hostedLaneSchema.parse(JSON.parse(row.value));
        const pin = { sha256: lane.head, size: 0 };
        await records.writeHostedRecord(ctx, {
          projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: null,
          record: {
            ...lane,
            id: resolutionId,
            version: 0,
            sourceVersion: 0,
            lifecycleVersion: 0,
            resolution: {
              candidateId: null,
              conflicts: pin,
              left: lane.head,
              right: lane.head,
              draftHead: lane.head,
              origin: { laneId: lane.id, head: lane.head, sourceVersion: lane.sourceVersion },
              status: 'pending',
            },
          },
        });
        return 'ok';
      },
    },
    {},
  );
  const row = id => [...s.tables.projectHostedOverlapLanes.values()].find(r => r.laneId === id);
  assert.equal(row(resolutionId).agent, 'azure-ibis', 'the resolution Lane is the same run as its origin');
  const presence = JSON.parse(
    await s.call('read', overlaps.read, { projectId, laneId: resolutionId, presence: {} }),
  ).presence;
  const shown = presence.lanes.map(lane => lane.laneId);
  assert(!shown.includes(original.lane.laneId), 'its own origin Lane is not another agent');
  assert(shown.includes(peer.lane.laneId), 'the other run on the Issue still shows');
  for (const lane of presence.lanes) assert.match(presenceNotice(lane, Date.now()), /owner-h\/brave-falcon/);
});

test('overlap notice for a peer Lane names the peer run and its paths, never "(unavailable)"', () => {
  const lane = (agent, paths) => ({
    laneId: randomUUID(),
    intentId: randomUUID(),
    intent: `Work of ${agent}`,
    actor: 'owner-h',
    agent,
    head: 'h',
    baseHead: 'b',
    baseSequence: 0,
    open: true,
    // No range evidence: the server can only say both Lanes changed the file.
    changes: JSON.stringify(
      paths.map(path => ({
        path,
        before: { blob: 'base', mode: '100644' },
        after: { blob: `${path}:${agent}`, mode: '100644' },
      })),
    ),
    complete: true,
  });
  const mine = lane('azure-ibis', ['src/a.ts', 'src/b.ts']);
  const peer = lane('brave-falcon', ['src/a.ts', 'src/b.ts']);
  const advice = hostedOverlapAdvice(mine, [peer], null, { head: 'b', sourceRevision: 0 }, new Set());
  const notice = hostedOverlapNotice('/root', mine.laneId, advice);
  assert(notice.items.length >= 1);
  assert(
    notice.items.every(item => item.reason === 'unavailable'),
    'fixture has no range evidence',
  );
  const banner = overlapBanner(notice);
  assert.doesNotMatch(banner, /\(unavailable\)/);
  assert.match(banner, /src\/a\.ts \(same file; line ranges unknown\)/);
  assert.match(banner, new RegExp(`Lane ${peer.laneId} by owner-h/brave-falcon`));
  if (!notice.required) {
    const slim = slimReceipt({ transport: 'hosted', action: 'save', overlapNotice: notice, result: {} });
    assert.deepEqual(slim.overlapNotice.with, [
      `${peer.laneId.slice(0, 8)} owner-h/brave-falcon: ${notice.items.map(item => item.file).join(', ')}`,
    ]);
  }
});

test('receipts carry the agent run that landed them; old receipts without it still read', async () => {
  assert.deepEqual(landingAgentRun('quiet-otter'), { agentRun: 'quiet-otter' });
  assert.deepEqual(landingAgentRun('dino-macbook'), {}, 'a value outside the word lists is dropped');
  const land = async agent => {
    // One fixture per landing: each lands on the fixture's own main.
    const f = await acceptanceFixture();
    const item = await f.makeCandidate();
    const request = f.request({
      candidateId: item.candidate.id,
      expectedHead: item.candidate.result.head,
      agent: false,
    });
    const submitted = JSON.parse(
      await f.call('landingEnqueue', landing.enqueue, {
        projectId: f.projectId,
        request: JSON.stringify(request),
        ...(agent ? { agent } : {}),
      }),
    );
    await f.drain();
    await f.stageAcceptance(submitted, item.pages);
    const result = await f.accept((await f.status(submitted.id)).request);
    assert.equal(result.status, 'landed');
    const stored = [...f.tables.projectHostedAcceptances.values()].find(
      row => row.receiptId === result.receipt.id,
    );
    assert.deepEqual(JSON.parse(stored.value), result.receipt, 'the stored receipt is the one returned');
    return result.receipt;
  };
  const withRun = await land('quiet-otter');
  assert.equal(hostedAcceptanceSchema.parse(withRun).agentRun, 'quiet-otter');
  // Old receipts (and person or older-CLI landings) have no run and still parse.
  const without = await land(undefined);
  assert.equal('agentRun' in without, false);
  const { agentRun: _drop, ...old } = withRun;
  assert.equal(hostedAcceptanceSchema.parse(old).agentRun, undefined);
});

test('the CLI sends the run with a landing only to a server that advertises landing-agent-run', async t => {
  stateHome(t);
  const s = agentFixture(t);
  const perFinish = [];
  const finish = async () => {
    const before = s.calls.length;
    await s.transport('session-alpha').dispatch('finish', {
      candidateId: s.candidate.id,
      composeOperationId: randomUUID(),
      accept: true,
    });
    perFinish.push(s.calls.length - before);
    return s.calls.filter(call => call.name === 'projectHostedLanding:enqueue').at(-1).args;
  };
  assert.equal('agent' in (await finish()), false, 'older server: no new argument');
  s.caps.features = ['agent-slug', 'landing-agent-run'];
  assert.equal((await finish()).agent, agentSlug('session-alpha'));
  assert.equal(perFinish[0], perFinish[1], 'the run rides the existing landing call: no added call');
  assert.equal(
    'agent' in
      (await (async () => {
        await s.transport(null).dispatch('finish', {
          candidateId: s.candidate.id,
          composeOperationId: randomUUID(),
          accept: true,
        });
        return s.calls.filter(call => call.name === 'projectHostedLanding:enqueue').at(-1).args;
      })()),
    false,
    'a person sends no run',
  );
});
