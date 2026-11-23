// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item eb631a53: a request for one project address never resolves to a different project. A removed project does not
// keep blocking its address: a new or renamed live project takes it, and a later restore of the removed one gets a
// free suffix and says so. The owner person renames directly; an agent's rename is held for them; the old address
// stays an alias of the project that had it. An address nobody live holds is "not found", never a near match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state, projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const identity = await import(moduleUrl('../convex/urlIdentity.ts'));
const projects = await import(moduleUrl('../convex/urlProjects.ts'));
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const approvals = await import(moduleUrl('../convex/projectHostedApprovals.ts'));
const compare = await import(moduleUrl('../convex/projectSettingCompare.ts'));
const purge = await import(moduleUrl('../convex/projectPurgeInventory.ts'));
const aliases = await import(moduleUrl('../convex/projectAliases.ts'));
import { getFunctionName } from 'convex/server';

function fixture() {
  const s = state([]);
  s.tables.forgeAccounts.set('acct', { _id: 'acct', _creationTime: 1, owner: 'owner', handle: 'dino' });
  s.tables.accountHandles.set('h', { _id: 'h', _creationTime: 1, owner: 'owner', handle: 'dino' });
  return s;
}
/** A live project named Forge, with its address assigned the way creation assigns it. */
async function create(s, id) {
  s.tables.hostedProjects.set(
    id,
    projectRow({ _id: id, _creationTime: s.tables.hostedProjects.size + 1, name: 'Forge', key: `key-${id}` }),
  );
  return identity.ensureProjectSlug(s.ctx, s.tables.hostedProjects.get(id));
}
const project = (s, id) => s.tables.hostedProjects.get(id);
const op = (s, id) => ({
  projectId: id,
  operationId: randomUUID(),
  expectedRevision: project(s, id).revision,
});
const at = (s, slug) => projects.resolve._handler(s.ctx, { handle: 'dino', slug });

test('a new project takes an address held only by removed copies; restoring the old copy moves it and says so', async () => {
  const s = fixture();
  assert.equal(await create(s, 'old'), 'forge');
  await lifecycle.trash._handler(s.ctx, op(s, 'old'));
  assert.equal(await at(s, 'forge'), null, 'a removed project is not found at its address');
  // Creation takes the base address instead of forge-2 (the dev case: nanthai-forge-4 behind removed copies).
  assert.equal(await create(s, 'new'), 'forge');
  assert.equal((await at(s, 'forge')).id, 'new');
  const moved = await lifecycle.restore._handler(s.ctx, op(s, 'old'));
  assert.deepEqual([moved.slug, moved.previousSlug], ['forge-2', 'forge']);
  assert.equal(project(s, 'old').slug, 'forge-2');
  assert.equal((await at(s, 'forge')).id, 'new', 'restore never takes a live project address back');
  assert.equal((await at(s, 'forge-2')).id, 'old');
  // A restore whose address is still free keeps it and reports nothing.
  await lifecycle.trash._handler(s.ctx, op(s, 'old'));
  assert.equal((await lifecycle.restore._handler(s.ctx, op(s, 'old'))).slug, undefined);
  assert.equal(project(s, 'old').slug, 'forge-2');
});

test('the owner person renames onto an address only a removed project held; the old one redirects', async () => {
  const s = fixture();
  await create(s, 'first');
  assert.equal(await create(s, 'second'), 'forge-2');
  const rename = slug => lifecycle.rename._handler(s.ctx, { ...op(s, 'second'), name: 'Forge', slug });
  await assert.rejects(rename('forge'), e => /already taken/.test(e.data?.message ?? e.message));
  await lifecycle.trash._handler(s.ctx, op(s, 'first'));
  assert.equal(await rename('forge'), null);
  assert.equal(project(s, 'second').slug, 'forge');
  for (const slug of ['forge', 'forge-2'])
    assert.deepEqual(await at(s, slug), { id: 'second', handle: 'dino', slug: 'forge', name: 'Forge' }, slug);
  // The removed project's restore moves to a free suffix, and its old alias stays with the live project.
  const third = await lifecycle.restore._handler(s.ctx, op(s, 'first'));
  assert.deepEqual([third.slug, third.previousSlug], ['forge-3', 'forge']);
  assert.equal((await at(s, 'forge-2')).id, 'second');
});

test('an agent rename is held for the owner person and applies exactly as granted', async () => {
  const s = fixture();
  await create(s, 'p');
  s.tables.cliCredentials.set('cred', {
    _id: 'cred',
    _creationTime: 1,
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'test',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    revoked: false,
    scope: 'cli',
    settings: { projects: { kind: 'all' } },
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'synthetic-device' });
  const input = { ...op(s, 'p'), name: 'Forge Next', slug: 'forge-next' };
  const held = JSON.parse(await lifecycle.rename._handler(s.ctx, input));
  assert.equal(held.rule, 'held');
  assert.equal(held.status, 'requested');
  assert.equal(project(s, 'p').slug, 'forge', 'nothing changes before the owner grants');
  assert.equal(await at(s, 'forge-next'), null);
  // A retry replays the same request; a changed retry under the same operation is refused.
  assert.equal(JSON.parse(await lifecycle.rename._handler(s.ctx, input)).id, held.id);
  await assert.rejects(
    lifecycle.rename._handler(s.ctx, { ...input, slug: 'other' }),
    e => e.data?.code === 'WORK_OPERATION_CHANGED',
  );
  // The agent cannot grant its own request.
  const row = [...s.tables.projectHostedApprovals.values()][0];
  const grant = {
    projectId: 'p',
    laneId: row.laneId,
    head: row.head,
    operationId: randomUUID(),
    decision: 'grant',
  };
  await assert.rejects(approvals.decide._handler(s.ctx, grant));
  assert.equal(project(s, 'p').slug, 'forge');
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const decided = JSON.parse(await approvals.decide._handler(s.ctx, grant));
  assert.equal(decided.approval.status, 'granted');
  assert.equal(decided.applied.slug, 'forge-next');
  assert.equal(project(s, 'p').name, 'Forge Next');
  assert.equal((await at(s, 'forge')).slug, 'forge-next', 'the old address redirects');
});

test('an unknown address is not found, never a near match', async () => {
  const s = fixture();
  await create(s, 'p');
  await create(s, 'q');
  await lifecycle.trash._handler(s.ctx, op(s, 'p'));
  for (const slug of ['forge', 'forge-3', 'forg', 'forge-2-x']) assert.equal(await at(s, slug), null, slug);
  assert.equal((await at(s, 'forge-2')).id, 'q');
});

/** The owner's own CLI sign-in: a device identity, so its renames are held for the owner person. */
function asAgent(s) {
  s.tables.cliCredentials.set('cred', {
    _id: 'cred',
    _creationTime: 1,
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'test',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    revoked: false,
    scope: 'cli',
    settings: { projects: { kind: 'all' } },
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'synthetic-device' });
}
const asOwner = s => (s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' }));
const heldRow = s => [...s.tables.projectHostedApprovals.values()].find(r => r.setting?.origin === 'address');
/** The owner's grant of the address request as it stands now (the head they reviewed). */
const grantOf = s => ({
  projectId: 'p',
  laneId: heldRow(s).laneId,
  head: heldRow(s).head,
  operationId: randomUUID(),
  decision: 'grant',
});
const named = code => e => e.data?.code === code || e.code === code;
const slugsOf = (s, id) =>
  [...s.tables.projectSlugs.values()].filter(r => r.projectId === id).map(r => r.slug);

test('review 1: a grant applies only the before -> after it showed; an intervening rename makes it fail by name', async () => {
  const s = fixture();
  await create(s, 'p');
  asAgent(s);
  // Name only (slug omitted): the request resolves the address it keeps.
  await lifecycle.rename._handler(s.ctx, { ...op(s, 'p'), name: 'Requested' });
  const shown = await compare.settingCompare(s.ctx, project(s, 'p'), heldRow(s));
  assert.deepEqual(shown, {
    before: { name: 'Forge', slug: 'forge' },
    after: { name: 'Requested', slug: 'forge' },
  });
  const grant = grantOf(s);
  asOwner(s);
  await lifecycle.rename._handler(s.ctx, { ...op(s, 'p'), name: 'Intervening', slug: 'intervening' });
  const revision = project(s, 'p').revision;
  // The approve page still shows what the request was made against, and the grant refuses it.
  assert.deepEqual(await compare.settingCompare(s.ctx, project(s, 'p'), heldRow(s)), shown);
  await assert.rejects(approvals.decide._handler(s.ctx, grant), named('WORK_STALE'));
  assert.equal(project(s, 'p').name, 'Intervening');
  assert.equal(project(s, 'p').slug, 'intervening');
  assert.equal(project(s, 'p').revision, revision);
  assert.equal(heldRow(s).status, 'requested', 'nothing was granted');
});

test('review 1: a request made at an older revision is refused before it is held', async () => {
  const s = fixture();
  await create(s, 'p');
  const old = op(s, 'p');
  await lifecycle.rename._handler(s.ctx, { ...op(s, 'p'), name: 'Owner' });
  asAgent(s);
  await assert.rejects(lifecycle.rename._handler(s.ctx, { ...old, name: 'Agent' }), named('WORK_STALE'));
  assert.equal(heldRow(s), undefined);
});

test('review 2: an old request and its old grant apply at most once, even replayed after a newer rename', async () => {
  const s = fixture();
  await create(s, 'p');
  asAgent(s);
  const a = { ...op(s, 'p'), name: 'Alpha', slug: 'alpha' };
  await lifecycle.rename._handler(s.ctx, a);
  const grantA = grantOf(s);
  asOwner(s);
  await approvals.decide._handler(s.ctx, grantA);
  assert.equal(project(s, 'p').slug, 'alpha');
  // Immediate replays of the request and the grant change nothing.
  const afterA = project(s, 'p').revision;
  asAgent(s);
  assert.equal(JSON.parse(await lifecycle.rename._handler(s.ctx, a)).status, 'granted');
  asOwner(s);
  await approvals.decide._handler(s.ctx, grantA);
  assert.equal(project(s, 'p').revision, afterA);
  // B, then the exact original A request and the exact original A grant.
  asAgent(s);
  const b = { ...op(s, 'p'), name: 'Beta', slug: 'beta' };
  await lifecycle.rename._handler(s.ctx, b);
  const grantB = grantOf(s);
  asOwner(s);
  await approvals.decide._handler(s.ctx, grantB);
  const afterB = project(s, 'p').revision;
  asAgent(s);
  await assert.rejects(lifecycle.rename._handler(s.ctx, a), named('WORK_STALE'));
  assert.equal(heldRow(s).operationId, b.operationId);
  assert.equal(heldRow(s).status, 'granted', 'the old request is not reopened');
  asOwner(s);
  await assert.rejects(approvals.decide._handler(s.ctx, grantA));
  await approvals.decide._handler(s.ctx, grantB);
  assert.equal(project(s, 'p').name, 'Beta');
  assert.equal(project(s, 'p').slug, 'beta');
  assert.equal(project(s, 'p').revision, afterB);
});

test('review 3: a retried restore returns the same moved address and changes nothing', async () => {
  const s = fixture();
  await create(s, 'old');
  await lifecycle.trash._handler(s.ctx, op(s, 'old'));
  await create(s, 'new');
  const input = op(s, 'old');
  const first = await lifecycle.restore._handler(s.ctx, input);
  assert.deepEqual([first.slug, first.previousSlug], ['forge-2', 'forge']);
  const revision = project(s, 'old').revision;
  const aliases = JSON.stringify([...s.tables.projectSlugs.values()]);
  assert.deepEqual(await lifecycle.restore._handler(s.ctx, input), first, 'the response may have been lost');
  assert.equal(project(s, 'old').revision, revision);
  assert.equal(JSON.stringify([...s.tables.projectSlugs.values()]), aliases);
  await assert.rejects(
    lifecycle.restore._handler(s.ctx, { ...input, expectedRevision: input.expectedRevision + 1 }),
    named('WORK_OPERATION_CHANGED'),
  );
});

test('review 4: a project keeps its 10 most recent addresses; older ones answer not found; purge releases them', async () => {
  const s = fixture();
  await create(s, 'p');
  const rename = slug => lifecycle.rename._handler(s.ctx, { ...op(s, 'p'), name: 'Forge', slug });
  for (let i = 1; i <= 12; i++) await rename(`forge-v${i}`);
  // forge-v12 is current; forge-v3..v11 still redirect; forge and forge-v1, v2 are released.
  assert.equal(slugsOf(s, 'p').length, identity.PROJECT_ALIASES);
  for (const slug of ['forge', 'forge-v1', 'forge-v2']) assert.equal(await at(s, slug), null, slug);
  for (let i = 3; i <= 12; i++) assert.equal((await at(s, `forge-v${i}`)).slug, 'forge-v12', `forge-v${i}`);
  // Moving back to a kept alias makes it the newest again rather than adding a row.
  await rename('forge-v3');
  assert.equal(slugsOf(s, 'p').length, identity.PROJECT_ALIASES);
  await rename('forge-v13');
  assert.equal((await at(s, 'forge-v3')).slug, 'forge-v13', 'the re-used address is recent again');
  assert.equal(await at(s, 'forge-v4'), null, 'the oldest kept one is released');
  // A released address is free for another project.
  await create(s, 'q');
  await lifecycle.rename._handler(s.ctx, { ...op(s, 'q'), name: 'Forge', slug: 'forge-v1' });
  assert.equal((await at(s, 'forge-v1')).id, 'q');
  // Permanent deletion purges a project's aliases with its rows (tests/project-purge-inventory.test.mjs).
  assert.equal(purge.projectPurgeTables.projectSlugs, 'by_project');
});

/** A history written before the cap: `n` alias rows for the project, oldest first, the current slug newest. */
function history(s, id, n) {
  for (const row of [...s.tables.projectSlugs.values()].filter(r => r.projectId === id))
    s.tables.projectSlugs.delete(row._id);
  for (let i = 0; i < n; i++)
    s.tables.projectSlugs.set(`old-${id}-${i}`, {
      _id: `old-${id}-${i}`,
      _creationTime: 1_000 + i,
      owner: 'owner',
      slug: `${id}-a${i}`,
      projectId: id,
    });
  s.tables.hostedProjects.set(id, { ...project(s, id), slug: `${id}-a${n - 1}` });
}
async function settle(s) {
  let runs = 0;
  while (s.scheduled.length) {
    const task = s.scheduled.shift();
    const [file, name] = getFunctionName(task.fn).split(':');
    assert.equal(file, 'projectAliases');
    await s.transaction(() => aliases[name]._handler(s.ctx, task.args));
    runs++;
  }
  return runs;
}
const newestTen = (s, id, n) => Array.from({ length: 10 }, (_, i) => `${id}-a${n - 10 + i}`).sort();

test('review: a no-op rename on a 250-alias history keeps the true newest 10, deleting from the oldest end', async () => {
  const s = fixture();
  await create(s, 'p');
  history(s, 'p', 250);
  // Name only: the current address is already the newest, so nothing is claimed, but the cap still applies.
  await lifecycle.rename._handler(s.ctx, { ...op(s, 'p'), name: 'Renamed' });
  assert.equal(slugsOf(s, 'p').length, 150, 'one trim page (100) in the rename itself');
  assert.ok(slugsOf(s, 'p').includes('p-a249'));
  assert.ok(!slugsOf(s, 'p').includes('p-a99'), 'the oldest go first');
  assert.equal(await settle(s), 2);
  assert.deepEqual(slugsOf(s, 'p').sort(), newestTen(s, 'p', 250));
  assert.equal((await at(s, 'p-a240')).slug, 'p-a249');
  assert.equal(await at(s, 'p-a239'), null);
});

test('review: the one-time migration trims every pre-cap history by cursor and a rerun writes nothing', async () => {
  const s = fixture();
  for (const [id, n] of [
    ['p', 130],
    ['q', 9],
    ['r', 10],
    ['t', 11],
  ]) {
    await create(s, id);
    history(s, id, n);
  }
  const run = async () => {
    let cursor = null;
    for (let runs = 1; ; runs++) {
      const result = await s.transaction(() => aliases.trimAll._handler(s.ctx, { cursor }));
      const next = s.scheduled.findIndex(t => getFunctionName(t.fn).endsWith(':trimAll'));
      if (result.isDone) return runs;
      cursor = s.scheduled.splice(next, 1)[0].args.cursor;
    }
  };
  await run();
  await settle(s);
  assert.deepEqual(slugsOf(s, 'p').sort(), newestTen(s, 'p', 130));
  assert.equal(slugsOf(s, 'q').length, 9);
  assert.equal(slugsOf(s, 'r').length, 10);
  assert.deepEqual(slugsOf(s, 't').sort(), newestTen(s, 't', 11));
  const before = JSON.stringify([...s.tables.projectSlugs.entries()]);
  await run();
  assert.equal(await settle(s), 0);
  assert.equal(JSON.stringify([...s.tables.projectSlugs.entries()]), before, 'a rerun writes nothing');
});

test('review: project slugs are at most 100 characters at rename, and a derived one at create is cut to fit', async () => {
  const s = fixture();
  await create(s, 'p');
  const long = 'a'.repeat(101);
  await assert.rejects(lifecycle.rename._handler(s.ctx, { ...op(s, 'p'), name: 'Forge', slug: long }), e =>
    /at most 100 characters/.test(e.data?.message ?? e.message),
  );
  await lifecycle.rename._handler(s.ctx, { ...op(s, 'p'), name: 'Forge', slug: 'a'.repeat(100) });
  assert.equal(project(s, 'p').slug.length, 100);
  s.tables.hostedProjects.set(
    'w',
    projectRow({ _id: 'w', _creationTime: 99, name: 'word '.repeat(60), key: 'key-w' }),
  );
  assert.ok((await identity.ensureProjectSlug(s.ctx, project(s, 'w'))).length <= 100);
});

test('review: per-project alias budget at the cap (10 rows, 100-character slugs, both indexes)', () => {
  // Provider-shaped sizes: 32-character ids, a 70-character owner subject, 8-byte creation time.
  const id = 'x'.repeat(32);
  const owner = 'o'.repeat(70);
  const row = { _id: id, _creationTime: 1_800_000_000_000.5, owner, slug: 's'.repeat(100), projectId: id };
  const document = JSON.stringify(row).length;
  const byOwnerAndSlug = owner.length + 100 + 8 + id.length;
  const byProject = id.length + 8 + id.length;
  const perProject = 10 * (document + byOwnerAndSlug + byProject);
  assert.ok(
    document <= 320 && byOwnerAndSlug + byProject <= 300,
    JSON.stringify({ document, byOwnerAndSlug, byProject }),
  );
  assert.ok(perProject <= 6_000, `per-project alias budget ${perProject} B (docs/data-placement.md)`);
});
