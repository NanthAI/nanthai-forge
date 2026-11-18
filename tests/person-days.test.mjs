// SPDX-License-Identifier: Apache-2.0
// A person's contributions (Item 6a251b23): the day close counts landings (and those by agent runs, with the model
// the run declared), Lanes and reviews per person; a repeated close writes the same row; the profile reads at most 366
// rows and sends only the projects the viewer may open: owner (everything), teammate (public plus shared private),
// reader of a shared project, public and signed-out viewers (public only). A removed project is never sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const days = await import(moduleUrl('../src/person-days.ts'));
const { readProfile, recordPersonDays } = await import(moduleUrl('../convex/personDays.ts'));
const { landingContributions } = await import(moduleUrl('../convex/projectStats.ts'));

/** Just enough of ctx.db for these reads: eq-only index ranges, order, take, unique, get, insert, patch. */
function fakeDb(tables) {
  let next = 0;
  const reads = { documents: 0 };
  const query = table => {
    let rows = [...(tables[table] ??= [])];
    let dir = 'asc';
    const api = {
      withIndex: (_name, range) => {
        const eqs = [];
        const lts = [];
        const q = {
          eq: (field, value) => (eqs.push([field, value]), q),
          lt: (field, value) => (lts.push([field, value]), q),
        };
        range?.(q);
        rows = rows.filter(
          row =>
            eqs.every(([field, value]) => row[field] === value) &&
            lts.every(([field, value]) => row[field] < value),
        );
        return api;
      },
      order: d => ((dir = d), api),
      take: n => {
        const sorted = [...rows].sort((a, b) => (a.day ?? '').localeCompare(b.day ?? ''));
        const out = (dir === 'desc' ? sorted.reverse() : sorted).slice(0, n);
        reads.documents += out.length;
        return Promise.resolve(out);
      },
      unique: () => {
        reads.documents += rows.length ? 1 : 0;
        return Promise.resolve(rows[0] ?? null);
      },
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
  const entry = (l, run) => ({
    l,
    la: run ? l : 0,
    n: 1,
    na: 0,
    v: 1,
    t: [at('2026-11-10'), at('2026-11-10', 18)],
    r: run ? { [run]: [1, l, 'sample-model-1'] } : {},
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
      day('2026-11-09', { pub: entry(2, 'amber-fox') }),
      day('2026-11-10', { shared: entry(3, 'tawny-newt'), mine: entry(5, 'moss-pike'), gone: entry(7) }),
      day('2026-11-11', { mine: entry(4) }),
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
    assert.doesNotMatch(JSON.stringify(read), /team-one|quiet-one|gone-one|tawny|moss/);
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
    assert.doesNotMatch(JSON.stringify(read), /quiet-one|gone-one|moss-pike/);
  }
});

test('the person themself sees every project they worked on, but never a removed one', async () => {
  const { read, reads } = await view('acct-a');
  assert.equal(read.self, true);
  assert.equal(read.scope, 'all');
  assert.equal(read.totals.landings, 14);
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
  assert(reads.documents <= 3 + 4 + 1, `rows, projects and one account: ${reads.documents}`);
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
