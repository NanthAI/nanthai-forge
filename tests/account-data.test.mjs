// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > Your data, server side (reviews 8e86eb09, ae15c5ca). Person-only: every read and cleanup entry refuses
// device, agent and legacy CLI credentials through the real wrappers, before an account row is read. The cleanup is
// bound to the exact reviewed before-list of what the person can see: anything shared, removed or renamed after the
// review refuses before anything is registered. A person who owns nothing can leave everything shared with them.
// Every query and mutation stays within one Convex paginated query, and every read stops at its byte cap, measured here at the largest record a name allows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state, job, providers } from './hosted-fixture.mjs';

const actions = await import(moduleUrl('../convex/accountActions.ts'));
const plan = await import(moduleUrl('../convex/accountPlan.ts'));
const data = await import(moduleUrl('../convex/accountData.ts'));
const resources = await import(moduleUrl('../convex/accountResources.ts'));
const LEAVES = ['projectReaders', 'projects', 'readers', 'teams', 'zones'];
const SHARED = ['projects', 'projectReaders', 'readers', 'teams', 'zones'];
test.beforeEach(t => t.after(providers()));
// Distinct creation times, as Convex gives: index-key cursors order ties by id, which the fixture does not model.
let clock = 1;
const row = (id, fields) => ({ _id: id, _creationTime: clock++, ...fields });
const refused = e => /^AUTH_/.test(e.data?.code ?? e.code ?? '');

/** Someone else's team, project, zone and import, each shared with `owner`. */
function sharedWorld() {
  clock = 1; // every world starts alike: worlds differ only in what a test adds
  const f = state([{ ...job('foreign'), owner: 'other' }]);
  f.tables.forgeAccounts.set('acct', row('acct', { owner: 'owner', handle: 'sample-owner' }));
  f.tables.teams.set('ft', row('ft', { owner: 'other', name: 'Their team', operationId: randomUUID() }));
  f.tables.teamMembers.set('tm', row('tm', { teamId: 'ft', member: 'owner' }));
  f.tables.hostedProjects.set(
    'fp',
    row('fp', { owner: 'other', name: 'Their project', key: 'their', currentBackup: null, revision: 2 }),
  );
  f.tables.projectContributors.set('pc', row('pc', { projectId: 'fp', contributor: 'owner' }));
  f.tables.importReaders.set('ir', row('ir', { importId: 'foreign', reader: 'owner' }));
  // A project someone else shares with the person to read, not to contribute (review s1-sol62 #3).
  f.tables.hostedProjects.set(
    'rp',
    row('rp', { owner: 'other', name: 'Their read project', key: 'read', currentBackup: null, revision: 1 }),
  );
  f.tables.projectReaders.set('prd', row('prd', { projectId: 'rp', reader: 'owner' }));
  return f;
}
/** A review as the page makes it: the shared pages, each chained from the one before, the first from nothing. */
async function review(f, kinds = SHARED) {
  let token;
  const rows = [];
  for (const kind of kinds)
    for (let cursor = null; ;) {
      const p = await data.shared._handler(f.ctx, { kind, cursor, token });
      token = p.token;
      rows.push(...p.rows.map(r => ({ ...r, kind })));
      if (p.isDone) break;
      cursor = p.continueCursor;
    }
  return { token, rows };
}
/** One pass over every page of a cleanup, as the page makes it. */
async function pass(f, operationId) {
  for (let cursor = null; ;) {
    const last = await actions.advance._handler(f.ctx, { operationId, cursor });
    if (last.isDone) return last;
    cursor = last.cursor;
  }
}
const drive = pass;
function device(f, fields) {
  f.tables.cliCredentials.set('cred', {
    _id: 'cred',
    _creationTime: 1,
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'synthetic',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    revoked: false,
    scope: 'cli',
    ...fields,
  });
  f.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'synthetic-device' });
}

test('every device, agent and legacy CLI credential is refused by every Your data read and cleanup entry', async () => {
  const entries = [
    ['accountData.overview', () => data.overview, {}],
    ['accountData.owned', () => data.owned, { kind: 'team', cursor: null }],
    [
      'accountData.shared',
      () => data.shared,
      { kind: 'teams', cursor: null, token: resources.incomingStart() },
    ],
    ['accountData.watch', () => data.watch, { operationId: randomUUID(), resources: [] }],
    ['accountPlan.read', () => plan.read, { operationId: randomUUID() }],
    [
      'accountPlan.progress',
      () => plan.progress,
      { operationId: randomUUID(), paginationOpts: { cursor: null, numItems: 10 } },
    ],
    ['accountPlan.receipts', () => plan.receipts, { paginationOpts: { cursor: null, numItems: 10 } }],
    [
      'accountActions.inventory',
      () => actions.inventory,
      { kind: 'team', paginationOpts: { cursor: null, numItems: 10 } },
    ],
    [
      'accountActions.begin',
      () => actions.begin,
      { operationId: randomUUID(), selection: [], leave: [], incoming: null },
    ],
    ['accountActions.advance', () => actions.advance, { operationId: randomUUID(), cursor: null }],
  ];
  const credentials = [
    ['all projects, write source', { settings: { projects: { kind: 'all' }, source: 'write' } }],
    ['all projects, read source', { settings: { projects: { kind: 'all' }, source: 'read' } }],
    ['one project', { settings: { projects: { kind: 'project', projectId: 'fp' }, source: 'write' } }],
    ['device without settings (legacy)', {}],
    ['agent coordination credential', { scope: 'coordination' }],
  ];
  for (const [label, fields] of credentials)
    for (const [name, fn, args] of entries) {
      const f = sharedWorld();
      device(f, fields);
      let accountReads = 0;
      const query = f.ctx.db.query.bind(f.ctx.db);
      f.ctx.db.query = table => {
        if (
          /^(accountOperations|accountItems|teamMembers|projectContributors|importReaders|zoneReaders|teams|savedViews|agentGrants)$/.test(
            table,
          )
        )
          accountReads++;
        return query(table);
      };
      await assert.rejects(fn()._handler(f.ctx, args), refused, `${label}: ${name}`);
      assert.equal(accountReads, 0, `${label}: ${name} read no account rows`);
      assert.equal(f.tables.accountOperations.size, 0);
      assert.ok(f.tables.teamMembers.has('tm'));
    }
  // A token from the legacy CLI issuer, without a current credential, is refused too.
  const before = process.env.FORGE_CLI_ISSUER;
  process.env.FORGE_CLI_ISSUER = 'https://legacy-cli.example.test';
  try {
    for (const [name, fn, args] of entries) {
      const f = sharedWorld();
      f.ctx.auth.getUserIdentity = async () => ({
        subject: 'owner',
        issuer: 'https://legacy-cli.example.test',
      });
      await assert.rejects(fn()._handler(f.ctx, args), refused, `legacy issuer: ${name}`);
      assert.equal(f.tables.accountOperations.size, 0);
    }
  } finally {
    if (before === undefined) delete process.env.FORGE_CLI_ISSUER;
    else process.env.FORGE_CLI_ISSUER = before;
  }
});

test('a person who owns nothing reviews what is shared with them and leaves all of it', async () => {
  const f = sharedWorld();
  const overview = await data.overview._handler(f.ctx, {});
  assert.ok(overview.kinds.every(k => k.rows.length === 0));
  const { token, rows } = await review(f);
  assert.deepEqual(rows.map(r => `${r.kind}:${r.id}:${r.label}`).sort(), [
    'projectReaders:prd:Their read project',
    'projects:pc:Their project',
    'readers:ir:A repository shared with you',
    'teams:tm:Their team',
  ]);
  const operationId = randomUUID();
  const receipt = await actions.begin._handler(f.ctx, {
    operationId,
    selection: [],
    leave: LEAVES,
    incoming: token,
  });
  assert.equal(receipt.stage, 'ready');
  const done = await drive(f, operationId);
  assert.equal(
    done.stage,
    'completed',
    JSON.stringify({ done, items: [...f.tables.accountItems.values()].map(i => [i.key, i.state]) }),
  );
  for (const [table, id] of [
    ['teamMembers', 'tm'],
    ['projectContributors', 'pc'],
    ['importReaders', 'ir'],
    ['projectReaders', 'prd'],
  ])
    assert.ok(!f.tables[table].has(id), `${table}:${id} left`);
  assert.ok(f.tables.hostedProjects.has('rp'), 'the project they read stays');
  // Their things stay theirs.
  assert.ok(f.tables.teams.has('ft'), 'their team stays');
  assert.ok(f.tables.hostedProjects.has('fp'), 'their project stays');
});

test('cleanup binds to the exact reviewed before-list: anything shared, removed or renamed after it refuses before registering', async () => {
  const changes = [
    [
      'a team shared after the review',
      f => f.tables.teamMembers.set('tm-new', row('tm-new', { teamId: 'ft2', member: 'owner' })),
      f =>
        f.tables.teams.set('ft2', row('ft2', { owner: 'other', name: 'Later', operationId: randomUUID() })),
    ],
    ['a reviewed membership removed', f => f.tables.projectContributors.delete('pc')],
    ['a reviewed team renamed', f => (f.tables.teams.get('ft').name = 'Renamed')],
    // Same id, same label, more access (review s1-astra62 #2): the review bound the access as read.
    [
      'a reviewed membership made guidance maintainer in place',
      f => (f.tables.projectContributors.get('pc').agentGuidanceMaintainer = true),
    ],
    [
      'a project shared to read after the review',
      f => f.tables.projectReaders.set('prd2', row('prd2', { projectId: 'fp', reader: 'owner' })),
    ],
  ];
  for (const [label, ...change] of changes) {
    const f = sharedWorld();
    const { token } = await review(f);
    for (const step of change) step(f);
    await assert.rejects(
      actions.begin._handler(f.ctx, {
        operationId: randomUUID(),
        selection: [],
        leave: LEAVES,
        incoming: token,
      }),
      /ACCOUNT_CHANGED/,
      label,
    );
    assert.equal(f.tables.accountOperations.size, 0, `${label}: nothing registered`);
    assert.equal(f.tables.accountItems.size, 0);
    assert.ok(f.tables.teamMembers.has('tm') && f.tables.importReaders.has('ir'), `${label}: nothing left`);
  }
  // Ordinary work in a project (its usage counters) gives no access, so it changes nothing about the review.
  {
    const f = sharedWorld();
    const { token } = await review(f);
    f.tables.projectContributors.get('pc').workBudget = { day: 1, checks: 3, composes: 1, submissions: 1 };
    const r = await actions.begin._handler(f.ctx, {
      operationId: randomUUID(),
      selection: [],
      leave: LEAVES,
      incoming: token,
    });
    assert.equal(r.stage, 'ready');
  }
  // Leaving needs a review at all.
  const f = sharedWorld();
  await assert.rejects(
    actions.begin._handler(f.ctx, { operationId: randomUUID(), selection: [], leave: LEAVES }),
    /BAD_ARGUMENT/,
  );
  await assert.rejects(
    actions.begin._handler(f.ctx, {
      operationId: randomUUID(),
      selection: [],
      leave: LEAVES,
      incoming: 'a'.repeat(64),
    }),
    /ACCOUNT_CHANGED/,
  );
  assert.equal(f.tables.accountOperations.size, 0);
});

/** Meters every read the handlers make through `f.ctx.db` (each document returned or yielded, as JSON bytes) and
 * holds each function to Convex's rule: at most one paginated query per query or mutation. */
function meter(f) {
  const m = { docs: 0, bytes: 0, gets: 0, ranges: 0, paginated: 0, most: {} };
  const read = doc => {
    if (!doc) return;
    m.docs++;
    m.bytes += Buffer.byteLength(JSON.stringify(doc));
  };
  const wrap = builder =>
    new Proxy(builder, {
      get: (target, name) => {
        if (name === Symbol.asyncIterator)
          return () => {
            const it = target[Symbol.asyncIterator]();
            return {
              next: async () => {
                const r = await it.next();
                if (!r.done) read(r.value);
                return r;
              },
              [Symbol.asyncIterator]() {
                return this;
              },
            };
          };
        const value = target[name];
        if (typeof value !== 'function') return value;
        if (name === 'paginate')
          return async (...args) => {
            if (++m.paginated > 1) throw new Error('Convex allows one paginated query per function');
            const r = await value.apply(target, args);
            r.page.forEach(read);
            return r;
          };
        if (['take', 'unique', 'first', 'collect'].includes(name))
          return async (...args) => {
            const r = await value.apply(target, args);
            [r].flat().forEach(read);
            return r;
          };
        return (...args) => {
          const next = value.apply(target, args);
          return next && typeof next === 'object' ? wrap(next) : next;
        };
      },
    });
  const db = f.ctx.db,
    get = db.get.bind(db),
    query = db.query.bind(db);
  db.get = async id => {
    m.gets++;
    const doc = await get(id);
    read(doc);
    return doc;
  };
  db.query = table => {
    m.ranges++;
    return wrap(query(table));
  };
  // Each query or mutation an action runs is its own function: the paginated-query rule applies per call.
  for (const name of ['runQuery', 'runMutation']) {
    const run = f.ctx[name];
    f.ctx[name] = async (fn, args) => {
      const outer = m.paginated,
        before = m.bytes,
        fnName = getFunctionName(fn);
      m.paginated = 0;
      try {
        return await run(fn, args);
      } finally {
        m.paginated = outer;
        m.most[fnName] = Math.max(m.most[fnName] ?? 0, m.bytes - before);
      }
    };
  }
  return {
    m,
    /** One function call from the test: a fresh paginated-query count and fresh totals. */
    call: async run => {
      Object.assign(m, { docs: 0, bytes: 0, gets: 0, ranges: 0, paginated: 0, most: {} });
      const value = await run();
      return { value, ...m, reply: Buffer.byteLength(JSON.stringify(value)) };
    },
  };
}

test('every Your data query and mutation stays within one Convex paginated query', async () => {
  const f = sharedWorld();
  for (let i = 0; i < 15; i++)
    f.tables.teams.set(
      `t${i}`,
      row(`t${i}`, { owner: 'owner', name: `Team ${i}`, operationId: randomUUID() }),
    );
  const { call } = meter(f);
  await call(() => data.overview._handler(f.ctx, {}));
  for (const kind of data.KINDS) await call(() => data.owned._handler(f.ctx, { kind, cursor: null }));
  const { token } = await call(() => review(f)).then(r => r.value);
  const operationId = randomUUID();
  const selection = (await data.owned._handler(f.ctx, { kind: 'team', cursor: null })).rows.map(r => ({
    kind: 'team',
    id: r.id,
    pin: r.pin,
  }));
  await call(() => actions.begin._handler(f.ctx, { operationId, selection, leave: LEAVES, incoming: token }));
  await call(() => drive(f, operationId));
  await call(() =>
    actions.inventory._handler(f.ctx, { kind: 'team', paginationOpts: { cursor: null, numItems: 10 } }),
  );
});

test('open costs one overview query: no paginated query, no gets, no provider call, labels without locations', async () => {
  const f = state([job()]);
  // A view named after a root file or a symbol it points at (review s1-astra62 #7): a location without a slash.
  f.tables.savedViews.set(
    'v-file',
    row('v-file', {
      owner: 'owner',
      importId: 'own',
      name: 'canary-root.ts',
      operationId: randomUUID(),
      route: { view: 'map', state: 's', file: 'canary-root.ts', line: 0 },
    }),
  );
  f.tables.savedViews.set(
    'v-symbol',
    row('v-symbol', {
      owner: 'owner',
      importId: 'own',
      name: 'canarySymbol',
      operationId: randomUUID(),
      route: { view: 'map', state: 's', file: 'a.ts', symbol: 'canarySymbol', line: 0 },
    }),
  );
  for (let i = 0; i < 15; i++) {
    f.tables.teams.set(
      `t${i}`,
      row(`t${i}`, { owner: 'owner', name: `Team ${i}`, operationId: randomUUID() }),
    );
    f.tables.savedViews.set(
      `v${i}`,
      row(`v${i}`, {
        owner: 'owner',
        importId: 'own',
        name: `private/canary-repo view ${i}`,
        operationId: randomUUID(),
        route: { view: 'map', state: 's', file: 'canary/file.ts', line: 0 },
      }),
    );
  }
  let actionsRun = 0;
  f.ctx.runAction = async () => {
    actionsRun++;
    throw new Error('no provider call on open');
  };
  const { call } = meter(f);
  const open = await call(() => data.overview._handler(f.ctx, {}));
  const view = open.value;
  assert.equal(open.paginated, 0);
  assert.equal(open.gets, 0);
  assert.equal(actionsRun, 0);
  const teams = view.kinds.find(k => k.kind === 'team');
  assert.equal(teams.rows.length, data.OVERVIEW_SHOWN);
  assert.equal(teams.more, true);
  const views = view.kinds.find(k => k.kind === 'view');
  assert.ok(
    views.rows.every(r => r.label === 'Saved view'),
    'a name carrying a location is not shown',
  );
  assert.doesNotMatch(JSON.stringify(view), /canary/);
  console.log(
    `account-data overview: ${open.ranges} ranges, ${open.docs} documents, read ${open.bytes} B, reply ${open.reply} B`,
  );
  // Seven kinds of at most OVERVIEW_SHOWN + 1 rows and the receipts.
  assert.ok(open.docs <= 7 * (data.OVERVIEW_SHOWN + 1) + data.RECEIPTS_SHOWN, `${open.docs} documents`);
  assert.ok(open.bytes <= 12_000, `read ${open.bytes} B`);
  assert.ok(open.reply <= 4_000, `reply ${open.reply} B`);
});

// The largest record a name allows: names have no length limit, so a row is bounded only by the 1 MiB document limit.
const HUGE = 1_000_000;
const huge = tag => `${tag} `.padEnd(HUGE, 'x');
test('at the largest record a name allows, every read stops at its byte cap and replies stay small', async () => {
  const f = sharedWorld();
  for (let i = 0; i < 11; i++) {
    f.tables.teams.set(
      `t${i}`,
      row(`t${i}`, { owner: 'owner', name: huge(`team ${i}`), operationId: randomUUID() }),
    );
    f.tables.savedViews.set(
      `v${i}`,
      row(`v${i}`, {
        owner: 'owner',
        importId: 'own',
        name: huge(`view ${i}`),
        operationId: randomUUID(),
        route: { view: 'map', state: 's', file: 'f.ts', line: 0 },
      }),
    );
    f.tables.hostedProjects.set(
      `p${i}`,
      row(`p${i}`, {
        owner: 'owner',
        name: huge(`project ${i}`),
        key: `p${i}`,
        currentBackup: null,
        revision: 1,
      }),
    );
  }
  // Teams of someone else's with the largest names, shared with the person.
  for (let i = 0; i < 3; i++) {
    f.tables.teams.set(
      `big${i}`,
      row(`big${i}`, { owner: 'other', name: huge(`theirs ${i}`), operationId: randomUUID() }),
    );
    f.tables.teamMembers.set(`bm${i}`, row(`bm${i}`, { teamId: `big${i}`, member: 'owner' }));
  }
  const DOC = HUGE + 1_000; // one largest document, as JSON
  // The caps, as fixed numbers: a bound computed from the module's own constants would move with them.
  const KiB = 1024,
    OVERVIEW = 32 * KiB,
    PAGE = 256 * KiB,
    EXPORT = 512 * KiB;
  const { call } = meter(f);
  const lines = [];
  const open = await call(() => data.overview._handler(f.ctx, {}));
  lines.push(`overview read ${open.bytes} B (${open.docs} documents), reply ${open.reply} B`);
  // Each of the three large kinds stops at its first row (past OVERVIEW_BYTES); the rest are small.
  assert.ok(open.bytes <= 3 * DOC + 7 * OVERVIEW, `overview read ${open.bytes} B`);
  assert.ok(open.reply <= 8_000, `overview reply ${open.reply} B`);
  for (const k of ['team', 'view', 'project']) {
    const held = open.value.kinds.find(x => x.kind === k);
    assert.equal(held.more, true, `${k}: at least`);
    assert.ok(
      held.rows.every(r => r.label.length <= 120),
      `${k}: clipped labels`,
    );
  }
  // The review pages: one largest row per page, every row still reached, short replies.
  let most = { bytes: 0, reply: 0 };
  const cursors = [];
  for (const kind of ['team', 'view', 'project']) {
    const ids = [];
    for (let cursor = null; ;) {
      const p = await call(() => data.owned._handler(f.ctx, { kind, cursor }));
      most = { bytes: Math.max(most.bytes, p.bytes), reply: Math.max(most.reply, p.reply) };
      ids.push(...p.value.rows.map(r => r.id));
      cursors.push(p.value.continueCursor);
      if (p.value.isDone) break;
      cursor = p.value.continueCursor;
    }
    assert.equal(new Set(ids).size, 11, `${kind}: every row once`);
  }
  lines.push(`owned page read at most ${most.bytes} B, reply at most ${most.reply} B`);
  assert.ok(most.bytes <= PAGE + DOC, `owned read ${most.bytes} B`);
  assert.ok(most.reply <= 1_000, `owned reply ${most.reply} B`);
  most = { bytes: 0, reply: 0 };
  const shared = [];
  for (let cursor = null, token; ;) {
    const p = await call(() => data.shared._handler(f.ctx, { kind: 'teams', cursor, token }));
    most = { bytes: Math.max(most.bytes, p.bytes), reply: Math.max(most.reply, p.reply) };
    shared.push(...p.value.rows.map(r => r.id));
    cursors.push(p.value.continueCursor);
    token = p.value.token;
    if (p.value.isDone) break;
    cursor = p.value.continueCursor;
  }
  assert.deepEqual(shared.sort(), ['bm0', 'bm1', 'bm2', 'tm']);
  lines.push(`shared page read at most ${most.bytes} B, reply at most ${most.reply} B`);
  // The grants, at most one largest parent past the cap, and the re-cut of the page.
  assert.ok(most.bytes <= 2 * PAGE + DOC, `shared read ${most.bytes} B`);
  assert.ok(most.reply <= 1_000, `shared reply ${most.reply} B`);
  // The export reads full metadata: one largest row past its cap per page.
  const exported = await call(() =>
    resources.page._handler(f.ctx, { kind: 'team', paginationOpts: { cursor: null, numItems: 100 } }),
  );
  lines.push(`export page read ${exported.bytes} B, reply ${exported.reply} B`);
  assert.ok(exported.bytes <= EXPORT + DOC, `export read ${exported.bytes} B`);
  const ids = exported.value.page.map(r => r.id);
  for (let cursor = exported.value.continueCursor; !exported.value.isDone;) {
    const p = await resources.page._handler(f.ctx, {
      kind: 'team',
      paginationOpts: { cursor, numItems: 100 },
    });
    ids.push(...p.page.map(r => r.id));
    cursors.push(p.continueCursor);
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  assert.equal(new Set(ids).size, ids.length, 'export: every row once');
  assert.equal(ids.length, 11, 'export: every team');
  cursors.push(exported.value.continueCursor);
  // Public cursors leave out the auth subject (review s1-astra62 #6); the pages above round-tripped through them.
  assert.ok(cursors.length > 20, `${cursors.length} cursors`);
  for (const c of cursors) assert.doesNotMatch(c, /"owner"/, 'a cursor carries the subject');
  // A whole cleanup of it: begin and a pass each finish, every function they run within its cap.
  const selection = [];
  for (const kind of ['team', 'view'])
    for (let cursor = null; ;) {
      const p = await data.owned._handler(f.ctx, { kind, cursor });
      selection.push(...p.rows.map(r => ({ kind, id: r.id, pin: r.pin })));
      if (p.isDone) break;
      cursor = p.continueCursor;
    }
  const { token } = await review(f);
  const operationId = randomUUID();
  const begun = await call(() =>
    actions.begin._handler(f.ctx, { operationId, selection, leave: LEAVES, incoming: token }),
  );
  assert.equal(begun.value.stage, 'ready');
  const ran = await call(() => drive(f, operationId));
  const perFunction = { ...begun.most };
  for (const [name, n] of Object.entries(ran.most)) perFunction[name] = Math.max(perFunction[name] ?? 0, n);
  const heaviest = Object.entries(perFunction).sort((a, b) => b[1] - a[1]);
  lines.push(
    `cleanup function reads at most ${heaviest
      .slice(0, 3)
      .map(([n, b]) => `${n} ${b} B`)
      .join(', ')}`,
  );
  // append: its cap plus the last row it checks (a view reads its row twice). A step removes one resource and reads
  // that one row a few times through its lifecycle (team deletion: five), far inside the 16 MiB a function may read.
  const append = perFunction['accountPlan:append'];
  assert.ok(append <= PAGE + 2 * DOC, `append ${append} B`);
  for (const [name, n] of heaviest) assert.ok(n <= 6 * DOC, `${name} read ${n} B`);
  assert.ok(!f.tables.savedViews.has('v0') && !f.tables.teamMembers.has('bm0'), 'the cleanup ran');
  console.log(`account-data at ${HUGE} B names: ${lines.join('; ')}`);
});

test('cleanup calls are page-level: steps check their own pins, no read per item from the action', async () => {
  const f = sharedWorld();
  for (let i = 0; i < 30; i++)
    f.tables.teams.set(
      `t${i}`,
      row(`t${i}`, { owner: 'owner', name: `Team ${i}`, operationId: randomUUID() }),
    );
  const selection = [];
  for (let cursor = null; ;) {
    const p = await data.owned._handler(f.ctx, { kind: 'team', cursor });
    selection.push(...p.rows.map(r => ({ kind: 'team', id: r.id, pin: r.pin })));
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  assert.equal(selection.length, 30);
  const { token } = await review(f);
  const calls = {};
  const count = (kind, run) => async (fn, args) => {
    const name = `${kind} ${getFunctionName(fn)}`;
    calls[name] = (calls[name] ?? 0) + 1;
    return run(fn, args);
  };
  const runQuery = f.ctx.runQuery,
    runMutation = f.ctx.runMutation,
    runAction = f.ctx.runAction;
  f.ctx.runQuery = count('query', runQuery);
  f.ctx.runMutation = count('mutation', runMutation);
  f.ctx.runAction = count('action', runAction);
  const operationId = randomUUID();
  await actions.begin._handler(f.ctx, { operationId, selection, leave: LEAVES, incoming: token });
  const begun = { ...calls };
  for (const key of Object.keys(calls)) delete calls[key];
  const last = await pass(f, operationId);
  console.log(`account-data begin ${JSON.stringify(begun)}; advance ${JSON.stringify(calls)}`);
  // Begin: original; the reviewed pages twice (a check that keeps nothing, then again while appending), one page per
  // listed kind each time; register; one append for the 30 owned rows and one per non-empty listed page; one captured
  // per leave kind; one page of the saved selection; seal. No per-item query.
  assert.equal(begun['query accountResources:incoming'], 2 * SHARED.length);
  assert.equal(begun['mutation accountPlan:append'], 1 + 4);
  assert.equal(begun['mutation accountPlan:captured'], LEAVES.length);
  assert.equal(begun['query accountPlan:items'], 1);
  assert.ok(!Object.keys(begun).some(k => k.startsWith('action')), 'no provider call in begin');
  // Advance: one items page and one step per item (34 items, one page of 40), then complete. No per-item query.
  assert.equal(calls['mutation accountExecute:step'], 34);
  assert.equal(calls['query accountPlan:items'], 1);
  assert.equal(
    Object.keys(calls).filter(k => k.startsWith('query') && k !== 'query accountPlan:items').length,
    0,
  );
  // Team removals run on in scheduled work: the pass ends waiting on them, with their marks for the watch.
  assert.ok(last.stage === 'completed' || last.waiting.length > 0, JSON.stringify(last));
});

test("watch follows only the operation's own waiting resources and moves when one of them changes", async () => {
  const f = state([job()]);
  f.tables.teams.set('mine', row('mine', { owner: 'owner', name: 'Mine', operationId: randomUUID() }));
  f.tables.teams.set('theirs', row('theirs', { owner: 'other', name: 'Theirs', operationId: randomUUID() }));
  const { rows } = await data.owned._handler(f.ctx, { kind: 'team', cursor: null });
  const operationId = randomUUID();
  await actions.begin._handler(f.ctx, {
    operationId,
    selection: rows.map(r => ({ kind: 'team', id: r.id, pin: r.pin })),
    leave: [],
    incoming: null,
  });
  const watched = await data.watch._handler(f.ctx, {
    operationId,
    resources: [{ kind: 'team', id: 'mine' }],
  });
  assert.equal(watched.marks.length, 1);
  const again = await data.watch._handler(f.ctx, { operationId, resources: [{ kind: 'team', id: 'mine' }] });
  assert.equal(again.marks[0].mark, watched.marks[0].mark, 'no change, same mark');
  f.tables.teams.get('mine').removal = 'deleted';
  const moved = await data.watch._handler(f.ctx, { operationId, resources: [{ kind: 'team', id: 'mine' }] });
  assert.notEqual(moved.marks[0].mark, watched.marks[0].mark);
  await assert.rejects(
    data.watch._handler(f.ctx, { operationId, resources: [{ kind: 'team', id: 'theirs' }] }),
    /ACCOUNT_UNAVAILABLE/,
  );
  await assert.rejects(
    data.watch._handler(f.ctx, {
      operationId,
      resources: Array.from({ length: data.WATCH_MAX + 1 }, (_, i) => ({ kind: 'team', id: `x${i}` })),
    }),
    /BAD_ARGUMENT/,
  );
});

test('at the largest record a name allows, the cleanup watch reads a byte-capped prefix and chains over every waiting removal', async () => {
  const f = state([job()]);
  for (let i = 0; i < 20; i++)
    f.tables.teams.set(
      `t${i}`,
      row(`t${i}`, { owner: 'owner', name: huge(`team ${i}`), operationId: randomUUID() }),
    );
  const selection = [];
  for (let cursor = null; ;) {
    const p = await data.owned._handler(f.ctx, { kind: 'team', cursor });
    selection.push(...p.rows.map(r => ({ kind: 'team', id: r.id, pin: r.pin })));
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  const operationId = randomUUID();
  await actions.begin._handler(f.ctx, { operationId, selection, leave: [], incoming: null });
  const last = await pass(f, operationId);
  assert.equal(last.waiting.length, 20, 'every team removal runs on elsewhere');
  const DOC = HUGE + 1_000,
    WATCH = 512 * 1024;
  const { call } = meter(f);
  // As the page chains them: each watch marks a prefix of what it is sent; the next starts where it stopped.
  const marked = [];
  let most = 0,
    watches = 0;
  for (let from = 0; from < last.waiting.length; watches++) {
    const part = last.waiting.slice(from, from + data.WATCH_MAX).map(({ kind, id }) => ({ kind, id }));
    const w = await call(() => data.watch._handler(f.ctx, { operationId, resources: part }));
    most = Math.max(most, w.bytes);
    assert.ok(w.value.marks.length > 0, 'a watch always marks at least one');
    marked.push(...w.value.marks.map(m => m.id));
    from += w.value.marks.length;
  }
  console.log(
    `account-data watch at ${HUGE} B names: ${watches} watches over 20 waiting teams, each read at most ${most} B`,
  );
  assert.deepEqual(
    marked,
    last.waiting.map(x => x.id),
    'every waiting removal is followed, in order',
  );
  // Its cap plus one largest resource and the operation's own rows, far inside the 16 MiB a function may read.
  assert.ok(most <= WATCH + DOC + 64 * 1024, `watch read ${most} B`);
  // A mark moves when its resource does, whichever watch follows it.
  const before = await data.watch._handler(f.ctx, { operationId, resources: [{ kind: 'team', id: 't19' }] });
  f.tables.teams.get('t19').removal = 'deleted';
  const after = await data.watch._handler(f.ctx, { operationId, resources: [{ kind: 'team', id: 't19' }] });
  assert.notEqual(after.marks[0].mark, before.marks[0].mark);
});

test('the export pairs each row with its own metadata when rows of removed imports drop out', async () => {
  const f = state([job(), { ...job('gone'), removal: 'trash' }]);
  const view = (id, importId) =>
    f.tables.savedViews.set(
      id,
      row(id, {
        owner: 'owner',
        importId,
        name: `View ${id}`,
        operationId: randomUUID(),
        route: { view: 'map', state: 's', file: 'f.ts', line: 0 },
      }),
    );
  // Removed rows before and between kept ones.
  view('a-gone', 'gone');
  view('b-kept', 'own');
  view('c-gone', 'gone');
  view('d-kept', 'own');
  const p = await actions.inventory._handler(f.ctx, {
    kind: 'view',
    paginationOpts: { cursor: null, numItems: 10 },
  });
  assert.ok(p.page.length >= 2, JSON.stringify(p.page.map(r => r.id)));
  for (const item of p.page) assert.equal(item.metadata.id, item.id, `${item.id}: its own metadata`);
  assert.ok(
    ['b-kept', 'd-kept'].every(id => p.page.some(r => r.id === id)),
    'kept rows are all there',
  );
});

test('a retry of a preparation interrupted between shared pages refuses once anything it stored changed', async () => {
  const f = sharedWorld();
  const { token } = await review(f);
  const pc = f.tables.projectContributors.get('pc');
  const operationId = randomUUID(),
    request = { operationId, selection: [], leave: LEAVES, incoming: token };
  // The first attempt reads the projects page again while appending, after the membership gained access in place: it
  // stores that row as it is now, and then refuses because the list no longer ends at the reviewed token.
  const run = f.ctx.runQuery;
  let projects = 0;
  f.ctx.runQuery = async (fn, args) => {
    if (getFunctionName(fn) === 'accountResources:incoming' && args.kind === 'projects' && ++projects === 2)
      pc.agentGuidanceMaintainer = true;
    return run(fn, args);
  };
  await assert.rejects(actions.begin._handler(f.ctx, request), /ACCOUNT_CHANGED/);
  f.ctx.runQuery = run;
  assert.equal((await plan.read._handler(f.ctx, { operationId })).stage, 'preparing', 'nothing sealed');
  // Back as reviewed: the stored row no longer matches what Forge holds, so the same request refuses instead of
  // sealing a selection the person never reviewed (review s1-astra62 r4 #2).
  pc.agentGuidanceMaintainer = false;
  await assert.rejects(actions.begin._handler(f.ctx, request), /ACCOUNT_CHANGED/);
  assert.equal((await plan.read._handler(f.ctx, { operationId })).stage, 'preparing', 'still nothing sealed');
  await assert.rejects(actions.advance._handler(f.ctx, { operationId, cursor: null }));
  assert.ok(f.tables.projectContributors.has('pc') && f.tables.teamMembers.has('tm'), 'nothing is left');
  // A fresh review starts a new deletion that leaves everything.
  const again = randomUUID();
  assert.equal(
    (
      await actions.begin._handler(f.ctx, {
        operationId: again,
        selection: [],
        leave: LEAVES,
        incoming: (await review(f)).token,
      })
    ).stage,
    'ready',
  );
  await drive(f, again);
  assert.ok(!f.tables.projectContributors.has('pc') && !f.tables.teamMembers.has('tm'));
});

test('seal binds to exactly the rows this preparation verified: a row stored by another attempt refuses', async () => {
  const f = sharedWorld();
  const { token } = await review(f);
  const operationId = randomUUID(),
    request = { operationId, selection: [], leave: LEAVES, incoming: token };
  // Another attempt stores a row this one never verified, between its last append and its seal.
  const mutate = f.ctx.runMutation;
  f.ctx.runMutation = async (fn, args) => {
    if (getFunctionName(fn) === 'accountPlan:seal') {
      const op = [...f.tables.accountOperations.values()].find(o => o.operationId === operationId);
      f.tables.accountItems.set(
        'stray',
        row('stray', {
          owner: 'owner',
          accountId: op._id,
          key: 'teams:stray',
          kind: 'teams',
          resourceId: 'tm',
          pin: 'a'.repeat(64),
          operationId: randomUUID(),
          hidden: true,
          state: 'pending',
        }),
      );
      f.tables.accountOperations.set(op._id, { ...op, pending: op.pending + 1 });
    }
    return mutate(fn, args);
  };
  await assert.rejects(actions.begin._handler(f.ctx, request), /ACCOUNT_OPERATION_CHANGED|ACCOUNT_CHANGED/);
  f.ctx.runMutation = mutate;
  assert.equal((await plan.read._handler(f.ctx, { operationId })).stage, 'preparing');
});

test('an overlapping retry of the same begin answers with the receipt the first one sealed', async () => {
  const f = sharedWorld();
  const { token } = await review(f);
  const request = { operationId: randomUUID(), selection: [], leave: LEAVES, incoming: token };
  const run = f.ctx.runQuery;
  let paused = false,
    reached,
    release;
  const atGate = new Promise(r => (reached = r)),
    gate = new Promise(r => (release = r));
  // The first call reads no receipt, then waits while the second one seals the same request.
  f.ctx.runQuery = async (fn, args) => {
    const value = await run(fn, args);
    if (getFunctionName(fn) === 'accountPlan:original' && !paused) {
      paused = true;
      reached();
      await gate;
    }
    return value;
  };
  const first = actions.begin._handler(f.ctx, request);
  await atGate;
  const second = await actions.begin._handler(f.ctx, request);
  release();
  const answer = await first;
  assert.equal(second.stage, 'ready');
  assert.deepEqual(answer, second);
  assert.equal(f.tables.accountOperations.size, 1);
  // A different request under the same operation still conflicts.
  await assert.rejects(
    actions.begin._handler(f.ctx, { ...request, leave: ['teams'] }),
    /ACCOUNT_OPERATION_CHANGED/,
  );
});

test('a deletion left preparing (as one begun before this version) deletes nothing', async () => {
  const f = sharedWorld();
  const operationId = randomUUID();
  // A request digest of the earlier format: it never matches a new request, and it never runs.
  f.tables.accountOperations.set(
    'old-op',
    row('old-op', {
      owner: 'owner',
      operationId,
      request: 'f'.repeat(64),
      expectedItems: 0,
      leave: LEAVES,
      stage: 'preparing',
      captured: [],
      pending: 1,
      at: 1,
    }),
  );
  f.tables.accountItems.set(
    'old-item',
    row('old-item', {
      owner: 'owner',
      accountId: 'old-op',
      key: 'teams:tm',
      kind: 'teams',
      resourceId: 'tm',
      pin: 'a'.repeat(64),
      operationId: randomUUID(),
      hidden: true,
      state: 'pending',
    }),
  );
  await assert.rejects(actions.advance._handler(f.ctx, { operationId, cursor: null }));
  assert.ok(f.tables.teamMembers.has('tm'), 'nothing left');
  assert.equal(f.tables.accountItems.get('old-item').state, 'pending');
});

test('a completed or older receipt never starts new work: it keeps the scope it recorded', async () => {
  const f = sharedWorld();
  // Receipts of operations registered by an earlier version: one completed, one still running.
  const legacy = (id, stage) => {
    const operationId = randomUUID();
    f.tables.accountOperations.set(
      id,
      row(id, {
        owner: 'owner',
        operationId,
        request: 'f'.repeat(64),
        expectedItems: 0,
        leave: LEAVES,
        stage,
        captured: LEAVES,
        pending: 0,
        at: Date.now() + 60_000,
      }),
    );
    return operationId;
  };
  const done = legacy('done-op', 'completed'),
    running = legacy('running-op', 'running');
  // Asked again (a lost reply, a replayed page), the completed one answers with its receipt and starts nothing
  // (review s1-astra62 r4 #1); the running one finishes what it recorded, and nothing more.
  assert.equal((await pass(f, done)).stage, 'completed');
  assert.equal((await pass(f, running)).stage, 'completed');
  assert.ok(f.tables.teamMembers.has('tm'), 'nothing neither recorded is left');
});

test('a selected item that changed after the review is kept, and the receipt counts it', async () => {
  const f = sharedWorld();
  f.tables.teams.set('mine', row('mine', { owner: 'owner', name: 'My team', operationId: randomUUID() }));
  f.tables.teamMembers.set('mm', row('mm', { teamId: 'mine', member: 'owner' }));
  const [{ id, pin }] = (await data.owned._handler(f.ctx, { kind: 'team', cursor: null })).rows;
  const { token } = await review(f);
  const operationId = randomUUID();
  const begun = await actions.begin._handler(f.ctx, {
    operationId,
    selection: [{ kind: 'team', id, pin }],
    leave: LEAVES,
    incoming: token,
  });
  assert.equal(begun.kept, 0);
  // Renamed after the deletion was confirmed and before it reached the team (review c4ece6f2 #1).
  f.tables.teams.get('mine').name = 'Renamed';
  const last = await drive(f, operationId);
  assert.equal(last.stage, 'completed');
  assert.ok(f.tables.teams.has('mine'), 'the changed team stays');
  assert.equal(last.kept, 1);
  assert.equal((await plan.read._handler(f.ctx, { operationId })).kept, 1);
  assert.equal((await data.overview._handler(f.ctx, {})).receipts[0].kept, 1);
});
