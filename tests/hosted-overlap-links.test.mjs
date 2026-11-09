// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { digest } from '../dist/hash.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyPreset } from '../dist/autonomy-policy.js';
import { hostedOverlapAdvice } from '../dist/hosted-overlap.js';
import {
  HOT_FILE_ITEMS,
  HOT_FILE_SHOWS,
  inScope,
  peerPhaseText,
  stackOffer,
} from '../dist/hosted-overlap-coordination.js';
import {
  autoStackPeer,
  limitHotFiles,
  owningPackage,
  rememberStackOffer,
} from '../dist/hosted-coordination-client.js';
import { hostedOverlapNotice, overlapBanner } from '../dist/hosted-overlap-notice.js';
import { slimReceipt } from '../dist/receipt-slim.js';
import { mergeAgentDefaults, stackingMode } from '../dist/agent-parallel-defaults.js';

const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));

const PEER = 'user_PEERACCOUNT01';
const shared = 'src/shared.ts';
const changeFor = (path, seed, advisory = false) => [
  {
    path,
    // A base file with no range evidence reads as an advisory 'unavailable' pair; two additions block.
    before: advisory ? { blob: digest(path + 'base'), mode: 'file' } : null,
    after: { blob: digest(path + seed), mode: 'file' },
  },
];

/** The caller's Lane plus peers written through the real Lane record path. */
async function project() {
  const s = await saveFixture('original', 'a.txt');
  const base = JSON.parse(
    [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane').value,
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
      head: base.head,
      authority: { mode: 'server', epoch: 1 },
      receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
    }),
  });
  s.insert('forgeAccounts', { owner: PEER, handle: 'peer-builder' });
  s.insert('projectContributors', { projectId: s.projectId, contributor: PEER });
  const write = (record, overlap, expectedVersion = null) =>
    s.transaction(
      'write',
      {
        _handler: ctx =>
          records.writeHostedRecord(ctx, {
            projectId: s.projectId,
            actor: 'owner',
            authorityEpoch: 1,
            expectedVersion,
            record,
            overlap,
          }),
      },
      {},
    );
  /** A Lane with saved changes on the shared path; `extra` adds stack or resolution links. */
  const lane = async (intent, extra = {}, intentId = randomUUID()) => {
    const first = {
      ...base,
      id: randomUUID(),
      intentId,
      actor: PEER,
      version: 0,
      at: new Date().toISOString(),
      ...extra,
    };
    await write(first, { baseSequence: 0, intent });
    const saved = { ...first, head: digest(first.id), version: 1, sourceVersion: 1 };
    await write(saved, { baseSequence: 0, intent, changes: changeFor(shared, first.id) }, 0);
    return saved;
  };
  const read = (laneId, args = {}) =>
    s
      .transaction(
        'projectHostedOverlaps:read',
        overlaps.read,
        { projectId: s.projectId, laneId, ...args },
        'owner',
      )
      .then(JSON.parse);
  const noticed = async laneId =>
    new Set((await read(laneId)).unacknowledgedOverlaps.items.flatMap(item => item.lanes));
  const overlapRow = laneId =>
    [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === laneId);
  return { s, lane, read, noticed, overlapRow };
}
const resolutionOf = (origin, left = digest('moved')) => ({
  resolution: {
    candidateId: null,
    conflicts: { sha256: digest('conflicts'), size: 1 },
    left,
    right: digest('right'),
    draftHead: digest('draft'),
    origin: { laneId: origin.id, head: origin.head, sourceVersion: 1 },
    status: 'resolved',
  },
});
const stackOn = (parent, head = digest('pin')) => ({ stack: { laneId: parent.id, head } });

// Issue ee9d5738 (friction ee726a66, c9f5a7c0): replay of the B1.5d and wave-5 notices a builder could
// do nothing about. Each assertion fails on the head-matching and per-pair exclusions before this change.

test('a resolve Lane gets no overlap notice about its origin Lane, whatever either head is now', async () => {
  const { lane, noticed, overlapRow } = await project();
  const origin = await lane('Original work');
  const unrelated = await lane('Someone else');
  const resolve = await lane('Resolution', resolutionOf(origin));
  const sibling = await lane('Second resolution of the same origin', resolutionOf(origin, digest('other')));
  assert.equal(overlapRow(resolve.id).resolutionOrigin, origin.id);
  // The resolved `left` no longer equals the origin's head (dcce1822): only the Lane id still ties them.
  assert.notEqual(resolve.resolution.left, origin.head);
  const mine = await noticed(resolve.id);
  assert(!mine.has(origin.id), 'the origin is not a peer to the Lane resolving it');
  assert(!mine.has(sibling.id), 'nor are its other resolutions');
  assert(mine.has(unrelated.id), 'unrelated work still notifies');
  const theirs = await noticed(origin.id);
  assert(
    !theirs.has(resolve.id) && !theirs.has(sibling.id),
    'the origin hears nothing about its resolutions',
  );
  assert(theirs.has(unrelated.id));
});

test('Lanes of one stack get no overlap notices about each other; other Lanes and detached ones do', async () => {
  const { lane, noticed, overlapRow } = await project();
  const root = await lane('Stack root');
  const child = await lane('On the root', stackOn(root));
  const grandchild = await lane('On the child', stackOn(child));
  const sibling = await lane('Also on the root', stackOn(root));
  const outsider = await lane('Not in the stack');
  const detached = await lane('Left the stack', { stack: { ...stackOn(root).stack, detached: true } });
  assert.equal(overlapRow(child.id).stackRoot, root.id);
  assert.equal(overlapRow(grandchild.id).stackRoot, root.id, 'the root, not the parent');
  assert.equal(overlapRow(root.id).stackRoot, undefined);
  assert.equal(overlapRow(outsider.id).stackRoot, undefined, 'a Lane outside any stack stores nothing');
  assert.equal(overlapRow(detached.id).stackRoot, undefined);
  const stack = [root, child, grandchild, sibling];
  for (const member of stack) {
    const seen = await noticed(member.id);
    for (const other of stack)
      if (other !== member) assert(!seen.has(other.id), `${member.id} / ${other.id}`);
    assert(seen.has(outsider.id) && seen.has(detached.id), 'peers outside the stack still notify');
  }
  const outside = await noticed(outsider.id);
  for (const member of stack) assert(outside.has(member.id), 'the outsider hears about the stack');
});

test('a stack member whose row predates the link fields still excludes its stack, from the Lane record', async () => {
  const { lane, noticed, overlapRow, s } = await project();
  const root = await lane('Stack root');
  const child = await lane('On the root', stackOn(root));
  const outsider = await lane('Not in the stack');
  // Rows written before this field existed carry neither link; the focus Lane's own record supplies them.
  s.patch('projectHostedOverlapLanes', overlapRow(child.id)._id, {
    stackRoot: undefined,
    stackParent: undefined,
  });
  const seen = await noticed(child.id);
  assert(!seen.has(root.id), 'parent excluded from the record alone');
  assert(seen.has(outsider.id));
});

// Coordination before the queue (D2, Issue 1eb42254): hot-file notices, declared-scope advice at
// start, the peer's landing phase and ETA on overlap items, and the stack-on-pending-head offer.
{
  const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));

  const file = (blob = 'a') => ({ blob: blob.repeat(64), mode: 'file' });
  const change = (path, ranges = [{ start: 0, end: 1 }]) => ({
    path,
    before: file('a'),
    after: file('b'),
    evidence: { baseBlob: file('a').blob, ranges, symbols: [] },
  });
  const laneRow = (laneId, changes, extra = {}) => ({
    laneId,
    intentId: randomUUID(),
    intent: `Work of ${laneId.slice(0, 4)}`,
    actor: 'owner',
    head: 'c'.repeat(64),
    baseHead: 'd'.repeat(64),
    baseSequence: 0,
    open: true,
    changes: JSON.stringify(changes),
    complete: true,
    ...extra,
  });
  const main = { head: 'd'.repeat(64), sourceRevision: 0 };
  const advise = (mine, peers, extra = {}) =>
    hostedOverlapAdvice(
      mine,
      peers,
      null,
      main,
      extra.answered ?? new Set(),
      true,
      extra.items ?? 5,
      extra.path,
      undefined,
      extra.scope,
    ).unacknowledgedOverlaps;

  test('hot file: one advisory notice once three open Lanes saved a path, none at two; capped per read', () => {
    const mine = laneRow('aaaaaaaa-0000-4000-8000-000000000001', [
      change('docs/x.md', [{ start: 0, end: 1 }]),
    ]);
    const peer = id => laneRow(id, [change('docs/x.md', [{ start: 50, end: 51 }])]);
    const two = advise(mine, [peer('bbbbbbbb-0000-4000-8000-000000000002')]);
    assert.equal(two.items.filter(item => item.reason === 'hot-file').length, 0, 'two Lanes are not hot');
    const three = advise(mine, [
      peer('bbbbbbbb-0000-4000-8000-000000000002'),
      peer('cccccccc-0000-4000-8000-000000000003'),
    ]);
    const hot = three.items.filter(item => item.reason === 'hot-file');
    assert.equal(hot.length, 1);
    assert.equal(hot[0].class, 'advisory');
    assert.equal(hot[0].file, 'docs/x.md');
    assert.match(hot[0].text, /docs\/x\.md is in 3 open Lanes/);
    assert.match(hot[0].text, /per-Issue file or landing it first/);
    assert.equal(three.blockingCount, 0, 'hot-file advice never blocks');
    // An answered hot-file notice stays quiet.
    const quiet = advise(
      mine,
      [peer('bbbbbbbb-0000-4000-8000-000000000002'), peer('cccccccc-0000-4000-8000-000000000003')],
      { answered: new Set([hot[0].noticeId]) },
    );
    assert.equal(quiet.items.filter(item => item.reason === 'hot-file').length, 0);
    // Many hot paths: at most HOT_FILE_ITEMS listed, all counted.
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    const many = advise(
      laneRow(
        'aaaaaaaa-0000-4000-8000-000000000001',
        paths.map(path => change(path, [{ start: 0, end: 1 }])),
      ),
      ['bbbbbbbb-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003'].map(id =>
        laneRow(
          id,
          paths.map(path => change(path, [{ start: 90, end: 91 }])),
        ),
      ),
      { items: 50 },
    );
    assert.equal(many.items.filter(item => item.reason === 'hot-file').length, HOT_FILE_ITEMS);
    assert.equal(many.advisoryCount, paths.length);
  });

  test('declared scope: a fresh Lane learns which open Lanes already saved files inside it', () => {
    const mine = laneRow('aaaaaaaa-0000-4000-8000-000000000001', []);
    const peer = laneRow('bbbbbbbb-0000-4000-8000-000000000002', [
      change('src/api/a.ts'),
      change('README.md'),
    ]);
    const other = laneRow('cccccccc-0000-4000-8000-000000000003', [change('web/x.ts')]);
    assert.equal(advise(mine, [peer, other]).items.length, 0, 'no scope, nothing to compare');
    const scoped = advise(mine, [peer, other], { scope: ['src/api/'] });
    assert.equal(scoped.items.length, 1);
    assert.equal(scoped.items[0].reason, 'declared-scope');
    assert.equal(scoped.items[0].file, 'src/api/a.ts');
    assert.match(scoped.items[0].text, /has saved 1 file\(s\) in your declared scope: src\/api\/a\.ts/);
    assert(inScope(['README.md'], 'README.md') && !inScope(['src/'], 'srcx/a.ts'));
  });

  test('peer phase and ETA text, and the stack offer only for an admitted peer of an unstacked Lane', () => {
    assert.equal(peerPhaseText(null), 'peer is editing (no landing yet)');
    assert.equal(
      peerPhaseText({ submissionId: randomUUID(), phase: 'checking', etaMinutes: 6 }),
      'peer landing is checking, lands in about 6 min',
    );
    assert.match(
      peerPhaseText({ submissionId: randomUUID(), phase: 'ready', etaMinutes: 1 }),
      /admitted \(its Lane check passed\), lands in about 1 min/,
    );
    const laneId = randomUUID(),
      peer = randomUUID(),
      submissionId = randomUUID();
    const offer = phase =>
      stackOffer({
        laneId,
        stacked: false,
        landing: false,
        mode: 'offer',
        peers: [{ laneId: peer, landing: { submissionId, phase, etaMinutes: 3 } }],
      });
    for (const phase of ['composing', 'queued', 'checking']) assert.equal(offer(phase), null, phase);
    const ready = offer('ready');
    assert.equal(ready.peerLaneId, peer);
    assert.equal(ready.submissionId, submissionId);
    assert.equal(ready.command, `nforge agent . sync '${JSON.stringify({ laneId, stackOn: peer })}'`);
    assert.equal(
      stackOffer({
        laneId,
        stacked: true,
        landing: false,
        mode: 'offer',
        peers: [{ laneId: peer, landing: { submissionId, phase: 'ready', etaMinutes: 1 } }],
      }),
      null,
      'a stacked Lane gets no second stack',
    );
    assert.equal(
      stackOffer({
        laneId,
        stacked: false,
        landing: false,
        mode: 'auto',
        peers: [{ laneId: peer, landing: null }],
      }),
      null,
      'an editing peer is not stacked on',
    );
  });

  test('stacking setting: stored-only, offer by default, auto when set', () => {
    assert.equal(stackingMode(undefined), 'offer');
    assert.equal(stackingMode(mergeAgentDefaults(undefined, { stacking: 'auto' })), 'auto');
    assert.throws(() => mergeAgentDefaults(undefined, { stacking: 'always' }));
  });

  test('client: hot-file notices are capped per path per Lane; the last offer drives stacking:auto', t => {
    const state = mkdtempSync(join(tmpdir(), 'forge-coordination-'));
    const prior = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    t.after(() => {
      if (prior === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prior;
      rmSync(state, { recursive: true, force: true });
    });
    const laneId = randomUUID();
    const advice = {
      unacknowledgedOverlaps: {
        count: 2,
        coverage: 'hosted',
        items: [
          { noticeId: 'n1', reason: 'hot-file', file: 'docs/x.md', lanes: [], text: 'hot' },
          { noticeId: 'n2', reason: 'unavailable', file: 'a.ts', lanes: [], text: 'pair' },
        ],
      },
    };
    for (let shown = 0; shown < HOT_FILE_SHOWS; shown++)
      assert.equal(limitHotFiles(laneId, advice).unacknowledgedOverlaps.items.length, 2);
    const capped = limitHotFiles(laneId, advice).unacknowledgedOverlaps.items;
    assert.deepEqual(
      capped.map(item => item.noticeId),
      ['n2'],
      'the hot-file notice leaves after its cap; the pair notice stays',
    );
    const peer = randomUUID();
    rememberStackOffer(laneId, { peerLaneId: peer, mode: 'offer' });
    assert.equal(autoStackPeer(laneId), undefined, 'offer mode never stacks by itself');
    rememberStackOffer(laneId, { peerLaneId: peer, mode: 'auto' });
    assert.equal(autoStackPeer(laneId), peer);
    rememberStackOffer(laneId, undefined);
    assert.equal(autoStackPeer(laneId), undefined, 'a receipt without an offer clears it');
  });

  test('client: notices name the owning package, the peer phase and the one stack command', () => {
    const paths = ['package.json', 'packages/api/package.json', 'packages/api/src/a.ts', 'docs/x.md'];
    assert.equal(owningPackage(paths, 'packages/api/src/a.ts'), 'packages/api');
    assert.equal(owningPackage(paths, 'docs/x.md'), '.');
    assert.equal(owningPackage(['go.mod'].slice(1), 'a.go'), null);
    const laneId = randomUUID(),
      peer = randomUUID();
    const offer = {
      peerLaneId: peer,
      submissionId: randomUUID(),
      mode: 'offer',
      command: `nforge agent . sync '${JSON.stringify({ laneId, stackOn: peer })}'`,
      text: 'Lane x touches your files and is admitted: build on its pending head now.',
    };
    const notice = hostedOverlapNotice('/nowhere', laneId, {
      unacknowledgedOverlaps: {
        count: 1,
        coverage: 'hosted',
        items: [
          {
            noticeId: 'n1',
            class: 'advisory',
            reason: 'unavailable',
            file: 'src/a.ts',
            lanes: [laneId, peer],
            participants: [{ lane: peer, actor: 'owner', intent: 'Peer work' }],
            peerLanding: { submissionId: offer.submissionId, phase: 'ready', etaMinutes: 1 },
            text: 'pair',
          },
        ],
      },
      stackOffer: offer,
    });
    assert.match(notice.items[0].peer, /admitted/);
    assert.deepEqual(notice.stack, { mode: 'offer', text: offer.text, command: offer.command });
    const banner = overlapBanner(notice);
    assert.match(banner, /Peer work \(peer is admitted/);
    assert.match(banner, /Stack \(offer\)/);
    assert(banner.includes(offer.command));
    // The agent receipt keeps the stack command and the peer phase on an advisory notice.
    const slim = slimReceipt({
      transport: 'hosted',
      schema: 1,
      action: 'save',
      result: {},
      overlapNotice: notice,
    });
    assert.deepEqual(slim.overlapNotice.stack, notice.stack);
    assert.match(slim.overlapNotice.with[0], /peer is admitted/);
  });

  async function readFixture(t, policy = {}) {
    const s = await saveFixture('original', 'a.txt');
    s.patch('hostedProjects', s.projectId, {
      autonomyPolicy: { ...policyPreset('trusted'), agentDefaults: { dormantAfterDays: 0, ...policy } },
    });
    const lane = JSON.parse(
      [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane')
        .value,
    );
    const identity = { projectId: s.projectId, actor: 'owner', authorityEpoch: 1 };
    const write = (record, changes, intent) =>
      s.transaction(
        'write',
        {
          _handler: async ctx => {
            const row = await records.readHostedRecord(ctx, { ...identity, kind: 'lane', key: record.id });
            const current = row ? JSON.parse(row.value) : null;
            await records.writeHostedRecord(ctx, {
              ...identity,
              expectedVersion: current ? current.version : null,
              record: current
                ? {
                    ...current,
                    head: String(current.version + 1).padStart(64, 'e'),
                    version: current.version + 1,
                    sourceVersion: current.sourceVersion + 1,
                  }
                : record,
              overlap: {
                baseSequence: 0,
                intent,
                changes: changes.map(entry => ({
                  ...entry,
                  after: { ...entry.after, blob: digest(record.id + entry.after.blob) },
                })),
              },
            });
          },
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
    const peers = [];
    for (const name of ['Peer one', 'Peer two']) {
      // Live peers (active now): Lanes idle over 6 hours are summarised, never counted as hot.
      const peer = { ...lane, id: randomUUID(), intentId: randomUUID(), at: new Date().toISOString() };
      await write(peer, [], name);
      await write(peer, [change('docs/shared.md', [{ start: 40, end: 41 }]), change('src/api/a.ts')], name);
      peers.push(peer);
    }
    const read = (name, args = {}) =>
      s
        .transaction(name, overlaps.read, { projectId: s.projectId, laneId: lane.id, ...args })
        .then(JSON.parse);
    return { s, lane, peers, write, read };
  }

  test('overlap read: declared scope at start, hot file at three Lanes, peer phase on every pair item', async t => {
    const { s, lane, write, read } = await readFixture(t);
    // A fresh Lane: without scope nothing is read; with scope both peers are named, one item each.
    const before = s.counts.length;
    const fresh = await read('fresh');
    assert.equal(fresh.unacknowledgedOverlaps.count, 0);
    const scoped = await read('scoped', { scope: ['src/api/'] });
    const items = scoped.unacknowledgedOverlaps.items.filter(item => item.reason === 'declared-scope');
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.equal(item.peerLanding, null, 'peers with no landing are editing');
      assert.match(item.text, /peer is editing \(no landing yet\)/);
    }
    assert.equal(scoped.stackOffer, undefined, 'no admitted peer, no stack offer');
    const calls = s.counts.slice(before).filter(count => ['fresh', 'scoped'].includes(count.name));
    assert.equal(calls.length, 2, 'one query per read, no added call');
    t.diagnostic(JSON.stringify(calls.map(count => ({ name: count.name, documents: count.documents }))));
    assert(calls[1].documents <= 60, `scoped start read is bounded: ${calls[1].documents} documents`);
    await assert.rejects(
      read('bad-scope', { scope: ['../outside'] }).then(value => {
        if (value.error) throw Object.assign(new Error(value.error.message), { code: value.error.code });
        return value;
      }),
      error => /scope/.test(error.message),
    );
    // Saving the shared doc makes it a hot file (three open Lanes), still advice only.
    await write(lane, [change('docs/shared.md', [{ start: 0, end: 1 }])], 'My change');
    const saved = await read('saved');
    const hot = saved.unacknowledgedOverlaps.items.find(item => item.reason === 'hot-file');
    assert(hot, 'hot-file notice');
    assert.equal(hot.file, 'docs/shared.md');
    assert.equal(saved.unacknowledgedOverlaps.blockingCount, 0);
  });

  test('a project without peers pays nothing new: an idle Lane read stays under its budget', async t => {
    const { s, read } = await readFixture(t);
    await read('idle');
    const idle = s.counts.find(count => count.name === 'idle');
    assert(!idle.touched.includes('projectHostedLandingQueues'), 'no landing reads without named peers');
    assert(idle.documents <= 10, `idle read touches ${idle.documents} documents`);
  });
}
