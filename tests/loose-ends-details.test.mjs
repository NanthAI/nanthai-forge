// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item fc1831eb, lead mock check (c) and (d): Loose ends row details come from fields the writes that already happen
// keep current, never from a read per row. Saves, landed-before and the check-pass stamp ride the Lane's overlap and
// presence rows; open Lanes and size ride the project row. Each test names the behaviour it guards; the ones marked
// "fails without" were written first against the code before this change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';

const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
const landedModule = await import(moduleUrl('../convex/projectHostedOverlapLanded.ts'));
const stampModule = await import(moduleUrl('../convex/projectLooseEndStamp.ts'));
const feedModule = await import(moduleUrl('../convex/projectFeedTerminal.ts'));
const lineStore = await import(moduleUrl('../convex/projectLiveLineStore.ts'));
const openLanes = await import(moduleUrl('../convex/projectLiveLineOpen.ts'));
const backfillModule = await import(moduleUrl('../convex/projectLooseEndBackfill.ts'));
const loose = await import(moduleUrl('../convex/projectLooseEnds.ts'));
const { looseEndsScreen, sizeWords } = await import(moduleUrl('../web/src/app/needs/loose-ends.ts'));
const { checkCause } = await import('../dist/hosted-check.js');

const day = 86_400_000;
/** One explicit instant for every test: the code under test reads the clock. */
const NOW = 2_000_000_000_000;
const iso = (at = NOW) => new Date(at).toISOString();
const hash = letter => letter.repeat(64);
const lane = (id, extra = {}) => ({
  id,
  intentId: `intent-${id}`,
  actor: 'owner',
  base: { head: hash('b'), receiptId: '00000000-0000-4000-8000-000000000001' },
  head: hash('b'),
  state: 'active',
  at: iso(),
  version: 1,
  sourceVersion: 1,
  lifecycleVersion: 0,
  ...extra,
});
const change = path => ({
  path,
  before: { blob: hash('a'), mode: 'file' },
  after: { blob: hash('c'), mode: 'file' },
  evidence: { baseBlob: hash('a'), ranges: [{ start: 0, end: 1 }], symbols: [] },
});
function setup(t, clock = () => NOW) {
  t.mock.method(Date, 'now', clock);
  const s = state([]);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project' }));
  const run = (name, handler) => s.transaction(() => handler(s.ctx));
  const track = (value, metadata = { baseSequence: 0, changes: [change('a.txt')] }) =>
    run('track', ctx => tracking.trackHostedOverlapLane(ctx, 'project', value, metadata));
  const overlap = id => [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === id);
  const presence = id => [...s.tables.projectHostedPresence.values()].find(row => row.laneId === id);
  return { s, run, track, overlap, presence };
}
/** Count the writes a transaction makes, by table, through the real context. */
function counted(ctx, tables) {
  const log = [];
  const tableOf = id => Object.entries(tables).find(([, rows]) => rows.has(id))?.[0];
  const db = new Proxy(ctx.db, {
    get: (target, key) =>
      ['insert', 'patch', 'replace', 'delete'].includes(key)
        ? (...args) => {
            log.push(key === 'insert' ? args[0] : tableOf(args[0]));
            return target[key](...args);
          }
        : target[key],
  });
  return { ctx: { ...ctx, db }, log };
}
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const markers = s =>
  [...s.tables.projectFinishReadRows.values()].filter(row => row.kind === 'projectLooseChecked');
const summaryRow = (s, id = 'project') =>
  [...s.tables.projectFinishReadRows.values()].find(
    row => row.kind === 'projectLiveLineSummary' && row.sourceId === id,
  );
const summaryOf = (s, id) => JSON.parse(summaryRow(s, id)?.value ?? '{}');
const clearLanes = s => {
  const row = summaryRow(s);
  const { lanes: _, ...rest } = JSON.parse(row.value);
  row.value = JSON.stringify(rest);
};

test('fails without: each moved head is one save on the overlap row, and the presence row carries it on the writes it already makes', async t => {
  const { track, overlap, presence } = setup(t);
  await track(lane('lane-a'));
  assert.equal(overlap('lane-a').saves, 0, 'a start has no save yet');
  await track(lane('lane-a', { head: hash('c') }));
  await track(lane('lane-a', { head: hash('c') }));
  assert.equal(overlap('lane-a').saves, 1, 'the same head written again is not another save');
  await track(lane('lane-a', { head: hash('d') }));
  assert.equal(overlap('lane-a').saves, 2);
  // Same files, inside the refresh window: presence is not rewritten for the count alone, so it trails (never above).
  assert.ok(presence('lane-a').saves <= 2 && presence('lane-a').saves >= 0);
  // The next change of files rewrites it, and so does the 10-minute refresh.
  await track(lane('lane-a', { head: hash('e') }), { baseSequence: 0, changes: [change('b.txt')] });
  assert.equal(presence('lane-a').saves, 3, 'a save that changes the files carries the exact count');
  await track(lane('lane-a', { head: hash('f'), at: iso(NOW + 11 * 60_000) }));
  assert.equal(presence('lane-a').saves, 4, 'the refresh after ten minutes catches the count up');
});

test('fails without: a Lane written before the count existed stays "not recorded" instead of starting from a guess', async t => {
  const { s, track, overlap, presence } = setup(t);
  await track(lane('legacy'));
  await track(lane('legacy', { head: hash('c') }));
  delete s.tables.projectHostedOverlapLanes.get(overlap('legacy')._id).saves;
  delete s.tables.projectHostedPresence.get(presence('legacy')._id).saves;
  await track(lane('legacy', { head: hash('d') }));
  assert.equal(overlap('legacy').saves, undefined);
  assert.equal(presence('legacy').saves, undefined);
  // A Lane started now does count, from zero: only the old row is "not recorded".
  await track(lane('fresh'));
  await track(lane('fresh', { head: hash('c') }));
  assert.equal(overlap('fresh').saves, 1);
});

test('fails without: a Lane whose work landed and was saved again says it landed before', async t => {
  const { s, track, overlap, presence } = setup(t);
  await track(lane('again'));
  await track(lane('again', { head: hash('c') }));
  s.tables.projectHostedOverlapLanes.get(overlap('again')._id).landed = {
    receiptId: 'receipt',
    commit: 'commit',
    laneHead: hash('c'),
    at: iso(),
  };
  await track(lane('again', { head: hash('d') }));
  assert.equal(presence('again').landedBefore, true);
  assert.equal(presence('again').saves, 2);
});

test('bytes and writes per save: the fields add about 10 B to each of two rows and a save writes no row it did not write before', async t => {
  const { s, run, overlap, presence } = setup(t);
  const log = [];
  const save = async head => {
    const { ctx, log: writes } = counted(s.ctx, s.tables);
    await s.transaction(() =>
      tracking.trackHostedOverlapLane(ctx, 'project', lane('measured', { head }), {
        baseSequence: 0,
        changes: [change('a.txt'), change('b.txt')],
      }),
    );
    log.push(
      writes.filter(table => ['projectHostedOverlapLanes', 'projectHostedPresence'].includes(table)).sort(),
    );
  };
  await save(hash('b'));
  await save(hash('c'));
  await save(hash('d'));
  // The save that changes the saved files writes the same two rows it always wrote: overlap and presence.
  assert.deepEqual(log[1], ['projectHostedOverlapLanes', 'projectHostedPresence']);
  assert.deepEqual(
    log[0],
    ['projectHostedOverlapLanes', 'projectHostedPresence'],
    'a start writes the same two rows',
  );
  // A save of the same files inside the refresh window writes the overlap row only, as before this change.
  assert.deepEqual(log[2], ['projectHostedOverlapLanes']);
  const overlapRow = overlap('measured'),
    presenceRow = presence('measured');
  const { saves: _a, passedAt: _b, ...overlapBefore } = overlapRow;
  const { saves: _c, passedAt: _d, landedBefore: _e, ...presenceBefore } = presenceRow;
  const added = [bytes(overlapRow) - bytes(overlapBefore), bytes(presenceRow) - bytes(presenceBefore)];
  console.log(`save: +${added[0]} B on the overlap row, +${added[1]} B on the presence row`);
  assert.ok(
    added.every(n => n > 0 && n <= 24),
    `added bytes ${added}`,
  );
  void run;
});

test('fails without: a passed check stamps the Lanes still on the checked head, and a save that raced it wins either way', async t => {
  const { s, track, run, overlap, presence } = setup(t);
  const T = NOW - 3 * day;
  await track(lane('raced', { head: hash('c') }));
  await track(lane('raced', { head: hash('d') }));
  // The check ran on head c, but the Lane already moved to d: a late pass must not vouch for newer work.
  await run('late', ctx =>
    stampModule.stampLanePass(ctx, 'project', [{ laneId: 'raced', head: hash('c') }], T),
  );
  assert.equal(overlap('raced').passedAt, undefined);
  assert.equal(presence('raced').passedAt, undefined);
  // A pass on the current head stamps both rows; an older pass never replaces a newer stamp.
  await run('on-time', ctx =>
    stampModule.stampLanePass(ctx, 'project', [{ laneId: 'raced', head: hash('d') }], T),
  );
  assert.equal(presence('raced').passedAt, T);
  assert.deepEqual(
    markers(s).map(row => [row.sourceId, row.sourceCreatedAt]),
    [['raced', T]],
    'one marker row per stamped Lane, ordered by the pass',
  );
  await run('older', ctx =>
    stampModule.stampLanePass(ctx, 'project', [{ laneId: 'raced', head: hash('d') }], T - 1000),
  );
  assert.equal(overlap('raced').passedAt, T);
  // The save lands after the pass committed: the new head drops the stamp from both rows.
  await track(lane('raced', { head: hash('e') }));
  assert.equal(overlap('raced').passedAt, undefined);
  assert.equal(presence('raced').passedAt, undefined);
  assert.deepEqual(markers(s), [], 'and its marker row is deleted with it');
});

test('fails without: the stamp survives rewrites of the same head and goes when the Lane closes or lands', async t => {
  const { s, track, run, overlap, presence } = setup(t);
  const T = NOW - 3 * day;
  const stays = '11111111-1111-4111-8111-111111111111';
  await track(lane('kept', { head: hash('c') }));
  await run('stamp', ctx =>
    stampModule.stampLanePass(ctx, 'project', [{ laneId: 'kept', head: hash('c') }], T),
  );
  // A sync, a park change or the 10-minute refresh rewrites presence on the same head: the stamp stays.
  await track(lane('kept', { head: hash('c'), at: iso(NOW + 11 * 60_000) }));
  assert.equal(presence('kept').passedAt, T);
  // A closed Lane has no presence row and no stamp.
  await track(lane('kept', { head: hash('c'), state: 'abandoned' }));
  assert.equal(presence('kept'), undefined);
  assert.equal(overlap('kept').passedAt, undefined);
  assert.deepEqual(markers(s), [], 'a closed Lane leaves no marker');
  // The landing retirement clears a stamp on a Lane that stays open (keepOpen).
  await track(lane(stays, { head: hash('c') }));
  await run('stamp-stays', ctx =>
    stampModule.stampLanePass(ctx, 'project', [{ laneId: stays, head: hash('c') }], T),
  );
  const receiptId = 'receipt-1';
  s.tables.projectHostedAcceptancePages.set('page', {
    _id: 'page',
    _creationTime: 1,
    projectId: 'project',
    receiptId,
    kind: 'inputs',
    index: 0,
    digest: 'd'.repeat(64),
    root: 'r'.repeat(64),
    value: JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-compose-page',
      entries: [
        {
          laneId: stays,
          head: hash('c'),
          version: 1,
          sourceVersion: 1,
          lifecycleVersion: 0,
          state: { object: { sha256: hash('a'), size: 1 }, recipe: null },
        },
      ],
      next: null,
    }),
  });
  await run('retire', ctx =>
    landedModule.retireLandedOverlapLanes(
      ctx,
      { projectId: 'project', receiptId },
      { commit: 'commit', at: iso() },
    ),
  );
  assert.equal(overlap(stays).passedAt, undefined);
  assert.equal(presence(stays)?.passedAt, undefined);
  assert.deepEqual(markers(s), [], 'the landing deletes the marker with the stamp');
});

test('fails without: an unrequested check that passed stamps its Lanes through the feed loop it already runs, from the compose selection', async t => {
  const { s, run, overlap, presence } = setup(t);
  await run('start', ctx =>
    tracking.trackHostedOverlapLane(ctx, 'project', lane('named', { head: hash('c') }), {
      baseSequence: 0,
      changes: [change('a.txt')],
    }),
  );
  s.tables.projectHostedComposes.set('compose', {
    _id: 'compose',
    _creationTime: 1,
    projectId: 'project',
    actor: 'owner',
    operationId: 'op-compose',
    candidateId: 'candidate',
    jobId: 'job',
    value: '{}',
  });
  s.tables.projectHostedComposeSelections.set('selection', {
    _id: 'selection',
    _creationTime: NOW,
    projectId: 'project',
    actor: 'owner',
    operationId: 'op-compose',
    kind: 'inputs',
    key: 'named',
    head: hash('c'),
  });
  const passed = status => ({
    id: 'run',
    projectId: 'project',
    status,
    endedAt: iso(NOW - 3 * day),
    request: { candidateId: 'candidate', operationId: 'op-check' },
  });
  await run('failed', ctx => feedModule.recordCheckFeed(ctx, passed('failed'), checkCause.manual));
  assert.equal(overlap('named').passedAt, undefined, 'a failed check vouches for nothing');
  await run('landing-caused', ctx => feedModule.recordCheckFeed(ctx, passed('passed'), checkCause.landing));
  assert.equal(
    overlap('named').passedAt,
    undefined,
    'a check a landing asked for is not an unrequested pass',
  );
  await run('manual', ctx => feedModule.recordCheckFeed(ctx, passed('passed'), checkCause.manual));
  assert.equal(presence('named').passedAt, Date.parse(passed('passed').endedAt));
  assert.equal(markers(s).length, 1);
});

test("fails without: a set-aside exit measures the size from the project's shards, at most every ten minutes; a landing exit and a start do not", async t => {
  let now = NOW;
  const { s, track, run } = setup(t, () => now);
  const shard = (n, bytes) =>
    s.tables.projectStorageUsage.set(`shard-${n}`, {
      _id: `shard-${n}`,
      _creationTime: 1,
      projectId: 'project',
      shard: n,
      objects: 1,
      bytes,
      pendingObjects: 0,
      pendingBytes: 0,
    });
  const mark = id =>
    s.tables.projectLiveLineLanes.set(`m-${id}`, {
      _id: `m-${id}`,
      _creationTime: 1,
      projectId: 'project',
      laneId: id,
      sourceId: id,
      stage: 'saved',
      held: false,
      overlap: false,
      changedAt: 1,
    });
  shard(0, 5_000_000);
  shard(1, 7_000_000);
  // Starting Lanes writes no summary at all: concurrent starts must not contend on a shared row.
  await track(lane('start', { head: hash('c'), at: iso(now) }));
  assert.equal(summaryRow(s), undefined);
  for (const id of ['a', 'b', 'c', 'd']) mark(id);
  const exit = (id, kind) =>
    run('exit', ctx => lineStore.removeLineMark(ctx.db, s.tables.projectLiveLineLanes.get(`m-${id}`), kind));
  await exit('a', 'landed');
  assert.equal(summaryOf(s).size, undefined, 'a landing exit reads no shards');
  await exit('b', 'set-aside');
  assert.equal(summaryOf(s).size.bytes, 12_000_000);
  shard(2, 1_000_000);
  now += 5 * 60_000;
  await exit('c', 'set-aside');
  assert.equal(summaryOf(s).size.bytes, 12_000_000, 'inside the window the stored size is kept');
  now += 6 * 60_000;
  await exit('d', 'set-aside');
  assert.equal(summaryOf(s).size.bytes, 13_000_000);
});

test('fails without: the backfill gives existing projects and Lanes their fields once, in bounded pages, and never guesses a save count', async t => {
  const { s, run, track, overlap, presence } = setup(t);
  for (let i = 0; i < 12; i++) s.tables.hostedProjects.set(`p${i}`, projectRow({ _id: `p${i}` }));
  s.tables.projectLiveLineLanes.set('mark', {
    _id: 'mark',
    _creationTime: 1,
    projectId: 'p3',
    laneId: 'm',
    sourceId: 'm',
    stage: 'editing',
    held: false,
    overlap: false,
    changedAt: 1,
  });
  s.tables.projectStorageUsage.set('shard', {
    _id: 'shard',
    _creationTime: 1,
    projectId: 'p3',
    shard: 0,
    objects: 1,
    bytes: 42_000_000,
    pendingObjects: 0,
    pendingBytes: 0,
  });
  await track(lane('landed-before', { head: hash('c') }));
  const row = s.tables.projectHostedOverlapLanes.get(overlap('landed-before')._id);
  row.landed = { receiptId: 'r', commit: 'c', laneHead: hash('c'), at: iso() };
  delete row.saves;
  delete s.tables.projectHostedPresence.get(presence('landed-before')._id).saves;
  const runs = [];
  let args = {};
  for (let guard = 0; guard < 20; guard++) {
    const result = await s.transaction(() => backfillModule.backfill._handler(s.ctx, args));
    runs.push(result);
    if (result.isDone) break;
    args = s.scheduled.at(-1).args;
  }
  assert.ok(
    runs.length >= 3 && runs.at(-1).isDone,
    `bounded pages: ${runs.map(r => `${r.stage}:${r.rows}`).join(' ')}`,
  );
  assert.equal(summaryOf(s, 'p3').size.bytes, 42_000_000);
  assert.equal(summaryOf(s, 'p0').size.bytes, 0);
  assert.equal(presence('landed-before').landedBefore, true);
  assert.equal(presence('landed-before').saves, undefined, 'a save count no record keeps stays not recorded');
  // A rerun writes nothing: every row already has its fields.
  s.scheduled.length = 0;
  let again = 0;
  args = {};
  for (let guard = 0; guard < 20; guard++) {
    const result = await s.transaction(() => backfillModule.backfill._handler(s.ctx, args));
    again += result.rows;
    if (result.isDone) break;
    args = s.scheduled.at(-1).args;
  }
  assert.equal(again, 0);
  void run;
});

test('the words on each row: saves, files and landing on Lanes; the pass on checked rows; size and open Lanes on projects', () => {
  const now = 2_000_000_000_000;
  const lanes = rows => ({ reported: true, rows, continueCursor: null });
  const base = { intentId: 'i', actor: 'jun', agent: 'quiet-otter', paths: 2, at: now - 6 * day };
  const screen = looseEndsScreen(
    {
      at: now,
      setAside: { authorityEpoch: 1 },
      groups: {
        idle: lanes([
          { ...base, laneId: 'one', title: 'Fix flaky retry timer', saves: 3 },
          { ...base, laneId: 'two', title: 'Try streaming decoder', saves: 1, paths: 7 },
          { ...base, laneId: 'three', title: 'Old', saves: 4, landedBefore: true },
          { ...base, laneId: 'four', title: 'Legacy' },
        ]),
        checked: lanes([
          { ...base, laneId: 'five', title: 'Docs: typo sweep', passedAt: now - 3 * day, saves: 2 },
        ]),
        stopped: lanes([
          { ...base, laneId: 'six', title: 'Docs: migration guide v3', saves: 3, at: now - 3 * 3_600_000 },
          { ...base, laneId: 'seven', title: 'Nothing', saves: 0, paths: 0, at: now - 3 * 3_600_000 },
          { ...base, laneId: 'eight', title: 'Legacy stopped', at: now - 3 * 3_600_000 },
        ]),
        projects: lanes([
          {
            projectId: 'p1',
            name: 'mara-scratch',
            role: 'owner',
            lastLandingAt: now - 41 * day,
            reason: 'x',
            openLanes: 0,
            bytes: 12_000_000,
          },
          {
            projectId: 'p2',
            name: 'tidepool-docs-old',
            role: 'owner',
            lastLandingAt: now - 30 * day,
            reason: 'x',
            openLanes: 1,
            bytes: 88_400_000,
          },
          { projectId: 'p3', name: 'old-one', role: 'owner', lastLandingAt: null, reason: 'x' },
          { projectId: 'p4', name: 'half', role: 'owner', lastLandingAt: null, reason: 'x', openLanes: 2 },
        ]),
        dated: lanes([]),
      },
    },
    {},
    now,
  );
  const evidence = key => screen.sections.find(section => section.key === key).rows.map(row => row.evidence);
  assert.deepEqual(evidence('idle'), [
    '3 saves, 2 files, never landed',
    '1 save, 7 files, never landed',
    '4 saves, 2 files, landed before',
    'saves not recorded, 2 files',
  ]);
  assert.deepEqual(evidence('checked'), ['passed its check 3 days ago; landing was never asked for']);
  assert.deepEqual(evidence('stopped'), [
    '3 saves not landed. Why it stopped: not reported',
    'Nothing saved yet. Why it stopped: not reported',
    '2 files now, saves not recorded. Why it stopped: not reported',
  ]);
  assert.deepEqual(evidence('projects'), [
    '12 MB, 0 open Lanes',
    '88 MB, 1 open Lane',
    'size not recorded, open Lanes not recorded',
    'size not recorded, 2 open Lanes',
  ]);
  assert.deepEqual([0, 400_000, 12_000_000, 310_000_000, 1_200_000_000_000].map(sizeWords), [
    '0 MB',
    '<1 MB',
    '12 MB',
    '310 MB',
    '1.2 TB',
  ]);
});

test('fails without: the reader lists Lanes an unrequested check passed on once, oldest pass first, and not again as quiet', async t => {
  const now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const s = state([]);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project' }));
  const mark = (laneId, passedAt) =>
    s.tables.projectFinishReadRows.set(`mark-${laneId}`, {
      _id: `mark-${laneId}`,
      _creationTime: 1,
      kind: 'projectLooseChecked',
      sourceId: laneId,
      sourceCreatedAt: passedAt,
      projectId: 'project',
      value: '{}',
    });
  const row = (laneId, at, extra = {}) =>
    s.tables.projectHostedPresence.set(laneId, {
      _id: laneId,
      _creationTime: 1,
      projectId: 'project',
      laneId,
      intentId: `i-${laneId}`,
      actor: 'owner',
      goal: laneId,
      paths: ['a'],
      pathCount: 1,
      at,
      ...extra,
    });
  row('quiet-checked', now - 5 * 3_600_000, { passedAt: now - 4 * 3_600_000, saves: 2 });
  mark('quiet-checked', now - 4 * 3_600_000);
  row('old-checked', now - 4 * day, { passedAt: now - 3 * day, saves: 5 });
  mark('old-checked', now - 3 * day);
  row('fresh-pass', now - 5 * 3_600_000, { passedAt: now - 10 * 60_000, saves: 1 });
  mark('fresh-pass', now - 10 * 60_000);
  // A marker whose Lane was saved meanwhile (its presence row no longer carries that stamp) is never listed.
  row('saved-since', now - 6 * 3_600_000);
  mark('saved-since', now - 20 * day);
  row('just-quiet', now - 5 * 3_600_000);
  for (let n = 0; n < 11; n++) {
    row(`more-${n}`, now - (10 + n) * day, { passedAt: now - (10 + n) * day });
    mark(`more-${n}`, now - (10 + n) * day);
  }
  const call = async args =>
    JSON.parse(
      await s.transaction(() =>
        loose.read._handler(
          { ...s.ctx, auth: { getUserIdentity: async () => ({ subject: 'owner' }) } },
          { projectId: 'project', ...args },
        ),
      ),
    );
  const first = await call({ details: true });
  const names = group => first.groups[group].rows.map(r => r.laneId);
  assert.equal(first.groups.checked.reported, true);
  // Three markers are examined on the first page (the page budget); one is stale (that Lane was saved since), so two
  // Lanes are listed and the cursor still moves past all three.
  assert.equal(first.groups.checked.rows.length, 2, 'the first page is bounded for the page budget');
  assert.ok(first.groups.checked.continueCursor);
  assert.equal(first.groups.checked.rows[0].laneId, 'more-10', 'oldest pass first');
  assert.ok(
    !names('idle').some(id => id.startsWith('more-') || id === 'old-checked'),
    'a checked Lane is not also idle',
  );
  assert.ok(!names('stopped').includes('quiet-checked'));
  assert.ok(
    names('stopped').includes('fresh-pass'),
    'a pass inside the quiet period does not make a Lane checked',
  );
  // The next page of that group alone, with the rest and no repeats.
  const next = await call({ cursor: first.groups.checked.continueCursor });
  assert.deepEqual(Object.keys(next.groups), ['checked']);
  const all = [...first.groups.checked.rows, ...next.groups.checked.rows].map(r => r.laneId);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(
    all.sort(),
    [
      'more-0',
      'more-1',
      'more-2',
      'more-3',
      'more-4',
      'more-5',
      'more-6',
      'more-7',
      'more-8',
      'more-9',
      'more-10',
      'old-checked',
      'quiet-checked',
    ].sort(),
  );
  // The compact read (the folded region) does not read the group at all.
  const compact = await call({});
  assert.equal(compact.groups.checked.reported, false);
});

test('fails without: leftover projects show size from the summary and open Lanes counted from presence, 25+ past the cap', async t => {
  const now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const s = state([]);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project' }));
  const { inactiveProjects } = await import(moduleUrl('../convex/projectLooseEndsDetails.ts'));
  for (let n = 0; n < 4; n++) {
    const id = `p${n}`;
    s.tables.hostedProjects.set(id, projectRow({ _id: id, _creationTime: now - 60 * day }));
    s.tables.accountProjectOrder.set(`o${n}`, {
      _id: `o${n}`,
      _creationTime: n,
      projectId: id,
      person: 'owner',
      activityHour: n,
    });
  }
  s.tables.projectFinishReadRows.set('s1', {
    _id: 's1',
    _creationTime: 1,
    kind: 'projectLiveLineSummary',
    sourceId: 'p1',
    projectId: 'p1',
    value: JSON.stringify({ size: { bytes: 3_000_000, at: now } }),
  });
  const lanes = (id, count) => {
    for (let i = 0; i < count; i++)
      s.tables.projectHostedPresence.set(`${id}-${i}`, {
        _id: `${id}-${i}`,
        _creationTime: 1,
        projectId: id,
        laneId: `${id}-${i}`,
        intentId: 'i',
        actor: 'owner',
        goal: 'g',
        paths: [],
        pathCount: 0,
        at: now - 40 * day,
      });
  };
  lanes('p1', 2);
  lanes('p3', 30);
  const reply = await s.transaction(() =>
    inactiveProjects(s.ctx, s.tables.hostedProjects.get('project'), 'owner', now),
  );
  const by = Object.fromEntries(reply.rows.map(row => [row.projectId, row]));
  assert.deepEqual(
    [by.p0.openLanes, by.p0.bytes],
    [0, undefined],
    'no Lane: zero, and no size means not measured',
  );
  assert.deepEqual([by.p1.openLanes, by.p1.bytes], [2, 3_000_000]);
  assert.deepEqual(
    [by.p3.openLanes, by.p3.openLanesMore],
    [25, true],
    'past the cap it says 25+, never a number it did not count',
  );
});
