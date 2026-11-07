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

// Builder modules themselves, and reviewed exports by name: self-revocation must work
// with a revoked credential and returns null.
const builderFiles = new Set(['cliServer.ts', 'server.ts']);
const builderExports = new Set(['deviceCredentials.ts:revoke']);
/** Names every use of an unguarded public builder outside the reviewed exports. */
function unguarded(file, text) {
  const found = [];
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/(?:_generated\/)?server'/g))
    for (const binding of match[1].split(',')) {
      const [imported, local = imported] = binding.trim().split(/\s+as\s+/);
      if (!['query', 'mutation', 'action'].includes(imported)) continue;
      const uses = [...text.matchAll(new RegExp(`\\b${local}\\b`, 'g'))].length - 1;
      const reviewed = [...text.matchAll(new RegExp(`export const (\\w+) = ${local}\\(`, 'g'))].filter(m =>
        builderExports.has(`${file}:${m[1]}`),
      ).length;
      if (uses !== reviewed) found.push(`${file}:${local}`);
    }
  return found;
}
test('every public function is built by cliServer, which applies the identity mapping', async () => {
  const bypass = [];
  const revoke = (await import(moduleUrl('../convex/deviceCredentials.ts'))).revoke;
  assert.equal(JSON.parse(revoke.exportReturns()).type, 'null');
  for (const file of files)
    if (!builderFiles.has(file))
      bypass.push(...unguarded(file, readFileSync(new URL(file, directory), 'utf8')));
  assert.deepEqual(bypass, []);
});

test('the builder guard names each export outside the reviewed list, not just each file', () => {
  const header = "import { mutation as revocationMutation } from './server';\n";
  assert.deepEqual(
    unguarded('deviceCredentials.ts', `${header}export const revoke = revocationMutation({});\n`),
    [],
  );
  assert.deepEqual(
    unguarded(
      'deviceCredentials.ts',
      `${header}export const revoke = revocationMutation({});\nexport const rename = revocationMutation({});\n`,
    ),
    ['deviceCredentials.ts:revocationMutation'],
  );
  assert.deepEqual(
    unguarded('example.ts', "import { query } from './_generated/server';\nexport const read = query({});\n"),
    ['example.ts:query'],
  );
  assert.deepEqual(unguarded('example.ts', "import { internalMutation } from './server';\n"), []);
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

// Collector-signed input is never authority on its own: every public function that
// accepts a signature must resolve the signed-in caller before it reads any record.
// The one exception is a release-key signature (docs/operations/cli-update.md, "Automated
// signer"): the server verifies it against the compiled CLI_RELEASE_KEYS, so it must refuse a
// forged one with RELEASE_SIGNATURE_INVALID, still before any record, scheduler or storage use.
const releaseKeyVerified = new Map([
  [
    'projectReleaseSignatures.ts:put',
    { head: 'a'.repeat(64), keyId: 'f3b8ac47a969d73d', signature: `${'A'.repeat(86)}==`, release: 1 },
  ],
]);
test('every public function taking a collector signature refuses an anonymous caller first', async () => {
  const touched = name => () => {
    throw new Error(`${name} used before the caller check`);
  };
  const ctx = {
    auth: { getUserIdentity: async () => null },
    db: new Proxy({}, { get: (_, key) => touched(`db.${String(key)}`) }),
    runQuery: touched('runQuery'),
    runMutation: touched('runMutation'),
    runAction: touched('runAction'),
    scheduler: new Proxy({}, { get: (_, key) => touched(`scheduler.${String(key)}`) }),
    storage: new Proxy({}, { get: (_, key) => touched(`storage.${String(key)}`) }),
  };
  const checked = [],
    open = [];
  for (const file of files) {
    const module = await import(moduleUrl(`../convex/${file}`));
    for (const [name, fn] of Object.entries(module)) {
      if (!fn?.isPublic || !(fn.isMutation || fn.isAction)) continue;
      const args = JSON.parse(fn.exportArgs());
      if (!/"signature":/.test(JSON.stringify(args))) continue;
      const forged = releaseKeyVerified.get(`${file}:${name}`);
      const input = { projectId: 'hostedProjects-1', signature: '0'.repeat(64), ...forged };
      for (const key of Object.keys(args.value)) input[key] ??= key === 'entries' ? [] : '{}';
      try {
        await fn._handler(ctx, input);
        open.push(`${file}:${name} accepted an anonymous caller`);
      } catch (error) {
        const data = error?.data ?? {};
        if (data.code !== (forged ? 'RELEASE_SIGNATURE_INVALID' : 'PROJECT_UNAVAILABLE'))
          open.push(`${file}:${name} ${data.code ?? error?.message ?? 'failed'} before the caller check`);
      }
      checked.push(`${file}:${name}`);
    }
  }
  // The known collector endpoints are covered; a new one is covered automatically.
  for (const name of [
    'projectHostedOutputApi.ts:workerPrepare',
    'projectHostedOutputApi.ts:workerCommit',
    'projectHostedOutputBatch.ts:workerPrepare',
    'projectHostedOutputBatch.ts:workerCommit',
    'projectHostedCheckWorker.ts:callback',
    'projectHostedCheckWorker.ts:heartbeat',
    ...releaseKeyVerified.keys(),
  ])
    assert(checked.includes(name), `${name} is guarded`);
  assert.deepEqual(open, []);
});
