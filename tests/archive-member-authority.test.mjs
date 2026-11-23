// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { state, projectRow, backupRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const modules = Object.fromEntries(
  await Promise.all(
    ['projectBackups', 'backupTransfer', 'projectExchangeActions', 'projectObjects'].map(async name => [
      name,
      await import(moduleUrl(`../convex/${name}.ts`)),
    ]),
  ),
);
const denied = error => error.data?.code === 'PROJECT_UNAVAILABLE';
function fixture() {
  const s = state([]),
    native = s.ctx.runQuery;
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [m, n] = getFunctionName(ref).split(':');
    return modules[m]?.[n]?._handler(s.ctx, args) ?? native(ref, args);
  };
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project', visibility: 'public' }));
  s.tables.projectBackups.set(
    'backup',
    backupRow({ _id: 'backup', projectId: 'project', transport: 'objects' }),
  );
  s.tables.projectContributors.set('writer', { _id: 'writer', projectId: 'project', contributor: 'writer' });
  s.tables.projectReaders.set('reader', { _id: 'reader', projectId: 'project', reader: 'reader' });
  return s;
}
for (const actor of ['stranger', 'reader'])
  test(`public project archives are unavailable to ${actor}`, async () => {
    const s = fixture();
    s.caller(actor);
    for (const [m, n, args] of [
      ['projectBackups', 'history', { projectId: 'project', paginationOpts: { cursor: null, numItems: 10 } }],
      ['projectBackups', 'get', { id: 'backup', owner: actor }],
      ['backupTransfer', 'sign', { id: 'backup', digest: s.tables.projectBackups.get('backup').digest }],
      ['projectExchangeActions', 'checkpoint', { backupId: 'backup' }],
      ['projectExchangeActions', 'manifest', { backupId: 'backup' }],
      ['projectExchangeActions', 'downloadPart', { projectId: 'project', digest: 'a'.repeat(64), offset: 0 }],
      ['projectExchangeActions', 'downloadBatch', { projectId: 'project', digests: ['a'.repeat(64)] }],
    ])
      await assert.rejects(modules[m][n]._handler(s.ctx, args), denied, `${m}:${n}`);
  });
test('owner and contributor keep archive metadata access', async () => {
  const s = fixture();
  for (const actor of ['owner', 'writer']) {
    s.caller(actor);
    assert.equal(
      (
        await modules.projectBackups.history._handler(s.ctx, {
          projectId: 'project',
          paginationOpts: { cursor: null, numItems: 10 },
        })
      ).page.length,
      1,
    );
    assert.equal(
      (await modules.projectBackups.get._handler(s.ctx, { id: 'backup', owner: actor })).backup._id,
      'backup',
    );
  }
});

test('checkpoint reads recheck membership after object IO even when source is public', async () => {
  const { fixture: exchangeFixture, legacyObject } = await import('./project-exchange-fixture.mjs');
  const s = exchangeFixture(),
    bytes = Buffer.from('{"synthetic":"work metadata"}');
  const pin = await legacyObject(s, bytes);
  s.tables.hostedProjects.get('project').visibility = 'public';
  s.tables.projectContributors.set('writer', { _id: 'writer', projectId: 'project', contributor: 'writer' });
  s.tables.projectBackups.set(
    'backup',
    backupRow({
      _id: 'backup',
      projectId: 'project',
      transport: 'objects',
      digest: pin.sha256,
      size: pin.size,
    }),
  );
  s.caller('writer');
  const read = s.ctx.storage.get;
  s.ctx.storage.get = async id => {
    const result = await read(id);
    s.tables.projectContributors.delete('writer');
    return result;
  };
  await assert.rejects(
    modules.projectExchangeActions.checkpoint._handler(s.ctx, { backupId: 'backup' }),
    denied,
  );
});
