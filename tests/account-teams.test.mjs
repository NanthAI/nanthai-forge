// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > People and teams (Item a841a76d): the person's teams, members by handle. Person-only: every device, agent
// and legacy CLI credential is refused through the real auth wrapper, whatever its project or source scope. Owners get
// the member keys their remove path needs; members never do. Handles come from the membership rows (kept current on
// insert, on a handle change, and by the one-time backfill), so a read never looks an account up per person. Review
// fd9e3710: the credential refusals and the page-level bound failed on the reviewed head; the invitee, removal and
// canary cases held there already and are kept as regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';

const accountTeams = await import(moduleUrl('../convex/accountTeams.ts'));
const teamHandles = await import(moduleUrl('../convex/teamHandles.ts'));
const teams = await import(moduleUrl('../convex/teams.ts'));
const membership = await import(moduleUrl('../convex/teamInvitationMembership.ts'));
const page = (numItems = 20, cursor = null) => ({ paginationOpts: { cursor, numItems } });
// Private values that must never leave the read: an address, a real name, a machine name.
const CANARY = /canary-mail@example\.test|Canary Realname|canary-laptop\.local/;

function world() {
  const s = state([]);
  const account = (owner, handle) =>
    s.tables.forgeAccounts.set(`acct-${owner}`, {
      _id: `acct-${owner}`,
      _creationTime: 1,
      owner,
      handle,
      email: 'canary-mail@example.test',
      name: 'Canary Realname',
    });
  account('owner', 'sample-owner');
  account('peer', 'sample-peer');
  account('third', 'sample-third');
  const team = (id, owner, members, fields = {}) => {
    s.tables.teams.set(id, { _id: id, _creationTime: 1, owner, name: id, operationId: id, ...fields });
    for (const member of members) {
      const handle = s.tables.forgeAccounts.get(`acct-${member}`)?.handle ?? null;
      s.tables.teamMembers.set(`${id}:${member}`, {
        _id: `${id}:${member}`,
        _creationTime: 1,
        teamId: id,
        member,
        handle,
      });
    }
  };
  return { s, team, account };
}

function credential(s, fields, signIn = true) {
  s.tables.cliCredentials.set('cred', {
    _id: 'cred',
    _creationTime: 1,
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'canary-laptop.local',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    revoked: false,
    scope: 'cli',
    ...fields,
  });
  if (signIn)
    s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'synthetic-device' });
}

test('the person sees the teams they own and are in, members by handle; keys go to the owner only', async () => {
  const { s, team } = world();
  team('core', 'owner', ['owner', 'peer']);
  team('docs', 'peer', ['peer', 'owner', 'nohandle']);
  team('elsewhere', 'third', ['third']);
  team('gone', 'owner', ['owner'], { removal: 'deleted' });
  s.caller('owner');
  const result = await accountTeams.list._handler(s.ctx, page());
  assert.equal(result.isDone, true);
  const byName = Object.fromEntries(result.page.map(row => [row.name, row]));
  assert.deepEqual(Object.keys(byName).sort(), ['core', 'docs']);
  assert.equal(byName.core.role, 'owner');
  assert.equal(byName.core.ownerHandle, 'sample-owner');
  assert.deepEqual(
    byName.core.members.map(m => [m.handle, m.you, m.owner, m.key]),
    [
      ['sample-owner', true, true, 'owner'],
      ['sample-peer', false, false, 'peer'],
    ],
  );
  assert.equal(byName.docs.role, 'member');
  assert.equal(byName.docs.ownerHandle, 'sample-peer');
  assert.ok(
    byName.docs.members.every(m => !('key' in m)),
    'a member never receives account keys',
  );
  assert.deepEqual(
    byName.docs.members.map(m => m.handle).sort((a, b) => String(a).localeCompare(String(b))),
    [null, 'sample-owner', 'sample-peer'],
  );
});

test('a human member gets handles and flags only: no account key, address, name or machine name', async () => {
  const { s, team } = world();
  team('docs', 'peer', ['peer', 'owner', 'third']);
  credential(s, { owner: 'peer' }, false); // another member's device exists; its name must not leak either
  s.caller('third');
  const result = await accountTeams.list._handler(s.ctx, page());
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, CANARY);
  assert.doesNotMatch(text, /"key"|acct-|"peer"|"third"|"owner":"/);
  assert.deepEqual(Object.keys(result.page[0].members[0]).sort(), ['handle', 'owner', 'you']);
});

test('every device, agent and legacy CLI credential is refused before memberships are read', async () => {
  const cases = [
    ['all projects, write source', { settings: { projects: { kind: 'all' }, source: 'write' } }],
    ['all projects, read source', { settings: { projects: { kind: 'all' }, source: 'read' } }],
    ['one project', { settings: { projects: { kind: 'project', projectId: 'p' }, source: 'write' } }],
    ['device without settings (legacy)', {}],
    ['agent coordination credential', { scope: 'coordination' }],
  ];
  for (const [label, fields] of cases) {
    const { s, team } = world();
    team('core', 'owner', ['owner', 'peer']);
    credential(s, fields);
    let ranges = 0;
    const query = s.ctx.db.query.bind(s.ctx.db);
    s.ctx.db.query = table => {
      if (table === 'teamMembers') ranges++;
      return query(table);
    };
    await assert.rejects(accountTeams.list._handler(s.ctx, page()), /AUTH_SCOPE_DENIED/, label);
    assert.equal(ranges, 0, `${label}: no membership read`);
  }
  // A token from the legacy CLI issuer without a current credential is refused too.
  const { s, team } = world();
  team('core', 'owner', ['owner']);
  const before = process.env.FORGE_CLI_ISSUER;
  process.env.FORGE_CLI_ISSUER = 'https://legacy-cli.example.test';
  try {
    s.ctx.auth.getUserIdentity = async () => ({
      subject: 'owner',
      issuer: 'https://legacy-cli.example.test',
    });
    await assert.rejects(accountTeams.list._handler(s.ctx, page()), /AUTH_/);
  } finally {
    if (before === undefined) delete process.env.FORGE_CLI_ISSUER;
    else process.env.FORGE_CLI_ISSUER = before;
  }
});

test('an invited person who is not a member sees no team; a removed member sees none on the next read', async () => {
  const { s, team } = world();
  team('core', 'owner', ['owner', 'peer']);
  s.tables.projectInvites ??= new Map();
  for (const [id, expiresAt] of [
    ['inv-pending', Date.now() + 86_400_000],
    ['inv-expired', Date.now() - 1],
  ])
    s.tables.projectInvites.set(id, {
      _id: id,
      _creationTime: 1,
      projectId: 'p',
      email: 'canary-mail@example.test',
      kind: 'handle',
      inviter: 'owner',
      recipient: 'third',
      state: 'pending',
      expiresAt,
    });
  s.caller('third');
  assert.deepEqual((await accountTeams.list._handler(s.ctx, page())).page, []);
  s.caller('peer');
  assert.equal((await accountTeams.list._handler(s.ctx, page())).page.length, 1);
  s.caller('owner');
  await s.transaction(() => teams.removeMember._handler(s.ctx, { id: 'core', member: 'peer' }));
  const owned = await accountTeams.list._handler(s.ctx, page());
  assert.deepEqual(
    owned.page[0].members.map(m => m.handle),
    ['sample-owner'],
  );
  s.caller('peer');
  assert.deepEqual((await accountTeams.list._handler(s.ctx, page())).page, []);
});

test('handles stay current: set on insert, patched on a change, and backfilled once (a rerun writes nothing)', async () => {
  const { s, team } = world();
  team('core', 'owner', ['owner', 'peer']);
  team('docs', 'peer', ['peer']);
  // Rows from before handles were kept on the row.
  for (const row of s.tables.teamMembers.values()) delete row.handle;
  let result = await s.transaction(() => teamHandles.backfill._handler(s.ctx, {}));
  assert.deepEqual(result, { rows: 3, patched: 3, isDone: true });
  result = await s.transaction(() => teamHandles.backfill._handler(s.ctx, {}));
  assert.deepEqual(result, { rows: 3, patched: 0, isDone: true });
  // A handle change reaches every membership of that person.
  s.tables.forgeAccounts.get('acct-peer').handle = 'renamed-peer';
  await s.transaction(() => teamHandles.syncTeamHandles(s.ctx, 'peer', 'renamed-peer'));
  assert.deepEqual(
    [...s.tables.teamMembers.values()].filter(r => r.member === 'peer').map(r => r.handle),
    ['renamed-peer', 'renamed-peer'],
  );
  s.caller('owner');
  const core = (await accountTeams.list._handler(s.ctx, page())).page[0];
  assert.deepEqual(
    core.members.map(m => m.handle),
    ['sample-owner', 'renamed-peer'],
  );
  // A new membership takes the current handle when it is written.
  // Membership is written only by an accepted invitation, through this writer.
  await s.transaction(() => membership.addTeamMembership(s.ctx, 'core', 'third'));
  const added = [...s.tables.teamMembers.values()].find(r => r.teamId === 'core' && r.member === 'third');
  assert.equal(added.handle, 'sample-third');
});

test('one read is page-level and bounded: 20 teams, 12 members each, no account lookups; ops and bytes metered', async () => {
  // Realistic identifiers (review 1e530bda): 32-character document ids, 37-character account keys, 39-character
  // handles (the longest valid), short team names. Every document a read returns is metered as UTF-8 JSON, and so is
  // the reply.
  const s = state([]);
  const hex = (tag, n) => `${tag}${n}`.padStart(32, '0').slice(-32);
  const key = n => `user_${String(n).padStart(32, '0')}`;
  const handle = n => `h${n}`.padEnd(39, 'x');
  const viewer = key('viewer');
  let personN = 0;
  const person = () => {
    const owner = key(`p${personN++}`);
    s.tables.forgeAccounts.set(hex('a', personN), {
      _id: hex('a', personN),
      _creationTime: 1_700_000_000_000.5,
      owner,
      handle: handle(personN),
    });
    return owner;
  };
  for (let i = 0; i < 30; i++) {
    const id = hex('t', i);
    const members = [viewer, ...Array.from({ length: 40 }, person)];
    // Half the teams are someone else's, so the owner-row read is counted too.
    const owner = i % 2 ? members[1] : viewer;
    s.tables.teams.set(id, {
      _id: id,
      _creationTime: 1_700_000_000_000.5,
      owner,
      name: `Team ${i}`,
      operationId: crypto.randomUUID(),
    });
    members.forEach((member, j) =>
      s.tables.teamMembers.set(hex(`m${i}x`, j), {
        _id: hex(`m${i}x`, j),
        _creationTime: 1_700_000_000_000.5,
        teamId: id,
        member,
        handle: member === viewer ? handle('viewer') : handle(`${i}-${j}`),
      }),
    );
  }
  s.caller(viewer);
  const ops = { get: 0, range: 0, accounts: 0 };
  let readBytes = 0;
  const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null));
  const meter = result => {
    readBytes += Array.isArray(result?.page)
      ? result.page.reduce((sum, doc) => sum + bytes(doc), 0)
      : Array.isArray(result)
        ? result.reduce((sum, doc) => sum + bytes(doc), 0)
        : result
          ? bytes(result)
          : 0;
    return result;
  };
  const metered = builder =>
    new Proxy(builder, {
      get: (target, name) => {
        const value = target[name];
        if (typeof value !== 'function') return value;
        if (['take', 'unique', 'first', 'collect', 'paginate'].includes(name))
          return async (...args) => meter(await value.apply(target, args));
        return (...args) => {
          const next = value.apply(target, args);
          return next && typeof next === 'object' ? metered(next) : next;
        };
      },
    });
  const db = s.ctx.db;
  const ctx = {
    ...s.ctx,
    db: new Proxy(db, {
      get: (target, name) => {
        if (name === 'get')
          return async (...args) => {
            ops.get++;
            return meter(await target.get(...args));
          };
        if (name === 'query')
          return table => {
            ops.range++;
            if (table === 'forgeAccounts') ops.accounts++;
            return metered(target.query(table));
          };
        return target[name];
      },
    }),
  };
  const first = await accountTeams.list._handler(ctx, page(500));
  assert.equal(first.page.length, accountTeams.TEAMS_PAGE_MAX);
  assert.equal(first.isDone, false);
  for (const row of first.page) {
    assert.equal(row.members.length, accountTeams.MEMBERS_SHOWN);
    assert.equal(row.more, true);
    assert.ok(row.ownerHandle);
  }
  assert.equal(ops.accounts, 0, 'no account lookups');
  // Stated bound (convex/accountTeams.ts): 1 + 20 x 3 = 61 operations in the query body.
  assert.ok(ops.get + ops.range <= 61, `ops ${JSON.stringify(ops)}`);
  const replyBytes = bytes(first);
  // Stated caps (convex/accountTeams.ts, docs/data-placement.md): 70 KB read, 32 KB returned per full page.
  assert.ok(readBytes <= 70_000, `read ${readBytes} B`);
  assert.ok(replyBytes <= 32_000, `reply ${replyBytes} B`);
  console.log(`account-teams page: ${JSON.stringify(ops)}, read ${readBytes} B, reply ${replyBytes} B`);
  const second = await accountTeams.list._handler(s.ctx, page(20, first.continueCursor));
  assert.equal(second.page.length, 10);
  assert.equal(second.isDone, true);
  assert.equal(new Set([...first.page, ...second.page].map(row => row.id)).size, 30);
});
