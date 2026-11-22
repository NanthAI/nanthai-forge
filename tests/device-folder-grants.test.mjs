// SPDX-License-Identifier: Apache-2.0
// Issue df06081d (owner 2026-11-22): a device's folder grant writes only inside its folders of one project, ends
// 7 days after its last write or 30 days after it was given, renews on use at most hourly, and is refused once ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { storageClock } from './storage-clock.mjs';
import { api, saveFixture } from './hosted-saves-fixture.mjs';
import { saveBytes } from '../dist/hosted-save.js';
const policy = await import(moduleUrl('../convex/accessPolicy.ts'));
const authority = await import(moduleUrl('../convex/projectAuthority.ts'));

const code = value => error => (error.data?.code ?? error.code) === value;
const day = 86400000;
/** storageClock's fixed instant: the code under test reads the same clock. */
const NOW = Date.UTC(2026, 10, 10, 12);
const device = { subject: 'owner', forgeCredential: 'grant-device', forgeSignIn: 'grant-sign-in' };

/** The owner's agent device, limited to `paths` of the fixture project, with its grant clock. */
function grantDevice(f, paths, grant = { at: NOW, usedAt: NOW }) {
  f.insert('cliCredentials', {
    credentialId: device.forgeCredential,
    owner: 'owner',
    name: 'Agent sandbox',
    tokenHash: 'synthetic-hash',
    issuedAt: NOW,
    scope: 'cli',
    expiresAt: NOW + 30 * day,
    revoked: false,
    settings: {
      source: 'write',
      projects: { kind: 'project', projectId: f.projectId },
      ...(paths ? { paths } : {}),
    },
    ...(grant ? { grant } : {}),
  });
  return () => [...f.tables.cliCredentials.values()].find(row => row.credentialId === device.forgeCredential);
}
function added(f, path, text) {
  const pin = f.put(text);
  return {
    path,
    before: null,
    after: { blob: pin.sha256, mode: 'file', content: { object: pin, recipe: null } },
  };
}

test('df06081d: an agent grant scoped to one folder saves inside it and cannot save a file outside it', async t => {
  storageClock(t);
  const f = await saveFixture();
  grantDevice(f, ['docs/', 'README.md']);
  const inside = await f.prepare(
    [added(f, 'docs/guide.md', 'inside'), added(f, 'README.md', 'top')],
    {},
    device,
  );
  await f.stage(inside, device);
  const outside = await f.prepare(
    [added(f, 'docs/ok.md', 'ok'), added(f, 'web/app.ts', 'outside')],
    {},
    device,
  );
  const rows = () =>
    Object.entries(f.tables)
      .filter(([table]) => table !== 'projectObjects')
      .map(
        ([table, rows]) =>
          `${table}:${rows.size}:${JSON.stringify([...rows.values()], (_, v) => (typeof v === 'bigint' ? String(v) : v))}`,
      )
      .join('\n');
  for (const page of outside.pages) f.put(saveBytes(page.value));
  const before = rows();
  await assert.rejects(
    f.call(
      'stage',
      api.stage,
      {
        projectId: f.projectId,
        operationId: outside.request.operationId,
        index: 0,
        page: JSON.stringify(outside.pages[0].value),
      },
      device,
    ),
    error =>
      code('AUTH_SCOPE_DENIED')(error) &&
      /web\/app\.ts is outside its folder grant/.test(error.data?.message ?? error.message),
  );
  assert.equal(rows(), before, 'the refused save page writes nothing');
  // A prefix is a folder only with its slash: docs-old/ is not inside docs/.
  assert.equal(policy.grantAllows(['docs/'], 'docs-old/a.md'), false);
  // The same save from the person in a browser is not narrowed.
  const person = await f.prepare([added(f, 'web/app.ts', 'by hand')]);
  await f.stage(person);
});

test('df06081d: an expired folder grant fails with AUTH_EXPIRED: 7 days without a write, or 30 days after it was given', async t => {
  storageClock(t);
  const now = NOW;
  for (const [label, grant] of [
    ['unused for 7 days', { at: now - 8 * day, usedAt: now - 7 * day - 1000 }],
    [
      '30 days after it was given, despite daily writes',
      { at: now - 30 * day - 1000, usedAt: now - 3600_000 },
    ],
    ['no grant clock at all', null],
  ]) {
    const f = await saveFixture();
    grantDevice(f, ['docs/'], grant);
    await assert.rejects(
      f.prepare([added(f, 'docs/guide.md', 'late')], {}, device),
      error =>
        code('AUTH_EXPIRED')(error) &&
        /folder grant ended.*nforge login/.test(error.data?.message ?? error.message),
      label,
    );
  }
  const f = await saveFixture();
  grantDevice(f, ['docs/'], { at: now - 29 * day, usedAt: now - 6 * day });
  await f.prepare([added(f, 'docs/guide.md', 'in time')], {}, device);
  assert.equal(policy.grantEndsAt({ at: 0, usedAt: 0 }), 7 * day);
  assert.equal(policy.grantEndsAt({ at: 0, usedAt: 29 * day }), 30 * day);
});

test('df06081d: renewal on use writes at most once per grant per hour, and reads never write', async t => {
  storageClock(t);
  const now = NOW;
  const f = await saveFixture();
  const row = grantDevice(f, ['docs/'], { at: now - 2 * day, usedAt: now - 30 * 60_000 });
  const write = () =>
    f.call('write', { _handler: ctx => authority.activeProject(ctx, f.projectId, 'owner') }, {}, device);
  await write();
  assert.equal(row().grant.usedAt, now - 30 * 60_000, 'used within the hour: no write');
  f.patch('cliCredentials', row()._id, { grant: { at: now - 2 * day, usedAt: now - 2 * 3600_000 } });
  await f.call('read', { _handler: ctx => authority.memberProject(ctx, f.projectId, 'owner') }, {}, device);
  assert.equal(row().grant.usedAt, now - 2 * 3600_000, 'a read never renews or writes');
  await f.call(
    'twice',
    {
      _handler: async ctx => {
        await authority.activeProject(ctx, f.projectId, 'owner');
        await authority.activeProject(ctx, f.projectId, 'owner');
      },
    },
    {},
    device,
  );
  assert(row().grant.usedAt >= now, 'a write after an hour renews the grant');
  assert.equal(row().grant.at, now - 2 * day, 'renewal never moves the 30-day end');
  const writes = f.counts.filter(c => c.name === 'twice').reduce((sum, c) => sum + c.writes, 0);
  assert.equal(writes, 1, 'one renewal write in a transaction that checks twice');
});

test('df06081d: a folder grant cannot start a revert, whose files are known only after it runs (public mutations: tests/hosted-revert.test.mjs)', async t => {
  storageClock(t);
  const f = await saveFixture();
  grantDevice(f, ['docs/']);
  await assert.rejects(
    f.call('revert', { _handler: ctx => authority.refuseScopedRevert(ctx) }, {}, device),
    code('AUTH_SCOPE_DENIED'),
  );
  await f.call('revert by person', { _handler: ctx => authority.refuseScopedRevert(ctx) }, {});
});

test('df06081d: a folder grant names 1 to 20 safe folders or files of one selected project with write access', t => {
  storageClock(t);
  const settings = (paths, extra = {}) => ({
    source: 'write',
    projects: { kind: 'project', projectId: 'p' },
    paths,
    ...extra,
  });
  assert.deepEqual(Object.keys(policy.grantStamp(settings(['docs/', 'a.md']), 5).grant), ['at', 'usedAt']);
  assert.deepEqual(policy.grantStamp({ source: 'write', projects: { kind: 'all' } }), { grant: undefined });
  for (const bad of [
    settings([]),
    settings(['../up/']),
    settings(['/abs']),
    settings(['docs/', 'docs/']),
    settings(Array.from({ length: 21 }, (_, i) => `d${i}/`)),
    settings(['docs/'], { projects: { kind: 'all' } }),
    settings(['docs/'], { source: 'read' }),
  ])
    assert.throws(() => policy.grantStamp(bad), code('BAD_ARGUMENT'), JSON.stringify(bad));
});
