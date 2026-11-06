// SPDX-License-Identifier: Apache-2.0
// Public identity rule: reads and receipts name people by Forge handle, never by auth
// subject (account id), provider display name or email. Every public function passes
// its result through convex/publicPeople.ts, which removes a person a reader may not
// see; a return validator therefore has to let every person field be absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';

const directory = new URL('../convex/', import.meta.url);
const files = readdirSync(directory).filter(
  file => file.endsWith('.ts') && !file.endsWith('.d.ts') && file !== 'schema.ts',
);
const people = await import(moduleUrl('../convex/publicPeople.ts'));
const subject = 'user_builderBBBBBBBB';

/** Fields a reviewed function may return to the person who entered them. */
const emailAllowed = new Set([
  // The owner's own pending invitations, typed by the owner.
  'projectContributors.ts:pending',
  // The owner's own stall-alert addresses; publicPeople removes them for everyone else.
  'projectAutonomy.ts:read',
  'projectAutonomy.ts:set',
  'projectBriefings.ts:brief',
  'projectWork.ts:state',
  'projectWorkActions.ts:command',
  'projectWorkActionsV8.ts:command',
  'projectWorkActions.ts:initialize',
  'projectWorkCommand.ts:command',
]);

function violations(node, path, found, name) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object')
    for (const [key, field] of Object.entries(node.value)) {
      const here = `${path}.${key}`;
      if (key === 'subject' || people.nameKeys.has(key)) found.push(`${here} must not be returned`);
      else if (people.emailKeys.has(key) && !emailAllowed.has(name))
        found.push(`${here} returns an email address`);
      violations(field.fieldType, here, found, name);
    }
  else if (node.type === 'array') violations(node.value, `${path}[]`, found, name);
  else if (node.type === 'union')
    node.value.forEach((item, i) => violations(item, `${path}|${i}`, found, name));
  else if (node.type === 'record') violations(node.value?.fieldType ?? node.value, `${path}{}`, found, name);
}

test('no public return validator returns an auth subject, display name or unreviewed email', async () => {
  const found = [];
  for (const file of files) {
    const module = await import(moduleUrl(`../convex/${file}`));
    for (const [name, fn] of Object.entries(module)) {
      if (!fn?.isPublic || !(fn.isQuery || fn.isMutation || fn.isAction)) continue;
      const returns = JSON.parse(fn.exportReturns() ?? 'null');
      const own = [];
      violations(returns, '', own, `${file}:${name}`);
      found.push(...own.map(line => `${file}:${name} ${line}`));
    }
  }
  assert.deepEqual(found, []);
});

// Reviewed exceptions: self-revocation must work with a revoked credential and returns null.
const builderExceptions = new Set(['cliServer.ts', 'server.ts', 'deviceCredentials.ts']);
test('every public function is built by cliServer, which applies the identity mapping', async () => {
  const bypass = [];
  const revoke = (await import(moduleUrl('../convex/deviceCredentials.ts'))).revoke;
  assert.equal(JSON.parse(revoke.exportReturns()).type, 'null');
  for (const file of files) {
    if (builderExceptions.has(file)) continue;
    const text = readFileSync(new URL(file, directory), 'utf8');
    for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/(?:_generated\/)?server'/g))
      if (/(?:^|[\s,])(?:query|mutation|action)(?:\s+as\s+\w+)?\s*(?:,|$)/m.test(match[1])) bypass.push(file);
  }
  assert.deepEqual(bypass, []);
});

test('a required person field is blanked, not removed, so the declared result still validates', async () => {
  const { v } = await import('convex/values');
  const shape = v.object({
    actor: v.string(),
    by: v.optional(v.string()),
    rows: v.array(v.object({ actor: v.string() })),
  }).json;
  const reader = fixture({ viewer: 'user_strangerCCCCCCCC', accounts: { [subject]: 'builder' } });
  assert.deepEqual(
    await people.publicPeople(
      reader.ctx,
      { projectId: 'project-1' },
      { actor: subject, by: subject, rows: [{ actor: subject }] },
      shape,
    ),
    { actor: '', rows: [{ actor: '' }] },
  );
});

function fixture({ viewer, owner = 'user_ownerAAAAAAAA', contributors = [], accounts = {} }) {
  const tables = {
    hostedProjects: new Map([['project-1', { _id: 'project-1', owner }]]),
    projectContributors: new Map(
      contributors.map((c, i) => [`c${i}`, { projectId: 'project-1', contributor: c }]),
    ),
    forgeAccounts: new Map(Object.entries(accounts).map(([o, handle]) => [o, { owner: o, handle }])),
    accountHandles: new Map(Object.entries(accounts).map(([o, handle]) => [handle, { owner: o, handle }])),
  };
  let reads = 0;
  const query = table => ({
    withIndex: (_name, build) => {
      const filters = {};
      const q = { eq: (field, value) => ((filters[field] = value), q) };
      build(q);
      const rows = () =>
        [...tables[table].values()].filter(row => Object.entries(filters).every(([k, v]) => row[k] === v));
      return {
        unique: async () => (reads++, rows()[0] ?? null),
        take: async n => (reads++, rows().slice(0, n)),
      };
    },
  });
  return {
    ctx: {
      auth: { getUserIdentity: async () => (viewer ? { subject: viewer } : null) },
      db: {
        normalizeId: (table, id) => (tables[table]?.has(id) ? id : null),
        get: async id => (reads++, tables.hostedProjects.get(id) ?? null),
        query,
      },
    },
    reads: () => reads,
  };
}
const lanes = JSON.stringify({
  page: [
    { laneId: 'l1', actor: subject, intent: 'x' },
    { laneId: 'l2', actor: subject, intent: 'y' },
  ],
  isDone: true,
});

test('a public reader of a public project sees no person; a writer sees the handle', async () => {
  const accounts = { [subject]: 'builder' };
  const reader = fixture({ viewer: 'user_strangerCCCCCCCC', accounts });
  const hidden = JSON.parse(await people.publicPeople(reader.ctx, { projectId: 'project-1' }, lanes));
  assert.deepEqual(
    hidden.page.map(row => Object.keys(row).sort()),
    [
      ['intent', 'laneId'],
      ['intent', 'laneId'],
    ],
  );
  // A reader always sees their own handle, and only theirs, with no project read.
  const self = fixture({ viewer: subject, accounts });
  const own = JSON.parse(await people.publicPeople(self.ctx, { projectId: 'project-1' }, lanes));
  assert.deepEqual(
    own.page.map(row => row.actor),
    ['builder', 'builder'],
  );
  assert.equal(self.reads(), 1, 'one account read; no project or membership read');
  const anonymous = fixture({ viewer: null, accounts });
  assert(!(await people.publicPeople(anonymous.ctx, { projectId: 'project-1' }, lanes)).includes('user_'));
  const writer = fixture({ viewer: subject, contributors: [subject], accounts });
  const shown = JSON.parse(await people.publicPeople(writer.ctx, { projectId: 'project-1' }, lanes));
  assert.deepEqual(
    shown.page.map(row => row.actor),
    ['builder', 'builder'],
  );
  // The writer's own actor: one account read for the repeated value.
  assert(writer.reads() <= 3, `reads ${writer.reads()}`);
});

test('subjects without an account, display names and emails never reach a non-owner', async () => {
  const contributor = 'user_contribDDDDDDDD';
  const view = fixture({
    viewer: contributor,
    contributors: [contributor],
    accounts: { [contributor]: 'c' },
  });
  const result = await people.publicPeople(
    view.ctx,
    { projectId: 'project-1' },
    {
      owner: 'user_ownerAAAAAAAA',
      rows: [{ actor: 'forge:expiry' }, { actor: { id: 'user_goneEEEEEEEE', kind: 'person' } }],
      nested: JSON.stringify({ actor: contributor, actorDisplayName: 'Real Name' }),
      policy: { stallAlerts: { email: ['someone@example.com'] } },
    },
  );
  assert.deepEqual(result, {
    rows: [{ actor: 'forge:expiry' }, {}],
    nested: JSON.stringify({ actor: 'c' }),
    policy: { stallAlerts: {} },
  });
});

test('person arguments may be handles; handlers receive the account id', async () => {
  const view = fixture({ viewer: subject, accounts: { [subject]: 'builder' } });
  assert.deepEqual(
    await people.subjectArgs(view.ctx, { projectId: 'project-1', contributor: 'builder', to: '2026-11-05' }),
    { projectId: 'project-1', contributor: subject, to: '2026-11-05' },
  );
  const untouched = { projectId: 'project-1', contributor: subject };
  assert.equal(await people.subjectArgs(view.ctx, untouched), untouched);
});

test('results without person fields are returned unchanged, with no reads', async () => {
  const view = fixture({ viewer: subject });
  const value = JSON.stringify({ page: [{ laneId: 'l1', head: 'h' }] });
  assert.equal(await people.publicPeople(view.ctx, { projectId: 'project-1' }, value), value);
  assert.equal(view.reads(), 0);
});

test('nested JSON the mapping leaves unchanged keeps its exact bytes, so digests still match', async () => {
  const view = fixture({ viewer: subject, accounts: { [subject]: 'builder' } });
  const json = JSON.stringify({ items: [{ actor: 'builder' }] }, null, 2) + '\n';
  const result = await people.publicPeople(view.ctx, {}, { json, sha256: 'digest' });
  assert.equal(result.json, json);
});

test('system actors are never looked up', async () => {
  const view = fixture({ viewer: subject });
  const value = { rows: [{ actor: 'forge:expiry' }, { actor: 'landing controller' }] };
  assert.deepEqual(await people.publicPeople(view.ctx, { projectId: 'project-1' }, value), value);
  assert.equal(view.reads(), 0);
});
