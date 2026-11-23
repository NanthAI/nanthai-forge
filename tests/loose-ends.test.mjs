// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item fc1831eb: one compact read of loose ends. Dormant Lanes and Lanes quiet for over 90 minutes are listed oldest
// first from presence rows (no per-Lane reads); groups with no data yet say "not reported" with the reason; only the
// owner gets the authority to set Lanes aside; another account cannot read it. The page words each set-aside result,
// and only a failed call is retried.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';
import { meterReads } from './hosted-read-set.mjs';
const { digest } = await import(moduleUrl('../src/state/hash.ts'));

const loose = await import(moduleUrl('../convex/projectLooseEnds.ts'));
const { looseEndsView, looseEndsScreen, mergePage, setAsideWord } = await import(
  moduleUrl('../web/src/app/needs/loose-ends.ts')
);
const { liveLanes } = await import('../dist/hosted-live-lanes.js');
const { hostedAgentCli } = await import('../dist/hosted-agent-cli.js');
const { recordLane } = await import('../dist/lane-registry.js');
const { tryHeavySlot } = await import('../dist/heavy-slots.js');
const day = 24 * 60 * 60 * 1000;
/** A Lane record as the server keeps it (shape of a real resolution Lane), with its origin when it resolves one. */
const laneRecord = (laneId, origin) =>
  JSON.stringify({
    schema: 2,
    projectId: 'project',
    laneId,
    intentId: 'intent-dormant',
    head: 'a'.repeat(64),
    version: 3,
    sourceVersion: 3,
    lifecycleVersion: 0,
    state: 'active',
    authorship: { kind: 'agent' },
    agentClient: 'claude-code:synthetic-model',
    agentRun: 'quiet-otter',
    base: { head: 'b'.repeat(64), receiptId: '00000000-0000-4000-8000-000000000001' },
    authority: { mode: 'server', epoch: 1 },
    at: new Date().toISOString(),
    ...(origin
      ? {
          resolution: {
            origin: { laneId: origin, head: 'c'.repeat(64), sourceVersion: 6 },
            left: 'c'.repeat(64),
            right: 'd'.repeat(64),
            status: 'resolved',
          },
        }
      : {}),
  });

function fixture() {
  const s = state([]);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project' }));
  const now = Date.now();
  const lanes = [
    ['dormant-old', now - 9 * day, 'Try streaming decoder'],
    ['dormant', now - 3 * day, 'Fix flaky retry timer'],
    ['quiet', now - 3 * 60 * 60 * 1000, 'Docs: migration guide'],
    ['busy', now - 5 * 60 * 1000, 'Working right now'],
  ];
  for (const [laneId, at, goal] of lanes)
    s.tables.projectHostedPresence.set(`presence-${laneId}`, {
      _id: `presence-${laneId}`,
      _creationTime: 1,
      projectId: 'project',
      laneId,
      intentId: `intent-${laneId}`,
      actor: 'owner',
      agent: 'quiet-otter',
      goal,
      paths: ['src/a.ts'],
      pathCount: 1,
      at,
    });
  return s;
}
const read = async (s, subject, args = {}) => {
  s.ctx.auth.getUserIdentity = async () => (typeof subject === 'string' ? { subject } : subject);
  return JSON.parse(await loose.read._handler(s.ctx, { projectId: 'project', ...args }));
};

test('one read lists dormant and quiet Lanes oldest first and names the groups it cannot report yet', async () => {
  const s = fixture();
  const result = await read(s, 'owner');
  assert.deepEqual(
    result.groups.idle.rows.map(row => row.laneId),
    ['dormant-old', 'dormant'],
  );
  assert.deepEqual(
    result.groups.stopped.rows.map(row => row.laneId),
    ['quiet'],
  );
  for (const key of ['checked', 'projects', 'dated']) {
    assert.equal(result.groups[key].reported, false);
    assert.ok(result.groups[key].why.length > 10, `${key} says why`);
  }
  assert.equal(typeof result.setAside.authorityEpoch, 'number', 'the owner may set Lanes aside');
  const view = looseEndsView(result, result.at);
  assert.equal(view.groups[0].rows[0].who, 'owner/quiet-otter');
  const screen = looseEndsScreen(result, {}, result.at);
  assert.equal(screen.total, 3);
  // Lead mock check (a): the mock sentence; a group not reported says so on its own band, never here.
  assert.equal(screen.sentence.bold, '3 loose ends, none urgent.');
  assert.match(
    screen.sentence.rest,
    /^The oldest is a Lane with no save for 9 days\. Setting a Lane aside keeps every save; a project in the trash can be restored for 90 days\.$/,
  );
});

test('a Lane named by a bare Item id is listed under its Item title', async () => {
  const s = fixture();
  const itemId = 'ffb6cc49-9a3f-4d2e-8b1c-0123456789ab';
  s.tables.projectHostedRecordHeads.set(`issue-${itemId}`, {
    _id: `issue-${itemId}`,
    projectId: 'project',
    kind: 'issue',
    key: itemId,
    status: 'open',
    version: 1,
    recordId: 'record',
    value: JSON.stringify({ id: itemId, title: 'Licence: AGPL + company', status: 'open' }),
  });
  s.tables.projectHostedPresence.get('presence-dormant').goal = itemId;
  // A goal that is already words is left alone, and a bare id with no Item keeps the id (the screen words it).
  s.tables.projectHostedPresence.get('presence-quiet').goal = 'a'.repeat(40);
  const result = await read(s, 'owner');
  const title = id =>
    [...result.groups.idle.rows, ...result.groups.stopped.rows].find(row => row.laneId === id).title;
  assert.equal(title('dormant'), 'Licence: AGPL + company');
  assert.equal(title('dormant-old'), 'Try streaming decoder');
  assert.equal(title('quiet'), 'a'.repeat(40));
  const screen = looseEndsScreen(result, {}, result.at);
  const shown = screen.sections.flatMap(section => section.rows).find(row => row.laneId === 'quiet');
  assert.equal(shown.title, 'Lane quiet', 'an unresolved bare id never shows as a title');
});

test('an agent lists dated checks and inactive projects in bounded pages without exposing revoked projects', async t => {
  const { HOSTED_WORK_INDEX_FORMAT } = await import(moduleUrl('../src/work-hosted-summary.ts'));
  const { planningSearchEntries } = await import(moduleUrl('../src/planning-search.ts'));
  const now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const s = fixture();
  s.tables.hostedProjects.set(
    'project',
    projectRow({
      _id: 'project',
      _creationTime: now - 60 * day,
      work: {
        generationId: 'dates',
        backupId: 'backup',
        operationId: 'work',
        initialRevision: 0,
        revision: 1,
      },
    }),
  );
  s.tables.projectWorkGenerations.set('dates', {
    _id: 'dates',
    _creationTime: 1,
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    planningSearchVersion: 2,
    projectId: 'project',
    backupId: 'backup',
  });
  const addDate = (id, position, body, status = 'open') => {
    const [entry] = planningSearchEntries(
      {
        id,
        kind: 'issue',
        status,
        title: 'Release checklist',
        body,
        version: 3,
        // Lead mock check (f): a dated row names its Item's owner and says when the Item is still proposed.
        ...(status === 'proposed' ? { owner: '@owner/quiet-otter' } : {}),
      },
      position,
    );
    s.tables.projectPlanningRecords.set(id, {
      ...entry,
      _id: id,
      _creationTime: position,
      projectId: 'project',
      generationId: 'dates',
    });
  };
  for (let n = 1; n <= 26; n++) {
    const id = `owned-${String(n).padStart(2, '0')}`;
    s.tables.hostedProjects.set(id, projectRow({ _id: id, _creationTime: now - 60 * day }));
    const order = { _id: `order-${id}`, _creationTime: n, projectId: id, person: 'owner', activityHour: n };
    s.tables.accountProjectOrder.set(order._id, order);
    addDate(
      id,
      n,
      'A long note. '.repeat(100) +
        '\n- [x] @due 2000-01-01 Done\n- [ ] @due 2000-02-30 Invalid\n' +
        (n === 26 ? '- [x] @due 2000-03-01 Inspected' : '- [ ] @due 2000-03-01 Inspect receipts') +
        '\n- [ ] @due 2099-06-06 Retain another date',
      n === 26 ? 'proposed' : 'open',
    );
  }
  addDate('closed', 27, '- [ ] @due 2000-01-01 Closed', 'closed');
  for (const [id, patch] of [
    ['recent-landing', {}],
    ['new-project', { _creationTime: now - day }],
    ['removed', { removal: 'trash' }],
    ['revoked', { owner: 'stranger' }],
  ]) {
    s.tables.hostedProjects.set(id, projectRow({ _id: id, _creationTime: now - 60 * day, ...patch }));
    const order = { _id: `order-${id}`, _creationTime: 0, projectId: id, person: 'owner', activityHour: 0 };
    s.tables.accountProjectOrder.set(order._id, order);
  }
  for (const [id, age] of [
    ['recent-landing', 29],
    ['owned-01', 30],
  ]) {
    s.tables.projectHostedAcceptances.set(id, { _id: id, _creationTime: now - age * day, projectId: id });
  }
  // Lead mock check (d): an open permanent-delete request of the account waits on the first page; an expired one never.
  for (const [id, expiresAt] of [
    ['request-open', now + 60_000],
    ['request-expired', now - 1],
  ])
    s.tables.projectDeleteRequests.set(id, {
      _id: id,
      _creationTime: 1,
      owner: 'owner',
      requester: { device: true },
      operationId: id,
      request: '{}',
      selector: 'the trash',
      at: now - 60_000,
      expiresAt,
      projects: Array.from({ length: 40 }, (_, i) => ({ projectId: `trashed-${i}` })),
      status: 'requested',
    });
  const meter = meterReads(s.ctx);
  const started = performance.now(),
    heapAtStart = process.memoryUsage().heapUsed;
  let initial;
  const cost = await meter.cost(async () => {
    initial = await read(s, 'owner', { details: true });
  });
  const initialHeap = process.memoryUsage().heapUsed - heapAtStart;
  t.diagnostic(
    `all five groups: ${cost.documents} documents, ${cost.bytes} fixture B, ${Buffer.byteLength(JSON.stringify(initial))} reply B, ${Math.round(performance.now() - started)} ms, ${initialHeap} sampled heap B`,
  );
  const { idle, stopped, checked, dated, projects } = initial.groups;
  assert.ok(idle.rows[0].reason && stopped.rows[0].reason);
  // Checked, never landed is read on the details page from the stored stamp: none passed in this fixture.
  assert.deepEqual([checked.reported, checked.rows], [true, []]);
  assert.equal(dated.rows.length, 25);
  assert.deepEqual(dated.rows[0], {
    selection: { itemId: 'owned-01', expectedVersion: 3 },
    title: 'Release checklist',
    date: '2000-03-01',
    line: 4,
    text: 'Inspect receipts',
    reason: 'Date passed',
  });
  // The first page examines 10 account rows (four filtered out: a recent landing, a new project, a removed one and one
  // the reader has no role on); the rest follow in pages of 25.
  assert.equal(projects.rows.length, 6);
  assert.ok(projects.rows.every(row => row.projectId.startsWith('owned-')));
  assert.ok(
    projects.rows.every(row => row.trash?.expectedRevision === 1),
    'each of the reader’s own projects carries the revision its trash call pins',
  );
  assert.deepEqual(projects.deleteRequests, [
    { id: 'request-open', selector: 'the trash', projects: 40, byDevice: true },
  ]);
  assert.equal(projects.rows[0].lastLandingAt, now - 30 * day);
  assert.match(projects.rows[1].reason, /since creation/);
  assert.ok(cost.documents <= 110);
  meter.restore();

  // A missing boundary does not repeat rows and a page only returns the selected group.
  s.tables.projectPlanningRecords.delete('owned-25');
  const later = await read(s, 'owner', { cursor: dated.continueCursor });
  assert.deepEqual(Object.keys(later.groups), ['dated']);
  assert.deepEqual(
    later.groups.dated.rows.map(row => row.selection.itemId),
    ['owned-26'],
  );
  assert.equal(later.groups.dated.rows[0].reason, 'Upcoming date');
  assert.equal(later.groups.dated.rows[0].proposed, true);
  assert.equal(later.groups.dated.rows[0].owner, '@owner/quiet-otter');
  const moreProjects = await read(s, 'owner', { cursor: projects.continueCursor });
  assert.deepEqual(Object.keys(moreProjects.groups), ['projects']);
  assert.equal(moreProjects.groups.projects.deleteRequests, undefined, 'only the first page says what waits');
  assert.deepEqual(
    moreProjects.groups.projects.rows.map(row => row.projectId),
    Array.from({ length: 20 }, (_, i) => `owned-${String(i + 7).padStart(2, '0')}`),
  );

  s.tables.cliCredentials.set('credential', {
    _id: 'credential',
    _creationTime: 1,
    credentialId: 'synthetic-device',
    owner: 'owner',
    scope: 'cli',
    issuedAt: now,
    expiresAt: now + 60_000,
    revoked: false,
    settings: { projects: { kind: 'project', projectId: 'project' } },
  });
  const scoped = await read(
    s,
    { subject: 'owner', forgeCredential: 'synthetic-device' },
    { cursor: projects.continueCursor },
  );
  assert.deepEqual(
    scoped.groups.projects.rows.map(row => row.projectId),
    ['project'],
  );
  assert.equal(scoped.groups.projects.continueCursor, null);

  s.tables.projectWorkHeads.set('work-head', {
    _id: 'work-head',
    _creationTime: 1,
    projectId: 'project',
    backupId: 'backup',
    revision: 2,
  });
  await assert.rejects(
    read(s, 'owner', { cursor: dated.continueCursor }),
    error => error.data?.code === 'WORK_STALE',
  );

  // Date results still advance when each matched root is wider than the byte target.
  s.tables.projectPlanningRecords.clear();
  const wide = '- [ ] @due 2050-01-01 Inspect receipts\n' + 'scope '.repeat(100_000);
  addDate('wide-a', 1, wide);
  addDate('wide-b', 2, wide);
  const firstWide = (await read(s, 'owner', { details: true })).groups.dated;
  assert.deepEqual(
    firstWide.rows.map(row => row.selection.itemId),
    ['wide-a'],
  );
  const secondWide = (await read(s, 'owner', { cursor: firstWide.continueCursor })).groups.dated;
  assert.deepEqual(
    secondWide.rows.map(row => row.selection.itemId),
    ['wide-b'],
  );
  assert.equal(secondWide.continueCursor, null);

  // An empty result page still advances across open Issues without date annotations.
  s.tables.projectPlanningRecords.clear();
  for (let n = 1; n <= 25; n++) addDate(`undated-${n}`, n, '- [ ] Inspect receipts');
  addDate('dated', 26, '- [ ] @due 2050-01-01 Inspect receipts');
  const empty = (await read(s, 'owner', { details: true })).groups.dated;
  assert.deepEqual(empty.rows, []);
  const next = (await read(s, 'owner', { cursor: empty.continueCursor })).groups.dated;
  assert.deepEqual(
    next.rows.map(row => row.selection.itemId),
    ['dated'],
  );
});

/** The Loose ends page's data at `scale`: 26 × scale of the reader's projects with no landing, and as many open Issues
 * with a dated Done-when line, over the four-Lane fixture. `ready: false` leaves the Plan search index on its old
 * version, so dated coverage is incomplete. */
async function pageFixture(t, scale, { ready = true } = {}) {
  const { HOSTED_WORK_INDEX_FORMAT } = await import(moduleUrl('../src/work-hosted-summary.ts'));
  const { planningSearchEntries } = await import(moduleUrl('../src/planning-search.ts'));
  const now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const s = fixture(); // Lane times are relative to the mocked clock
  const work = {
    generationId: 'dates',
    backupId: 'backup',
    operationId: 'work',
    initialRevision: 0,
    revision: 1,
  };
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project', _creationTime: now - 60 * day, work }));
  s.tables.projectWorkGenerations.set('dates', {
    _id: 'dates',
    _creationTime: 1,
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    planningSearchVersion: ready ? 2 : 1,
    projectId: 'project',
    backupId: 'backup',
  });
  // Checked, never landed (Item fc1831eb): two Lanes an unrequested check passed on, the stamp on their presence rows.
  for (const [laneId, days, goal] of [
    ['checked-old', 12, 'Passed long ago'],
    ['checked-new', 3, 'Passed last week'],
  ]) {
    s.tables.projectHostedPresence.set(`presence-${laneId}`, {
      _id: `presence-${laneId}`,
      _creationTime: 1,
      projectId: 'project',
      laneId,
      intentId: `intent-${laneId}`,
      actor: 'owner',
      agent: 'quiet-otter',
      goal,
      paths: ['src/a.ts'],
      pathCount: 1,
      at: now - days * day,
      saves: 2,
      passedAt: now - days * day,
    });
    s.tables.projectFinishReadRows.set(`mark-${laneId}`, {
      _id: `mark-${laneId}`,
      _creationTime: 1,
      kind: 'projectLooseChecked',
      sourceId: laneId,
      sourceCreatedAt: now - days * day,
      projectId: 'project',
      value: '{}',
    });
  }
  const n = 26 * scale;
  for (let i = 1; i <= n; i++) {
    const id = `owned-${String(i).padStart(3, '0')}`;
    s.tables.hostedProjects.set(id, projectRow({ _id: id, _creationTime: now - 60 * day }));
    // Open Lanes and size ride on the project's live-line summary (convex/projectLiveLineOpen.ts).
    s.tables.projectFinishReadRows.set(`summary-${id}`, {
      _id: `summary-${id}`,
      _creationTime: i,
      kind: 'projectLiveLineSummary',
      sourceId: id,
      projectId: id,
      value: JSON.stringify({ lanes: 0, size: { bytes: 12_000_000, at: now - day } }),
    });
    s.tables.accountProjectOrder.set(`order-${id}`, {
      _id: `order-${id}`,
      _creationTime: i,
      projectId: id,
      person: 'owner',
      activityHour: i,
    });
    const [entry] = planningSearchEntries(
      {
        id,
        kind: 'issue',
        status: 'open',
        title: `Release ${i}`,
        // The mocked clock is 18 May 2033: line 1 is due later the same year, every fourth one has passed.
        body: `- [ ] @due ${i % 4 ? `2033-06-0${(i % 9) + 1}` : '2033-05-01'} Run the benchmark again`,
        version: 2,
      },
      i,
    );
    s.tables.projectPlanningRecords.set(id, {
      ...entry,
      _id: id,
      _creationTime: i,
      projectId: 'project',
      generationId: 'dates',
    });
  }
  return { s, now };
}

test('fc1831eb page: the details read renders the five groups, dated Item links and leftover projects from their own row shapes', async t => {
  const { s, now } = await pageFixture(t, 1);
  const first = await read(s, 'owner', { details: true });
  const screen = looseEndsScreen(first, {}, first.at);
  assert.deepEqual(
    screen.sections.map(section => section.key),
    ['idle', 'checked', 'stopped', 'intents', 'projects', 'dated'],
    'the approved order, with open Intents offered on request; nothing is held meanwhile in this fixture',
  );
  assert.equal(screen.sections.find(section => section.key === 'intents').unread, true);
  // The CLI and MCP ask for the details read, so that is the read that names the Intent group.
  assert.equal(first.groups.intents.reported, false, 'the read names the Intent group, never a silent gap');
  assert.match(first.groups.intents.why, /"intents":true/);
  const byKey = Object.fromEntries(screen.sections.map(section => [section.key, section]));
  assert.equal(byKey.checked.reported, true, 'checked-never-landed reads the stamp the pass wrote');
  assert.deepEqual(
    byKey.checked.rows.map(row => [row.title, row.evidence, row.age]),
    [
      ['Passed long ago', 'passed its check 12 days ago; landing was never asked for', '12 days'],
      ['Passed last week', 'passed its check 3 days ago; landing was never asked for', '3 days'],
    ],
    'oldest pass first, in the approved words, with how long ago it passed',
  );
  assert.ok(
    byKey.idle.rows.every(row => row.pickable && row.action === 'set-aside'),
    'the owner may set Lanes nobody holds aside',
  );
  assert.ok(
    byKey.stopped.rows.every(row => row.pickable && row.action === 'hand'),
    'a stopped Lane is handed to an agent',
  );
  assert.match(
    byKey.stopped.rows[0].evidence,
    /^1 file now, saves not recorded\. Why it stopped: not reported$/,
  );
  assert.deepEqual(
    byKey.idle.rows.map(row => [row.title, row.age]),
    [
      ['Try streaming decoder', '9 days'],
      ['Fix flaky retry timer', '3 days'],
    ],
  );
  assert.equal(byKey.stopped.rows[0].age, 'not seen for 3 h');
  const dated = byKey.dated.rows[0];
  assert.deepEqual(
    {
      title: dated.title,
      itemId: dated.itemId,
      laneId: dated.laneId,
      age: dated.age,
      evidence: dated.evidence,
    },
    {
      title: 'Run the benchmark again',
      itemId: 'owned-001',
      laneId: null,
      age: 'due 2 June',
      evidence: 'Done-when line 1 on the Item “Release 1”',
    },
    'a dated row is the Done-when line, linked to its Item, never a Lane',
  );
  assert.equal(byKey.dated.rows[3].age, 'was due 1 May', 'a passed date says so');
  const project = byKey.projects.rows[0];
  assert.deepEqual(
    {
      title: project.title,
      mono: project.mono,
      laneId: project.laneId,
      itemId: project.itemId,
      age: project.age,
    },
    { title: 'Synthetic project', mono: true, laneId: null, itemId: null, age: 'never landed' },
  );
  assert.equal(
    project.evidence,
    '12 MB, 0 open Lanes',
    'size and open Lanes come from the stored project row',
  );
  assert.deepEqual(
    [project.action, project.pickable, project.trash],
    ['trash', true, { expectedRevision: 1, expectedLastLanding: null }],
    'the owner moves a leftover project to the trash, pinned to its revision and to the landing it saw (none)',
  );
  assert.ok(
    byKey.dated.rows.every(row => !row.pickable && row.action === 'open'),
    'a dated check only opens its Item',
  );
  assert.ok(byKey.projects.cursor && byKey.dated.cursor, 'more than one page in both account-wide groups');
  assert.equal(byKey.dated.why, null, 'complete dated coverage says nothing extra');
  // One dated line in four has passed: those are the urgent ones.
  assert.match(screen.sentence.bold, /^\d+ or more loose ends, \d+ urgent\.$/);
  assert.doesNotMatch(screen.sentence.rest, /not reported/);
  assert.equal(now, first.at);
});

test('fc1831eb page: a group continues with its own cursor, one read per page; an empty page keeps its cursor and repeats nothing', async t => {
  const { s } = await pageFixture(t, 1);
  let calls = 0;
  const call = async args => (calls++, read(s, 'owner', args));
  const first = await call({ details: true });
  let pages = {};
  let screen = looseEndsScreen(first, pages, first.at);
  const dated = () => screen.sections.find(section => section.key === 'dated');
  const shownBefore = dated().rows.length;
  const reply = await call({ cursor: dated().cursor });
  assert.deepEqual(Object.keys(reply.groups), ['dated'], 'a page reads only the group asked for');
  pages = mergePage(pages, 'dated', reply);
  screen = looseEndsScreen(first, pages, first.at);
  assert.equal(dated().rows.length, shownBefore + reply.groups.dated.rows.length);
  assert.equal(dated().cursor, null, 'the last page clears the cursor');
  const projectsBefore = screen.sections.find(section => section.key === 'projects').cursor;
  assert.ok(projectsBefore, 'paging one group leaves the other group’s cursor alone');
  assert.equal(calls, 2, 'one call at entry and one per requested page');

  // An empty continued page (25 open Issues without a date) keeps the cursor and repeats no row.
  const emptyPage = { at: first.at, groups: { dated: { reported: true, rows: [], continueCursor: 'next' } } };
  const kept = mergePage(pages, 'dated', emptyPage);
  assert.equal(
    looseEndsScreen(first, kept, first.at).sections.find(section => section.key === 'dated').cursor,
    'next',
  );
  const again = mergePage(kept, 'dated', reply);
  assert.equal(
    looseEndsScreen(first, again, first.at).sections.find(section => section.key === 'dated').rows.length,
    dated().rows.length,
    'a page read twice repeats no row',
  );

  // A Lane page merges only its own group; the Lanes it found held meanwhile join Still active.
  const lanePage = {
    at: first.at,
    groups: {
      idle: { reported: true, rows: [], more: false, continueCursor: null },
      stopped: { reported: true, rows: [], more: false, continueCursor: null },
      active: {
        reported: true,
        more: false,
        rows: [{ ...first.groups.idle.rows[0], laneId: 'held', heldBy: 'Landing queue' }],
      },
    },
  };
  const withLanes = mergePage(pages, 'idle', lanePage);
  assert.equal(withLanes.stopped, undefined, 'the stopped cursor is untouched by an idle page');
  assert.deepEqual(
    withLanes.active.rows.map(row => row.laneId),
    ['held'],
  );
});

test('fc1831eb page: incomplete dated coverage is said on the group, not hidden', async t => {
  const { s } = await pageFixture(t, 1, { ready: false });
  const first = await read(s, 'owner', { details: true });
  const dated = looseEndsScreen(first, {}, first.at).sections.find(section => section.key === 'dated');
  assert.equal(dated.reported, true);
  assert.match(dated.why, /may be incomplete/);
});

test('fc1831eb page: a continued Lane the live read now lists elsewhere shows once; held rows form Still active; empty pages claim nothing', () => {
  const at = 2_000_000_000_000;
  const lane = (n, extra = {}) => ({
    laneId: `l${n}`,
    intentId: `i${n}`,
    title: `Lane ${n}`,
    actor: 'sample-one',
    agent: 'quiet-otter',
    paths: 1,
    at: at - n * day,
    ...extra,
  });
  const none = { reported: true, rows: [], continueCursor: null };
  const live = {
    at,
    setAside: { authorityEpoch: 1 },
    groups: {
      idle: { reported: true, rows: [lane(1)], continueCursor: 'idle-p2' },
      stopped: none,
      projects: none,
      dated: none,
      active: { reported: true, rows: [lane(2, { heldBy: 'Landing queue' })] },
    },
  };
  // The next idle page still lists Lane 2 (live now holds it) and Lane 3, which that page found held.
  const pages = mergePage({}, 'idle', {
    at,
    groups: {
      idle: { reported: true, rows: [lane(2), lane(3), lane(4)], continueCursor: null },
      active: { reported: true, rows: [lane(3, { heldBy: 'Landing queue' })] },
    },
  });
  const screen = looseEndsScreen(live, pages, at);
  const keys = key => screen.sections.find(section => section.key === key).rows.map(row => row.laneId);
  assert.deepEqual(keys('idle'), ['l1', 'l4']);
  assert.deepEqual(keys('active'), ['l2', 'l3']);
  // Rows held only on a continued page still show when the live read held none.
  const { active: _, ...quiet } = live.groups;
  assert.deepEqual(
    looseEndsScreen({ ...live, groups: quiet }, pages, at)
      .sections.find(section => section.key === 'active')
      .rows.map(row => row.laneId),
    ['l3'],
  );
  // Nothing shown yet is not "nothing left" while a cursor or a coverage gap remains.
  const empty = {
    at,
    groups: { idle: { ...none, continueCursor: 'idle-p2' }, dated: { ...none, why: 'Still preparing.' } },
  };
  const shown = looseEndsScreen(empty, {}, at);
  assert.equal(shown.total, 0);
  assert.equal(shown.exhausted, false);
  assert.equal(shown.sentence.bold, 'No loose ends shown yet.');
  const ended = looseEndsScreen(empty, mergePage({}, 'idle', { at, groups: { idle: none } }), at);
  assert.equal(ended.exhausted, false, 'dated coverage is still incomplete');
  assert.match(ended.sentence.rest, /not fully read yet/);
});

test('fc1831eb page budget: the details read at current and doubled scale against b294a5d8 and the compact read', async t => {
  const rows = [];
  for (const scale of [1, 2]) {
    const { s } = await pageFixture(t, scale);
    for (const details of [false, true]) {
      const meter = meterReads(s.ctx);
      const heapAtStart = process.memoryUsage().heapUsed;
      const started = performance.now();
      let reply;
      const cost = await meter.cost(async () => {
        reply = await read(s, 'owner', details ? { details: true } : {});
      });
      meter.restore();
      rows.push({
        scale,
        mode: details ? 'details' : 'compact',
        documents: cost.documents,
        bytes: cost.bytes,
        reply: Buffer.byteLength(JSON.stringify(reply)),
        ms: Math.round(performance.now() - started),
        heap: process.memoryUsage().heapUsed - heapAtStart,
      });
    }
  }
  for (const row of rows)
    t.diagnostic(
      `${row.mode} ×${row.scale}: 1 query, ${row.documents} documents, ${row.bytes} fixture B, ${row.reply} reply B, ${row.ms} ms, ${row.heap} sampled heap B`,
    );
  const measured = (scale, mode) => rows.find(row => row.scale === scale && row.mode === mode);
  // b294a5d8's details budget: one query, at most 110 documents for all five groups (84 measured there).
  for (const scale of [1, 2])
    assert.ok(
      measured(scale, 'details').documents <= 110,
      `details ×${scale} within the 110-document budget`,
    );
  assert.equal(
    measured(2, 'details').documents,
    measured(1, 'details').documents,
    'doubling the account does not grow one page',
  );
  assert.equal(measured(2, 'compact').documents, measured(1, 'compact').documents);
});

test('another account cannot read loose ends', async () => {
  const s = fixture();
  await assert.rejects(read(s, 'stranger'), error => error.data?.code === 'PROJECT_UNAVAILABLE');
});

test('5a7d57a3: a 108-minute-old unsaved Lane in the live queue has a holder and no abandon advice', async t => {
  const s = fixture();
  const now = Date.now();
  const presence = s.tables.projectHostedPresence.get('presence-quiet');
  presence.at = now - 108 * 60_000;
  presence.pathCount = 0;
  presence.paths = [];
  s.tables.projectHostedPresence.get('presence-busy').intentId = presence.intentId;
  for (const lane of ['quiet', 'busy'])
    s.tables.projectHostedRecordHeads.set(`head-${lane}`, {
      _id: `head-${lane}`,
      _creationTime: 1,
      projectId: 'project',
      kind: 'lane',
      key: lane,
      parent: presence.intentId,
      status: 'active',
      recordId: `record-${lane}`,
      at: now,
    });
  const transport = { query: (name, args) => read(s, 'owner', args) };
  const reads = meterReads(s.ctx);
  const capture = async () => {
    let result;
    const cost = await reads.cost(async () => {
      ({ result } = await liveLanes(transport, { view: 'loose-ends' }));
    });
    return { result, cost };
  };
  const atRest = await capture();
  assert.ok(atRest.result.groups.stopped.rows[0].next);
  for (const stage of ['queued', 'checking', 'ready']) {
    const mark = {
      _id: 'row-1',
      _creationTime: 1,
      projectId: 'project',
      sourceId: 'row-2',
      laneId: 'quiet',
      stage,
      changedAt: now,
      held: false,
      overlap: false,
      ...(stage === 'checking' ? { check: '12345678' } : {}),
    };
    s.tables.projectLiveLineLanes.set(mark._id, mark);
    const { result, cost } = await capture();
    assert.deepEqual(result.groups.stopped.rows, []);
    const [held] = result.groups.active.rows;
    assert.equal(held.laneId, 'quiet');
    assert.equal(held.heldBy, 'Landing queue');
    assert.equal(held.next, undefined);
    assert.equal(held.replacedBy, undefined);
    const view = looseEndsView(result, now);
    assert.equal(view.groups.find(group => group.key === 'active').rows[0].heldBy, 'Landing queue');
    assert.equal(cost.documents - atRest.cost.documents, 1);
    const bytes = cost.bytes - atRest.cost.bytes;
    assert.ok(bytes > 0 && bytes <= 320);
    t.diagnostic(`${stage}: 1 additional mark document, ${bytes} fixture B`);
  }
  reads.restore();
});

test('77d2e8bc: local CLI names a heavy slot, a running agent and recent activity in place of abandon advice', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-loose-holders-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.mock.method(Date, 'now', () => 10_000_000);
  const before = Date.now() - 108 * 60_000;
  const candidates = ['heavy', 'running', 'recent', 'quiet'].map((name, i) => ({
    laneId: `d0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name,
    at: before,
    replacedBy: 'sibling',
    next: 'abandon advice',
  }));
  const settings = join(directory, 'settings.json');
  const settingsEnv = {
    XDG_STATE_HOME: directory,
    FORGE_HEAVY_DIR: directory,
    FORGE_CLIENT_SETTINGS: settings,
  };
  const saved = Object.fromEntries(Object.keys(settingsEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, settingsEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 1 }));
  const laneDir = join(directory, 'lanes');
  mkdirSync(laneDir);
  const address = { url: 'https://forge.test', projectId: 'project' };
  const oldRoot = join(laneDir, candidates[3].laneId);
  mkdirSync(join(oldRoot, '.forge'), { recursive: true });
  const nested = join(oldRoot, 'tests');
  mkdirSync(nested);
  writeFileSync(
    join(oldRoot, '.forge', 'hosted-lane.json'),
    JSON.stringify({
      url: address.url,
      selection: { projectId: address.projectId, laneId: candidates[0].laneId },
    }),
  );
  const slot = tryHeavySlot(directory, 1);
  assert.ok(slot);
  writeFileSync(
    join(slot, 'holder.json'),
    JSON.stringify({
      cwd: nested,
      startedAt: before,
      command: 'preflight',
      maxMs: 0,
    }),
  );
  for (const candidate of candidates.slice(1))
    recordLane({
      laneId: candidate.laneId,
      root: join(laneDir, candidate.laneId),
      ...address,
      agent: 'calm-egret',
      ...(candidate.name === 'running'
        ? { running: { action: 'preflight', pid: process.pid, since: before } }
        : {}),
      lastActionAt: candidate.name === 'recent' ? Date.now() - 30 * 60_000 : before,
    });
  const stopped = { reported: true, rows: candidates, more: true, continueCursor: 'next-page' };
  const command = { view: 'loose-ends' };
  const transport = {
    query: async () => ({ groups: { stopped } }),
    dispatch: (_action, input) => liveLanes(transport, input),
  };
  const checkout = join(directory, 'cli-checkout');
  mkdirSync(checkout);
  const hosted = await hostedAgentCli(checkout, 'lanes', command, address, transport);
  assert.deepEqual(hosted.result.groups, { stopped }, 'MCP dispatch sees hosted evidence only');
  const { result } = await hostedAgentCli(checkout, 'lanes', command, address, transport, undefined, true);
  assert.deepEqual(result.groups.stopped.rows, [candidates[3]]);
  assert.equal(result.groups.stopped.continueCursor, stopped.continueCursor);
  assert.deepEqual(
    result.groups.active.rows.map(row => [row.name, row.heldBy]),
    [
      ['heavy', 'Local heavy slot 1 (preflight)'],
      ['running', '@calm-egret (running a local command)'],
      ['recent', '@calm-egret (recent activity)'],
    ],
  );
  assert.ok(result.groups.active.rows.every(row => !row.next && !row.replacedBy));
});

test('queue evidence reads only the 25 displayed candidates and keeps the cursor even if every candidate is active', async t => {
  const s = fixture();
  const presence = s.tables.projectHostedPresence;
  const first = presence.get('presence-quiet');
  const marks = [];
  for (let n = 0; n < 26; n++) {
    const laneId = `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    if (n === 0) presence.delete(first._id);
    presence.set(`presence-${n}`, {
      ...first,
      _id: `presence-${n}`,
      _creationTime: n,
      laneId,
      intentId: `intent-${n}`,
    });
    marks.push({
      _id: `row-${n}`,
      _creationTime: n,
      projectId: 'project',
      laneId,
      sourceId: `row-${n + 100}`,
      stage: 'checking',
      check: '12345678',
      changedAt: first.at,
      held: false,
      overlap: false,
    });
  }
  const reads = meterReads(s.ctx);
  const costBefore = await reads.cost(() => read(s, 'owner'));
  for (const mark of marks) s.tables.projectLiveLineLanes.set(mark._id, mark);
  let result;
  const costAfter = await reads.cost(async () => {
    result = await read(s, 'owner');
  });
  assert.deepEqual(result.groups.stopped.rows, []);
  assert.equal(result.groups.active.rows.length, 25);
  const extraDocuments = costAfter.documents - costBefore.documents;
  const extraBytes = costAfter.bytes - costBefore.bytes;
  assert.equal(extraDocuments, 25);
  assert.ok(extraBytes <= 25 * 320);
  t.diagnostic(`full stopped page: +${extraDocuments} documents, +${extraBytes} fixture B`);
  const next = await read(s, 'owner', { cursor: result.groups.stopped.continueCursor });
  assert.deepEqual(
    next.groups.active.rows.map(row => row.laneId),
    [marks.at(-1).laneId],
  );
  assert.equal(next.groups.stopped.continueCursor, null);
  reads.restore();
});

test('77d2e8bc: a CLI tidy pass reaches every stopped Lane once across timestamp ties and a removed boundary', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const s = fixture();
  const presence = s.tables.projectHostedPresence;
  const first = presence.get('presence-quiet');
  const expected = [first.laneId];
  for (let n = 2; n <= 55; n++) {
    const laneId = `quiet-${String(n).padStart(2, '0')}`;
    expected.push(laneId);
    presence.set(`presence-${laneId}`, {
      ...first,
      _id: `presence-${laneId}`,
      _creationTime: Math.ceil(n / 4),
      at: n > 50 ? first.at + 10 : first.at,
      laneId,
      intentId: `intent-${laneId}`,
    });
  }
  const reads = meterReads(s.ctx);
  let calls = 0;
  const transport = {
    query: async (name, args) => {
      assert.equal(name, 'projectLooseEnds:read');
      calls++;
      return read(s, 'owner', args);
    },
  };
  const seen = [];
  let cursor;
  for (const pageSize of [25, 25, 5]) {
    let result;
    const cost = await reads.cost(async () => {
      ({ result } = await liveLanes(transport, { view: 'loose-ends', ...(cursor ? { cursor } : {}) }));
    });
    if (cursor) assert.deepEqual(Object.keys(result.groups), ['stopped']);
    else assert.equal(result.groups.idle.rows.length, 2);
    const { rows, more, continueCursor } = result.groups.stopped;
    assert.equal(rows.length, pageSize);
    assert.equal(more, pageSize === 25);
    assert.equal(Boolean(continueCursor), more);
    const lookahead = more ? 1 : 0;
    assert.ok(
      cost.documents <= pageSize + lookahead + (cursor ? 1 : 3),
      `bounded page: ${cost.documents} documents`,
    );
    t.diagnostic(`stopped page: ${rows.length} rows, ${cost.documents} documents, ${cost.bytes} fixture B`);
    seen.push(...rows.map(row => row.laneId));
    if (!cursor) {
      presence.delete(`presence-${rows.at(-1).laneId}`);
      // The existing rows would age out of stopped if the time range were recomputed.
      now += 2 * day;
      presence.get('presence-busy').at = now - 3 * 60 * 60 * 1000;
      await assert.rejects(
        read(s, 'stranger', { cursor: continueCursor }),
        error => error.data?.code === 'PROJECT_UNAVAILABLE',
      );
    }
    cursor = continueCursor;
  }
  reads.restore();
  assert.equal(cursor, null);
  assert.equal(calls, 3, 'one hosted call per requested page');
  assert.deepEqual(seen, expected);
});

test('a malformed stopped cursor explains how to restart the tidy pass', async () => {
  await assert.rejects(
    read(fixture(), 'owner', { cursor: 'forge-loose-ends-stopped-v1:{' }),
    error => error.data?.code === 'BAD_ARGUMENT' && /continueCursor/.test(error.data.message),
  );
});

test('a Lane that changed meanwhile is skipped and named; only a failed call is retried', () => {
  assert.equal(setAsideWord('abandoned').done, true);
  assert.equal(setAsideWord('not-dormant').word, 'Skipped: it was saved meanwhile');
  assert.equal(setAsideWord('has-saved-work').retry, false);
  assert.equal(setAsideWord('failed').retry, true);
});

test('d9e1ac62: a quiet Lane whose Item has a live Lane says what replaced it and how its agent abandons it', async () => {
  const s = fixture();
  const now = Date.now();
  // 'quiet' and 'busy' are two open Lanes of one Item; 'busy' saved five minutes ago.
  s.tables.projectHostedPresence.get('presence-busy').intentId = 'intent-quiet';
  for (const laneId of ['quiet', 'busy', 'dormant'])
    s.tables.projectHostedRecordHeads.set(`head-${laneId}`, {
      _id: `head-${laneId}`,
      _creationTime: laneId === 'busy' ? 3 : 2,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: `intent-${laneId === 'busy' ? 'quiet' : laneId}`,
      status: 'active',
      recordId: `record-${laneId}`,
      at: now,
    });
  const result = await read(s, 'owner');
  const [quiet] = result.groups.stopped.rows;
  assert.equal(quiet.replacedBy, 'busy');
  assert.equal(quiet.next, 'nforge agent ROOT abandon {"laneId":"quiet","reason":"Replaced by Lane busy"}');
  // A Lane alone on its Item is never called replaced.
  assert.equal(result.groups.idle.rows.find(row => row.laneId === 'dormant').replacedBy, undefined);
});

test('d9e1ac62 (real case, Item 1dd4e095): a quiet Lane whose quiet resolution Lane is listed reads replaced by it', async () => {
  const s = fixture();
  const now = Date.now();
  // 'dormant' conflicted and 'quiet' is its resolution Lane; both are quiet, so the live-Lane rule names nobody.
  s.tables.projectHostedPresence.get('presence-quiet').intentId = 'intent-dormant';
  // The origin is read from the Lane record the head points at (Item 77d2e8bc), never from the overlap row.
  for (const laneId of ['quiet', 'dormant']) {
    s.tables.projectHostedRecordHeads.set(`head-${laneId}`, {
      _id: `head-${laneId}`,
      _creationTime: 2,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: 'intent-dormant',
      status: 'active',
      recordId: `record-${laneId}`,
      at: now,
    });
    const inline = laneRecord(laneId, laneId === 'quiet' ? 'dormant' : null);
    s.tables.projectHostedRecords.set(`record-${laneId}`, {
      _id: `record-${laneId}`,
      _creationTime: 2,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: 'intent-dormant',
      status: 'active',
      version: 3,
      inline,
      bodyId: `body-${laneId}`,
      digest: digest(inline),
      bytes: new TextEncoder().encode(inline).length,
    });
  }
  // What the read used to open per listed quiet Lane: the overlap row, whose `changes` grow with the Lane's edits
  // (dogfood shape: 30 changed paths with their line ranges).
  const overlap = {
    _id: 'overlap-quiet',
    _creationTime: 1,
    projectId: 'project',
    laneId: 'quiet',
    resolutionOrigin: 'somewhere-else',
    changes: JSON.stringify(
      Array.from({ length: 30 }, (_, n) => ({
        path: `web/src/app/synthetic/area-${n}/module.tsx`.padEnd(60, 'y'),
        lines: Array.from({ length: 6 }, (_, k) => [k * 40 + 1, k * 40 + 12]),
      })),
    ),
  };
  s.tables.projectHostedOverlapLanes.set('overlap-quiet', overlap);
  const query = s.ctx.db.query.bind(s.ctx.db);
  s.ctx.db.query = table => {
    assert.notEqual(table, 'projectHostedOverlapLanes', 'no overlap row is read');
    return query(table);
  };
  const meter = meterReads(s.ctx);
  let result;
  const cost = await meter.cost(async () => {
    result = await read(s, 'owner');
  });
  meter.restore();
  const origin = result.groups.idle.rows.find(row => row.laneId === 'dormant');
  assert.equal(origin.replacedBy, 'quiet');
  assert.equal(
    origin.next,
    'nforge agent ROOT abandon {"laneId":"dormant","reason":"Replaced by Lane quiet"}',
  );
  assert.equal(result.groups.stopped.rows[0].replacedBy, undefined, 'the resolution Lane is not replaced');
  const record = JSON.stringify(s.tables.projectHostedRecords.get('record-quiet')).length;
  const before = JSON.stringify(overlap).length;
  assert.ok(
    record < before / 3,
    `a Lane record (${record} B) is far smaller than an overlap row (${before} B)`,
  );
  console.log(
    `loose-ends origin: ${record} B Lane record vs ${before} B overlap row per listed quiet Lane; read ${cost.documents} documents, ${cost.bytes} B`,
  );

  // The stopped page keeps its 26th row for replacement advice, even though it displays only 25.
  const presence = s.tables.projectHostedPresence;
  const resolution = presence.get('presence-quiet');
  for (let n = 0; n < 25; n++) {
    const laneId = `earlier-${n}`;
    presence.set(`presence-${laneId}`, {
      ...resolution,
      _id: `presence-${laneId}`,
      at: resolution.at - 1,
      laneId,
      intentId: laneId,
    });
  }
  const firstPage = await read(s, 'owner');
  assert.equal(firstPage.groups.idle.rows.find(row => row.laneId === 'dormant').replacedBy, 'quiet');
  assert.equal(firstPage.groups.stopped.rows.length, 25);
  assert.ok(firstPage.groups.stopped.continueCursor);

  presence.delete('presence-earlier-0');
  const exactPage = (await read(s, 'owner')).groups.stopped;
  assert.equal(exactPage.rows.length, 25);
  assert.equal(exactPage.more, false);
  assert.equal(exactPage.continueCursor, null);
});

test('an Item with one listed quiet Lane reads no Lane record: a resolution needs both Lanes listed', async () => {
  const s = fixture();
  s.tables.projectHostedPresence.get('presence-busy').intentId = 'intent-quiet';
  s.tables.projectHostedPresence.get('presence-busy').at = Date.now() - 5 * 60 * 1000;
  for (const laneId of ['quiet', 'busy'])
    s.tables.projectHostedRecordHeads.set(`head-${laneId}`, {
      _id: `head-${laneId}`,
      _creationTime: laneId === 'busy' ? 3 : 2,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: 'intent-quiet',
      status: 'active',
      recordId: `record-${laneId}`,
      at: Date.now(),
    });
  const get = s.ctx.db.get.bind(s.ctx.db);
  const opened = [];
  s.ctx.db.get = async id => (opened.push(id), get(id));
  const result = await read(s, 'owner');
  assert.equal(result.groups.stopped.rows[0].replacedBy, 'busy');
  assert.deepEqual(
    opened.filter(id => String(id).startsWith('record-')),
    [],
  );
});

const actions = await import(moduleUrl('../web/src/app/needs/loose-actions.ts'));
const { handText, trashWord } = await import(moduleUrl('../web/src/app/needs/loose-ends.ts'));
const { ConvexError } = await import('convex/values');
const lid = n => `5d1c7a0e-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('fc1831eb set aside: a Lane saved meanwhile is skipped and named, a failed batch alone retries, Undo pins the version', async () => {
  const sent = [];
  let failNext = false;
  const sweep = async args => {
    sent.push(args);
    if (failNext) {
      failNext = false;
      throw new Error('Synthetic network failure');
    }
    return JSON.stringify({
      results: [
        ...args.abandon.map((laneId, i) =>
          i === 1 ? { laneId, result: 'not-dormant' } : { laneId, result: 'abandoned', version: 7 },
        ),
        ...(args.reopen ?? []).map(pin =>
          pin.version === 7
            ? { laneId: pin.laneId, result: 'reopened', version: 8 }
            : { laneId: pin.laneId, result: 'changed' },
        ),
      ],
    });
  };
  // 27 Lanes: two calls of at most 25; the second fails as a whole.
  const ids = Array.from({ length: 27 }, (_, i) => lid(i + 1));
  const first = await actions.setAsideLanes(
    async args => {
      if (args.abandon.length === 2) failNext = true;
      return sweep(args);
    },
    4,
    ids,
  );
  assert.deepEqual(
    sent.map(args => args.abandon.length),
    [25, 2],
  );
  assert.ok(sent.every(args => args.versions === true && args.authorityEpoch === 4));
  assert.equal(first.results[lid(2)], 'not-dormant', 'saved meanwhile: skipped, not set aside');
  assert.equal(setAsideWord(first.results[lid(2)]).word, 'Skipped: it was saved meanwhile');
  assert.deepEqual([first.results[lid(26)], first.results[lid(27)]], ['failed', 'failed']);
  assert.equal(first.versions[lid(1)], 7);
  // Retry carries only the failed Lanes.
  const failed = ids.filter(id => first.results[id] === 'failed');
  sent.length = 0;
  const retry = await actions.setAsideLanes(sweep, 4, failed);
  assert.deepEqual(
    sent.map(args => args.abandon),
    [[lid(26), lid(27)]],
  );
  assert.equal(retry.results[lid(26)], 'abandoned');
  // Undo sends the pins it was given; one changed since stays set aside.
  sent.length = 0;
  const back = await actions.bringBackLanes(sweep, 4, [
    { laneId: lid(1), version: 7 },
    { laneId: lid(3), version: 6 },
  ]);
  assert.deepEqual(sent, [
    {
      authorityEpoch: 4,
      abandon: [],
      reopen: [
        { laneId: lid(1), version: 7 },
        { laneId: lid(3), version: 6 },
      ],
      versions: true,
    },
  ]);
  assert.deepEqual(back, { [lid(1)]: 'reopened', [lid(3)]: 'changed' });
  assert.equal(setAsideWord('changed').word, 'Skipped: it changed meanwhile');
});

test('fc1831eb trash: one owner call per project; a changed project is skipped, a failure keeps its operation for retry; Undo restores at the next revision', async () => {
  const calls = [];
  const stale = () => new ConvexError({ code: 'WORK_STALE', message: 'Project changed.' });
  const trash = async pin => {
    calls.push(['trash', pin]);
    if (pin.projectId === 'p2') throw stale();
    if (pin.projectId === 'p3') throw new Error('Synthetic network failure');
    // p4 was already moved by another tab: the pinned trash answers that this operation did not move it.
    return { applied: pin.projectId !== 'p4' };
  };
  const pins = ['p1', 'p2', 'p3', 'p4'].map((projectId, i) => ({
    projectId,
    operationId: `op-${projectId}`,
    expectedRevision: 10 + i,
  }));
  const results = await actions.trashProjects(trash, pins);
  assert.deepEqual(results, { p1: 'trashed', p2: 'changed', p3: 'failed', p4: 'changed' });
  assert.deepEqual(
    [trashWord('changed').word, trashWord('failed').retry, trashWord('trashed').done],
    ['Skipped: it changed meanwhile', true, true],
  );
  const restore = async pin => {
    calls.push(['restore', pin]);
    if (pin.expectedRevision !== 11) throw stale();
    return null;
  };
  const back = await actions.restoreProjects(restore, [
    { projectId: 'p1', operationId: 'undo-p1', expectedRevision: 11 },
  ]);
  assert.deepEqual(back, { p1: 'restored' });
  assert.equal(calls.length, 5, 'one call per project per action, nothing else');
});

test('fc1831eb hand to an agent: one prompt for every picked Lane through the existing explicit takeover', () => {
  const project = { name: 'tidepool', projectId: 'proj-1', backend: 'https://example.convex.cloud' };
  const text = handText(
    [
      { laneId: lid(1), title: 'Fix flaky\n retry timer' },
      { laneId: lid(4), title: 'Docs: migration guide v3' },
    ],
    project,
  );
  assert.match(
    text,
    /^Take over these 2 Lanes of the Forge project "tidepool" \(project ID proj-1\) from Loose ends/,
  );
  assert.match(
    text,
    /an existing checkout of that project \(ROOT below\), or make one with nforge clone proj-1 NEW_DIRECTORY --deployment https:\/\/example\.convex\.cloud\./,
    'an agent opened anywhere finds or makes the checkout',
  );
  assert.match(
    text,
    /nforge agent ROOT start --open '\{"laneId":"LANE_ID","takeover":true,"reason":"Handed over from Loose ends"\}'/,
  );
  assert.match(
    text,
    /\n- Fix flaky retry timer \(5d1c7a0e-0000-4000-8000-000000000001\)\n- Docs: migration guide v3 \(/,
  );
  assert.match(
    handText([{ laneId: lid(1), title: 'x' }], project),
    /^Take over this Lane of the Forge project "tidepool" \(project ID proj-1\) from Loose ends and finish it\./,
  );
});
