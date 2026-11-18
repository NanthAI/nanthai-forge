// SPDX-License-Identifier: Apache-2.0
// A person's contributions (Item 6a251b23): the day close counts landings (and those by agent runs, with the model
// the run declared), Lanes and reviews per person; a repeated close writes the same row; the profile reads at most 366
// rows and sends only the projects the viewer may open: owner (everything), teammate (public plus shared private),
// reader of a shared project, public and signed-out viewers (public only). A removed project is never sent.
// Items closed and comments come from the day's Work change rows; Latest reads only projects the viewer may open, and a
// visitor gets landings only (never a Lane title or a comment).
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const days = await import(moduleUrl('../src/person-days.ts'));
const { readProfile, recordPersonDays } = await import(moduleUrl('../convex/personDays.ts'));
const { landingContributions } = await import(moduleUrl('../convex/projectStats.ts'));
const {
  planningContributions,
  planningPartialDays,
  PERSON_WORK_BYTES,
  PERSON_WORK_CHANGES,
  PERSON_WORK_COMMANDS,
} = await import(moduleUrl('../convex/personWork.ts'));
const { HOSTED_WORK_INDEX_FORMAT } = await import(moduleUrl('../src/work-hosted-summary.ts'));

/** Just enough of ctx.db for these reads: index ranges (eq, gte, lt, lte), order, take, unique, get, insert, patch. */
function fakeDb(tables) {
  let next = 0;
  const reads = { documents: 0 };
  const query = table => {
    let rows = [...(tables[table] ??= [])];
    let dir = 'asc';
    const api = {
      withIndex: (_name, range) => {
        const tests = [];
        const q = {
          eq: (field, value) => (tests.push(row => row[field] === value), q),
          gte: (field, value) => (tests.push(row => row[field] >= value), q),
          lt: (field, value) => (tests.push(row => row[field] < value), q),
          lte: (field, value) => (tests.push(row => row[field] <= value), q),
        };
        range?.(q);
        rows = rows.filter(row => tests.every(test => test(row)));
        return api;
      },
      order: d => ((dir = d), api),
      take: n => {
        const key = row => row.day ?? row.at ?? row._creationTime ?? 0;
        const sorted = [...rows].sort((a, b) =>
          typeof key(a) === 'string' ? key(a).localeCompare(key(b)) : key(a) - key(b),
        );
        const out = (dir === 'desc' ? sorted.reverse() : sorted).slice(0, n);
        reads.documents += out.length;
        return Promise.resolve(out);
      },
      unique: () => {
        reads.documents += rows.length ? 1 : 0;
        return Promise.resolve(rows[0] ?? null);
      },
      first: async () => (await api.take(1))[0] ?? null,
    };
    return api;
  };
  const all = () => Object.values(tables).flat();
  return {
    reads,
    db: {
      query,
      normalizeId: (_table, id) => (all().some(row => row._id === id) ? id : null),
      get: async id => all().find(row => row._id === id) ?? null,
      insert: async (table, value) => {
        (tables[table] ??= []).push({ _id: `n${next++}`, ...value });
      },
      patch: async (id, value) =>
        Object.assign(
          all().find(row => row._id === id),
          value,
        ),
    },
  };
}

const at = (day, hour = 9) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);

test('the close counts each landing for its submitter, agent runs with their declared model, and reviews', () => {
  const base = { actor: { id: 'acct-a', kind: 'agent' }, at: '2026-11-16T09:00:00.000Z' };
  const withModel = landingContributions(
    { ...base, agentRun: 'amber-fox', agentClient: 'claude-code:sample-model-1' },
    { acceptance: { acceptedBy: { kind: 'person', actor: 'acct-a', at: base.at, note: 'n' } } },
  );
  assert.deepEqual(withModel, [
    { kind: 'landing', person: 'acct-a', at: at('2026-11-16'), run: 'amber-fox', model: 'sample-model-1' },
    { kind: 'review', person: 'acct-a', at: at('2026-11-16') },
  ]);
  // No model declared: the run is still counted, with no model.
  assert.deepEqual(landingContributions({ ...base, agentRun: 'copper-moth', agentClient: 'codex' }, null), [
    { kind: 'landing', person: 'acct-a', at: at('2026-11-16'), run: 'copper-moth' },
  ]);
  // A person landing their own change by hand is not a review; a system actor counts for no one.
  const byHand = { ...base, actor: { id: 'acct-b', kind: 'person' } };
  const own = { acceptance: { acceptedBy: { kind: 'person', actor: 'acct-b', at: base.at, note: 'n' } } };
  assert.deepEqual(landingContributions(byHand, own), [
    { kind: 'landing', person: 'acct-b', at: at('2026-11-16') },
  ]);
  assert.deepEqual(landingContributions({ ...base, actor: { id: 'system:queue', kind: 'agent' } }, null), []);
});

test('a project-day entry sums per person, keeps the busiest runs, and a repeated close writes the same row', async () => {
  const { db } = fakeDb({});
  const contributions = [
    { kind: 'landing', person: 'acct-a', at: at('2026-11-16', 9), run: 'amber-fox', model: 'sample-model-1' },
    { kind: 'landing', person: 'acct-a', at: at('2026-11-16', 11) },
    { kind: 'lane', person: 'acct-a', at: at('2026-11-16', 8), run: 'amber-fox' },
    { kind: 'review', person: 'acct-b', at: at('2026-11-16', 12) },
  ];
  await recordPersonDays({ db }, 'p1', '2026-11-16', contributions);
  await recordPersonDays({ db }, 'p1', '2026-11-16', contributions);
  await recordPersonDays({ db }, 'p2', '2026-11-16', [contributions[1]]);
  const rows = (await db.query('personDays').withIndex('by_person_and_day').take(10)).map(row => ({
    person: row.person,
    value: JSON.parse(row.value),
  }));
  assert.equal(rows.length, 2, 'one row per person per day, however many projects and closes');
  const a = rows.find(row => row.person === 'acct-a').value;
  assert.deepEqual(a.p.p1, {
    l: 2,
    la: 1,
    n: 1,
    na: 1,
    v: 0,
    t: [at('2026-11-16', 8), at('2026-11-16', 11)],
    r: { 'amber-fox': [1, 1, 'sample-model-1'] },
  });
  assert.equal(a.p.p2.l, 1);
  const many = Array.from({ length: days.PERSON_DAY_RUNS + 5 }, (_, i) => ({
    kind: 'lane',
    person: 'acct-c',
    at: at('2026-11-16'),
    run: `run-${i}`,
  }));
  const entry = days.projectDays(many).get('acct-c');
  assert.equal(Object.keys(entry.r).length, days.PERSON_DAY_RUNS);
  assert.equal(entry.rm, 5, 'runs past the cap are counted, not dropped silently');
  assert.equal(entry.n, many.length);
});

/** Three projects: public, private with the teammate in it, private without; plus one removed. */
function world() {
  const day = (d, p) => ({ person: 'acct-a', day: d, value: JSON.stringify({ p }) });
  const entry = (l, run, c) => ({
    l,
    la: run ? l : 0,
    n: 1,
    na: 0,
    v: 1,
    t: [at('2026-11-10'), at('2026-11-10', 18)],
    r: run ? { [run]: [1, l, 'sample-model-1'] } : {},
    ...(c ? { c } : {}),
  });
  // Latest's sources: a receipt, an open Lane and a planning comment in each project.
  const receipt = (projectId, message, hour) => ({
    projectId,
    _creationTime: at('2026-11-12', hour),
    value: JSON.stringify({
      id: `r-${projectId}`,
      at: new Date(at('2026-11-12', hour)).toISOString(),
      actor: { id: 'acct-a', kind: 'agent' },
      agentRun: 'amber-fox',
      agentClient: 'claude-code:sample-model-1',
      message,
    }),
  });
  const lane = (projectId, goal, hour) => ({
    projectId,
    laneId: `l-${projectId}`,
    actor: 'acct-a',
    agent: 'amber-fox',
    goal,
    at: at('2026-11-12', hour),
  });
  const comment = (projectId, text, hour) => ({
    projectId,
    actor: 'acct-a',
    operationId: `work:o-${projectId}`,
    at: at('2026-11-12', hour),
    _creationTime: at('2026-11-12', hour),
    command: { kind: 'change', source: 'work', action: 'comment-planning-item' },
    kind: 'change',
  });
  const command = (projectId, text) => ({
    projectId,
    operationId: `o-${projectId}`,
    command: JSON.stringify({
      action: 'comment-planning-item',
      itemId: `i-${projectId}`,
      text,
      agent: 'amber-fox',
    }),
  });
  return {
    hostedProjects: [
      { _id: 'pub', owner: 'acct-a', slug: 'open-one', visibility: 'public' },
      { _id: 'shared', owner: 'acct-a', slug: 'team-one', visibility: 'private' },
      { _id: 'mine', owner: 'acct-a', slug: 'quiet-one', visibility: 'private' },
      { _id: 'gone', owner: 'acct-a', slug: 'gone-one', visibility: 'public', removal: { at: 1 } },
    ],
    projectContributors: [{ projectId: 'shared', contributor: 'acct-mate' }],
    projectReaders: [{ projectId: 'shared', reader: 'acct-reader' }],
    forgeAccounts: [{ owner: 'acct-a', handle: 'sample-one' }],
    personDays: [
      day('2026-11-09', { pub: entry(2, 'amber-fox', 1) }),
      day('2026-11-10', {
        shared: entry(3, 'tawny-newt', 4),
        mine: entry(5, 'moss-pike', 2),
        gone: entry(7, undefined, 8),
      }),
      day('2026-11-11', { mine: entry(4) }),
    ],
    projectHostedAcceptances: [
      receipt('pub', 'Public landing', 9),
      receipt('shared', 'Team landing', 10),
      receipt('mine', 'Secret landing', 11),
    ],
    projectHostedPresence: [
      lane('pub', 'Public lane goal', 9),
      lane('shared', 'Team lane goal', 10),
      lane('mine', 'Secret lane goal', 11),
    ],
    projectCoordinationEvents: [
      comment('pub', 'Public comment', 9),
      comment('shared', 'Team comment', 10),
      comment('mine', 'Secret comment', 11),
    ],
    projectWorkEvents: [
      command('pub', 'Public comment'),
      command('shared', 'Team comment'),
      command('mine', 'Secret comment'),
    ],
  };
}
const view = async viewer => {
  const { db, reads } = fakeDb(world());
  const read = await readProfile({ db }, { owner: 'acct-a', handle: 'sample-one', viewer, agentsFrom: 0 });
  return { read, reads };
};

test('signed out and public viewers get public projects only; nothing private is hinted at', async () => {
  for (const viewer of [null, 'acct-stranger']) {
    const { read } = await view(viewer);
    assert.equal(read.scope, 'public');
    assert.deepEqual(read.totals, {
      landings: 2,
      lanes: 1,
      reviews: 1,
      landingsByAgents: 2,
      lanesByAgents: 0,
      itemsClosed: 1,
    });
    assert.deepEqual(
      read.days.map(d => d[0]),
      ['2026-11-09'],
    );
    assert.equal(read.through, '2026-11-09', 'the newest day is the newest in scope');
    assert.deepEqual(
      read.projects.map(p => p.slug),
      ['open-one'],
    );
    assert.deepEqual(
      read.agents.rows.map(a => a.run),
      ['amber-fox'],
    );
    assert.equal(read.projectsLeftOut, 0);
    assert.deepEqual(
      read.latest.map(row => [row.kind, row.title, row.project.slug]),
      [['landed', 'Public landing', 'open-one']],
      'a visitor gets landings only: never a Lane title or a comment, even on a public project',
    );
    assert.doesNotMatch(
      JSON.stringify(read),
      /team-one|quiet-one|gone-one|tawny|moss|Team |Secret|lane goal|comment"/,
    );
  }
});

test('a teammate and a reader of a shared private project also see that project, never the others', async () => {
  for (const viewer of ['acct-mate', 'acct-reader']) {
    const { read } = await view(viewer);
    assert.equal(read.scope, 'shared');
    assert.deepEqual(
      read.projects.map(p => [p.slug, p.visibility, p.shared]),
      [
        ['team-one', 'private', true],
        ['open-one', 'public', false],
      ],
    );
    assert.equal(read.totals.landings, 5);
    assert.equal(read.totals.itemsClosed, 5, 'Items closed in the public and the shared project');
    assert.deepEqual(
      read.projects.map(p => [p.slug, p.closed]),
      [
        ['team-one', 4],
        ['open-one', 1],
      ],
    );
    // A writer also sees the person's open Lanes and comments in the shared project; a reader gets landings only,
    // as presence and the agent page give readers nothing of them (review 59bca412 MUST-1).
    assert.deepEqual(
      read.latest.map(row => [row.kind, row.title]),
      viewer === 'acct-mate'
        ? [
            ['landed', 'Team landing'],
            ['lane', 'Team lane goal'],
            ['comment', 'Team comment'],
            ['landed', 'Public landing'],
          ]
        : [
            ['landed', 'Team landing'],
            ['landed', 'Public landing'],
          ],
      'the public project gives landings only',
    );
    assert.doesNotMatch(
      JSON.stringify(read),
      viewer === 'acct-mate'
        ? /quiet-one|gone-one|moss-pike|Secret|Public lane goal|Public comment/
        : /quiet-one|gone-one|moss-pike|Secret|lane goal|Team comment|Public comment/,
    );
  }
});

test('the person themself sees every project they worked on, but never a removed one', async () => {
  const { read, reads } = await view('acct-a');
  assert.equal(read.self, true);
  assert.equal(read.scope, 'all');
  assert.equal(read.totals.landings, 14);
  assert.equal(read.totals.itemsClosed, 7, 'every project but the removed one');
  assert.deepEqual(
    read.days.map(d => d[5]),
    [1, 6, 0],
    'Items closed per day',
  );
  assert.deepEqual(
    read.latest.map(row => [row.kind, row.title, row.run, row.model]),
    [
      ['landed', 'Secret landing', 'amber-fox', 'sample-model-1'],
      ['lane', 'Secret lane goal', 'amber-fox', null],
      ['comment', 'Secret comment', 'amber-fox', ''],
      ['landed', 'Team landing', 'amber-fox', 'sample-model-1'],
    ],
    'the newest two projects, newest first, at most four rows',
  );
  assert.deepEqual(
    read.days.map(d => d[0]),
    ['2026-11-09', '2026-11-10', '2026-11-11'],
  );
  assert.deepEqual(read.agents.rows.map(a => [a.run, a.model, a.project.slug]).sort(), [
    ['amber-fox', 'sample-model-1', 'open-one'],
    ['moss-pike', 'sample-model-1', 'quiet-one'],
    ['tawny-newt', 'sample-model-1', 'team-one'],
  ]);
  assert.doesNotMatch(JSON.stringify(read), /gone-one/);
  // Rows, projects and one account, plus Latest: two projects of (receipt, Lane, change and one command).
  assert(reads.documents <= 3 + 4 + 1 + 2 * 4, `bounded reads: ${reads.documents}`);
});

test('the profile reads at most a year of active days, however long the history', async () => {
  const w = world();
  w.personDays = Array.from({ length: 500 }, (_, i) => ({
    person: 'acct-a',
    day: new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10),
    value: JSON.stringify({ p: { pub: { l: 1, la: 0, n: 0, na: 0, v: 0, t: [i, i], r: {} } } }),
  }));
  const { db } = fakeDb(w);
  const read = await readProfile(
    { db },
    { owner: 'acct-a', handle: 'sample-one', viewer: null, agentsFrom: 0 },
  );
  assert.equal(read.days.length, days.PERSON_DAYS_READ);
  assert.equal(read.totals.landings, days.PERSON_DAYS_READ);
  assert.equal(read.days.at(-1)[0], w.personDays.at(-1).day, 'the newest days are the ones kept');
});

/** A person with `private` projects (newest work) and `open` public ones (older work), one day each. */
function busyWorld({ privateDays, openDays, privateProjects, openProjects }) {
  const w = {
    hostedProjects: [],
    forgeAccounts: [{ owner: 'acct-a', handle: 'sample-one' }],
    personDays: [],
  };
  for (let i = 0; i < privateProjects; i++)
    w.hostedProjects.push({ _id: `priv${i}`, owner: 'acct-a', slug: `private-${i}`, visibility: 'private' });
  for (let i = 0; i < openProjects; i++)
    w.hostedProjects.push({ _id: `open${i}`, owner: 'acct-a', slug: `open-${i}`, visibility: 'public' });
  const entry = { l: 1, la: 0, n: 0, na: 0, v: 0, t: [1, 1], r: {} };
  const day = i => new Date(Date.UTC(2023, 0, 1) + i * 864e5).toISOString().slice(0, 10);
  for (let i = 0; i < openDays; i++)
    w.personDays.push({
      person: 'acct-a',
      day: day(i),
      value: JSON.stringify({ p: { [`open${i % openProjects}`]: entry } }),
    });
  for (let i = 0; i < privateDays; i++)
    w.personDays.push({
      person: 'acct-a',
      day: day(openDays + i),
      value: JSON.stringify({ p: { [`priv${i % privateProjects}`]: entry } }),
    });
  return w;
}
const visitor = async (w, viewer = null) => {
  const { db, reads } = fakeDb(w);
  return {
    read: await readProfile({ db }, { owner: 'acct-a', handle: 'sample-one', viewer, agentsFrom: 0 }),
    reads,
  };
};

test('the 50-project cap counts projects the viewer may see: a person busy in private projects still shows their public ones', async () => {
  // 55 private projects worked on lately, 5 public ones before: the newest 50 ids are all private.
  const w = busyWorld({ privateDays: 55, openDays: 5, privateProjects: 55, openProjects: 5 });
  const { read } = await visitor(w);
  assert.equal(read.projects.length, 5, 'all five public projects are shown');
  assert.equal(read.totals.landings, 5);
  assert.doesNotMatch(JSON.stringify(read), /private-/);
  assert.equal(read.projectsLeftOut, 0);
  // Fifty-five public projects: the cap still applies, to what is shown, and only the person is told about the rest.
  const many = busyWorld({ privateDays: 0, openDays: 55, privateProjects: 0, openProjects: 55 });
  assert.equal((await visitor(many)).read.projects.length, days.PERSON_PROJECTS_READ);
  assert.equal(
    (await visitor(many)).read.projectsLeftOut,
    0,
    'a visitor is never told about projects past the cap',
  );
  assert.equal((await visitor(many, 'acct-a')).read.projectsLeftOut, 5, 'the person themself is');
});

test('the 366-day cap counts days the viewer may see: private-only days do not use it up', async () => {
  const w = busyWorld({ privateDays: 400, openDays: 100, privateProjects: 4, openProjects: 4 });
  const { read, reads } = await visitor(w);
  assert.equal(read.days.length, 100, 'all 100 public days show, not the 0 left after 366 private rows');
  assert.equal(read.totals.landings, 100);
  assert(reads.documents <= days.PERSON_DAYS_PAGES * days.PERSON_DAYS_READ);
  // The self view keeps one page: everything is visible, so the first 366 rows fill the year.
  const self = await visitor(w, 'acct-a');
  assert.equal(self.read.days.length, days.PERSON_DAYS_READ);
  assert(
    self.reads.documents <= days.PERSON_DAYS_READ + 5,
    `one page of rows (and an account) when every day counts: ${self.reads.documents}`,
  );
});

test('a mostly-private history never makes the read unbounded: rows and project lookups stop at their caps', async () => {
  const w = busyWorld({ privateDays: 1_500, openDays: 20, privateProjects: 400, openProjects: 4 });
  const { db, reads } = fakeDb(w);
  let gets = 0;
  const counted = { ...db, get: async id => (gets++, db.get(id)) };
  const read = await readProfile(
    { db: counted },
    { owner: 'acct-a', handle: 'sample-one', viewer: null, agentsFrom: 0 },
  );
  assert(
    reads.documents <= days.PERSON_DAYS_PAGES * days.PERSON_DAYS_READ,
    `rows scanned: ${reads.documents}`,
  );
  assert(gets <= days.PERSON_PROJECTS_PROBE, `projects looked up: ${gets}`);
  assert.equal(
    read.days.length,
    0,
    'the public days lie past the scan, so they are left out, not read without bound',
  );
});

test('the close counts Items closed once each and comments per agent run, from the day’s Work change rows', async () => {
  const change = (op, action, hour, extra = {}) => {
    const row = {
      projectId: 'p1',
      actor: 'acct-a',
      operationId: `work:${op}`,
      at: at('2026-11-16', hour),
      command: { kind: 'change', source: 'work', action },
      kind: 'change',
      ...extra,
    };
    return { ...row, _creationTime: row.at };
  };
  const event = (op, command) => ({ projectId: 'p1', operationId: op, command: JSON.stringify(command) });
  const put = (op, fields) => event(op, { action: 'put-planning-item', itemId: 'item-1', ...fields });
  const { db } = fakeDb({
    projectCoordinationEvents: [
      change('o1', 'put-planning-item', 9),
      change('o2', 'put-planning-item', 10),
      change('o3', 'put-planning-item', 11),
      change('o4', 'put-planning-item', 12),
      change('o5', 'put-planning-item', 13),
      change('o6', 'comment-planning-item', 14),
      change('o7', 'comment-planning-item', 15),
      change('o8', 'comment-planning-item', 16, { actor: 'system:queue' }),
      change('o9', 'message', 17, {
        command: { kind: 'message' },
        kind: 'message',
        recipientActor: 'acct-b',
      }),
      change('o10', 'comment-planning-item', 9, { at: at('2026-11-15', 9) }),
      change('o11', 'comment-planning-item', 18),
      change('o12', 'put-planning-item', 19, { projectId: 'p2' }),
    ],
    projectWorkEvents: [
      put('o1', { status: 'closed', expectedVersion: 3 }),
      // Reopened and closed again the same day: one Item closed.
      put('o2', { status: 'closed', expectedVersion: 5 }),
      // Created closed (an import or a filed record) is not a close.
      put('o3', { itemId: 'item-2', status: 'closed', expectedVersion: 0 }),
      put('o4', { itemId: 'item-3', status: 'closed', expectedVersion: 2, imported: { source: 'x' } }),
      put('o5', { status: 'open', expectedVersion: 6 }),
      event('o7', { action: 'comment-planning-item', itemId: 'item-1', text: 'By hand' }),
      event('o8', { action: 'comment-planning-item', itemId: 'item-1', text: 'System' }),
      event('o10', { action: 'comment-planning-item', itemId: 'item-1', text: 'Yesterday' }),
    ],
    projectHostedRecordBodies: [
      // A retained body still holds its command; one the journal took holds none and is skipped.
      event('o6', {
        action: 'comment-planning-item',
        itemId: 'item-1',
        text: 'From a run',
        agent: 'amber-fox',
      }),
      { projectId: 'p1', operationId: 'o11', journalSegment: '1' },
    ],
  });
  const from = Date.parse('2026-11-16T00:00:00.000Z');
  const { contributions: found, cut } = await planningContributions({ db }, 'p1', from, from + 86_400_000);
  assert.equal(cut, null, 'under both caps: nothing left uncounted');
  assert.deepEqual(found, [
    { kind: 'close', person: 'acct-a', at: at('2026-11-16', 9), item: 'item-1' },
    { kind: 'close', person: 'acct-a', at: at('2026-11-16', 10), item: 'item-1' },
    { kind: 'comment', person: 'acct-a', at: at('2026-11-16', 14), run: 'amber-fox' },
    { kind: 'comment', person: 'acct-a', at: at('2026-11-16', 15) },
  ]);
  const entry = days.projectDays(found).get('acct-a');
  assert.equal(entry.c, 1, 'an Item closed twice in a day counts once');
  assert.equal(entry.m, 2);
  assert.deepEqual(entry.rc, { 'amber-fox': 1 });
  assert.deepEqual(entry.r, {}, 'a comment alone does not list a run under Agents');
  // A row closed before this was counted reads as before: no Items closed, no comments.
  const old = days.profileRead({
    handle: 'sample-one',
    self: true,
    scope: 'all',
    rows: [{ day: '2026-11-01', value: { p: { p1: { l: 1, la: 0, n: 0, na: 0, v: 0, t: [1, 1], r: {} } } } }],
    seen: new Map([['p1', { visibility: 'public', shared: false, handle: 'sample-one', slug: 'open-one' }]]),
    projectsLeftOut: 0,
    agentsFrom: 0,
  });
  assert.equal(old.totals.itemsClosed, 0);
  assert.deepEqual(old.days, [['2026-11-01', 1, 0, 0, 0, 0]]);
});

test('a close past either cap marks the days it could not fully count, never undercounting silently', async () => {
  const from = Date.parse('2026-11-16T00:00:00.000Z');
  const change = (n, actor, action = 'comment-planning-item') => ({
    projectId: 'p1',
    actor,
    operationId: `work:o${n}`,
    at: from + n * 1000,
    _creationTime: from + n * 1000,
    command: { kind: 'change', source: 'work', action },
    kind: 'change',
  });
  const event = n => ({
    projectId: 'p1',
    operationId: `o${n}`,
    command: JSON.stringify({ action: 'comment-planning-item', itemId: 'item-1', text: 'Hi' }),
  });
  // The command cap: the commands past it are not opened; their people still get a marked day.
  const busy = Array.from({ length: PERSON_WORK_COMMANDS + 2 }, (_, n) =>
    change(n, n < PERSON_WORK_COMMANDS ? 'acct-a' : 'acct-c'),
  );
  const commands = fakeDb({
    projectCoordinationEvents: busy,
    projectWorkEvents: busy.map((_, n) => event(n)),
  });
  const capped = await planningContributions({ db: commands.db }, 'p1', from, from + 86_400_000);
  assert.equal(capped.cut, from + PERSON_WORK_COMMANDS * 1000, 'the first change not counted');
  assert.equal(commands.reads.documents, busy.length + PERSON_WORK_COMMANDS, 'no command read past the cap');
  const entries = days.projectDays(capped.contributions, true);
  assert.equal(entries.get('acct-a').m, PERSON_WORK_COMMANDS);
  assert.equal(entries.get('acct-a').pp, 1);
  assert.deepEqual(
    [entries.get('acct-c').m, entries.get('acct-c').pp],
    [undefined, 1],
    'seen but not counted: marked, not missing',
  );
  // The change-row cap: rows past it are not read; the close knows some were left.
  const rows = Array.from({ length: PERSON_WORK_CHANGES + 5 }, (_, n) => change(n, 'acct-a', 'holder taken'));
  const changes = fakeDb({ projectCoordinationEvents: rows });
  const full = await planningContributions({ db: changes.db }, 'p1', from, from + 86_400_000);
  assert.equal(full.cut, from + PERSON_WORK_CHANGES * 1000);
  assert.equal(
    changes.reads.documents,
    PERSON_WORK_CHANGES + 1,
    'one row past the cap, to know there are more',
  );
  // The profile says the figure is a floor.
  const read = days.profileRead({
    handle: 'sample-one',
    self: true,
    scope: 'all',
    rows: [{ day: '2026-11-16', value: { p: { p1: entries.get('acct-a') } } }],
    seen: new Map([['p1', { visibility: 'public', shared: false, handle: 'sample-one', slug: 'open-one' }]]),
    projectsLeftOut: 0,
    agentsFrom: 0,
  });
  assert.equal(read.closedPartial, true);
  const clean = days.profileRead({
    handle: 'sample-one',
    self: true,
    scope: 'all',
    rows: [{ day: '2026-11-16', value: { p: { p1: days.projectDays(capped.contributions).get('acct-a') } } }],
    seen: new Map([['p1', { visibility: 'public', shared: false, handle: 'sample-one', slug: 'open-one' }]]),
    projectsLeftOut: 0,
    agentsFrom: 0,
  });
  assert.equal(clean.closedPartial, false);
});

test('a close marks the days it could not count: past a cap, or older than the kept change rows of an old project', () => {
  const now = Date.parse('2026-11-18T12:00:00.000Z');
  const window = Date.parse('2026-11-01T00:00:00.000Z');
  const young = planningPartialDays({ window, cut: null, projectCreated: now - 3 * 86_400_000, now });
  assert.equal(young.any, false, 'a project younger than 14 days has archived nothing');
  const old = planningPartialDays({ window, cut: null, projectCreated: 0, now });
  assert.deepEqual(
    ['2026-11-01', '2026-11-03', '2026-11-04', '2026-11-18'].map(old.has),
    [true, true, false, false],
    'only the days older than the kept 14 days',
  );
  const recent = planningPartialDays({ window: now - 86_400_000, cut: null, projectCreated: 0, now });
  assert.equal(recent.any, false, 'a window inside the kept 14 days is whole');
  const capped = planningPartialDays({
    window: now - 86_400_000,
    cut: Date.parse('2026-11-18T08:00:00.000Z'),
    projectCreated: 0,
    now,
  });
  assert.deepEqual([capped.any, capped.has('2026-11-17'), capped.has('2026-11-18')], [true, false, true]);
});

/** One day's planning changes (one per n) and the Work events that hold their commands. */
function planningDay(commands) {
  const from = Date.parse('2026-11-16T00:00:00.000Z');
  const rows = commands.map((command, n) => ({
    projectId: 'p1',
    actor: 'acct-a',
    operationId: `work:o${n}`,
    at: from + n * 1000,
    _creationTime: from + n * 1000,
    command: { kind: 'change', source: 'work', action: command.action },
    kind: 'change',
  }));
  const events = commands.map((command, n) => ({
    projectId: 'p1',
    operationId: `o${n}`,
    command: JSON.stringify(command),
  }));
  return { from, to: from + 86_400_000, rows, events };
}
const closePut = (n, itemId, expectedVersion) => ({
  action: 'put-planning-item',
  operationId: `put-${n}`,
  itemId,
  status: 'closed',
  expectedVersion,
});

test('LATER-2: an edit that re-sends the closed status of a closed Item is no close (hosted record store)', async () => {
  // The old WorkPlanning editor sends every field, status included, on each edit.
  const day = planningDay([
    closePut(0, 'item-closed', 4),
    closePut(1, 'item-open', 2),
    closePut(2, 'item-unknown', 7),
  ]);
  const version = (key, version, status) => ({
    projectId: 'p1',
    kind: 'issue',
    key,
    version,
    status,
    parent: '',
    digest: 'd',
    bytes: 1,
  });
  const { db } = fakeDb({
    projectCoordinationEvents: day.rows,
    projectWorkEvents: day.events,
    projectHostedRecords: [version('item-closed', 4, 'closed'), version('item-open', 2, 'open')],
  });
  const { contributions } = await planningContributions({ db }, 'p1', day.from, day.to);
  assert.deepEqual(
    contributions.map(c => [c.kind, c.item]),
    [
      ['close', 'item-open'],
      // Neither store has its version before: counted, as before.
      ['close', 'item-unknown'],
    ],
    'an Item already closed at the version the put replaced is not closed again',
  );
});

test('LATER-2: on a project whose planning is only in the journal index, the version before the put decides', async () => {
  const day = planningDay([closePut(0, 'item-x', 3), closePut(1, 'item-y', 1)]);
  const journal = (key, parent, position, value) => ({
    projectId: 'p1',
    generationId: 'g1',
    collection: 'planningVersions',
    key,
    parent,
    position,
    _creationTime: position,
    value: JSON.stringify(value),
  });
  const { db } = fakeDb({
    hostedProjects: [{ _id: 'p1', work: { generationId: 'g1', backupId: 'bk' } }],
    projectWorkGenerations: [
      {
        _id: 'g1',
        projectId: 'p1',
        backupId: 'bk',
        status: 'ready',
        format: HOSTED_WORK_INDEX_FORMAT,
        metadata: '{}',
      },
    ],
    projectCoordinationEvents: day.rows,
    projectWorkEvents: day.events,
    projectPlanningRecords: [
      journal('x-v3', 'item-x', 5, { version: 3, status: 'closed' }),
      journal('y-v1', 'item-y', 6, { version: 1, status: 'open' }),
      // Another Item's version in between, and each put's own new version.
      journal('z-v1', 'item-z', 7, { version: 1, status: 'closed' }),
      journal('put-0', 'item-x', 9, { version: 4, status: 'closed' }),
      journal('put-1', 'item-y', 10, { version: 2, status: 'closed' }),
    ],
  });
  const { contributions } = await planningContributions({ db }, 'p1', day.from, day.to);
  assert.deepEqual(
    contributions.map(c => [c.kind, c.item]),
    [['close', 'item-y']],
  );
});

test('LATER-4: the close stops reading commands at its byte cap and marks the rest partial', async () => {
  // Six comments of about 1.1 MB each: the close opens four (past 4 MiB), never the fifth or sixth.
  const text = 'x'.repeat(1_100_000);
  const day = planningDay(
    Array.from({ length: 6 }, () => ({ action: 'comment-planning-item', itemId: 'item-1', text })),
  );
  const { db } = fakeDb({ projectCoordinationEvents: day.rows, projectWorkEvents: day.events });
  const { contributions, cut } = await planningContributions({ db }, 'p1', day.from, day.to);
  assert.deepEqual(
    contributions.map(c => c.kind),
    ['comment', 'comment', 'comment', 'comment', 'partial', 'partial'],
  );
  assert.equal(cut, day.from + 4000, 'the first change past the byte cap');
  assert(PERSON_WORK_BYTES < 5 * 1_100_000);
  assert.equal(
    days.projectDays(contributions, true).get('acct-a').pp,
    1,
    'the day is marked, not undercounted silently',
  );
});
