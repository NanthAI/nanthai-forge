// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { recoveryFixture } from './recovery-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { cutoverFixture, cutover } from './source-cutover-fixture.mjs';
import { boundCutoverPins, cutoverBoundProject } from '../dist/source-cutover-client.js';
import { readHostState, updateHostState } from '../dist/host-binding.js';
async function setup(t) {
  const r = await recoveryFixture(t),
    base = await acceptanceFixture();
  Object.assign(base.main, {
    head: r.main.head,
    receipt: { id: r.main.id, kind: 'native', previousHead: null, previousReceiptId: null },
  });
  const f = await cutoverFixture(base),
    store = r.work.store;
  f.patch('projectBackups', f.cutoverRequest.pins.backupId, {
    preview: { revision: store.revision(), channels: [{ name: 'main', head: r.main.head }] },
  });
  const request = { ...f.cutoverRequest, pins: await f.pins() };
  updateHostState(store, state => {
    state.binding = {
      projectId: f.projectId,
      deployment: 'https://fixture.convex.cloud',
      projectUrl: 'https://example.invalid/project',
      operationId: randomUUID(),
      name: 'Synthetic',
      visibility: 'private',
      backupId: request.pins.backupId,
      acceptanceOwner: true,
      autoSync: false,
    };
  });
  const call = (ref, args) =>
    f.cutoverCall('cutoverClient', cutover[getFunctionName(ref).split(':')[1]], args);
  return { r, f, store, request, client: { query: call, mutation: call } };
}
test('bound dry-run reads fresh authenticated pins and changes neither owner nor hosted data', async t => {
  const f = await setup(t),
    hosted = structuredClone(f.f.tables),
    local = readHostState(f.store);
  assert.deepEqual(await boundCutoverPins(f.store, f.client), f.request.pins);
  assert.equal((await cutoverBoundProject(f.store, f.request, true, f.client)).dryRun, true);
  assert.deepEqual(readHostState(f.store), local);
  assert.deepEqual(f.f.tables, hosted);
});
test('lost reply keeps exact handover marker; replay reconciles once and preserves later edits', async t => {
  const f = await setup(t);
  const client = {
    ...f.client,
    mutation: async (ref, args) => {
      assert.equal(readHostState(f.store).authorityTransition.operationId, f.request.operationId);
      await f.client.mutation(ref, args);
      throw Error('synthetic lost cutover reply');
    },
  };
  await assert.rejects(cutoverBoundProject(f.store, f.request, false, client));
  assert.equal(readHostState(f.store).binding.sourceAuthority, undefined);
  assert.deepEqual(readHostState(f.store).authorityTransition.cutover, f.request.pins);
  const path = join(f.r.root, 'later-edit.txt');
  writeFileSync(path, 'preserve draft');
  const data = f.store.load();
  data.revision++;
  f.store.save(data);
  const receipt = await cutoverBoundProject(f.store, f.request, false, f.client);
  assert.equal(f.f.tables.projectSourceCutovers.size, 1);
  assert.equal(readFileSync(path, 'utf8'), 'preserve draft');
  assert.equal(readHostState(f.store).authorityTransition, undefined);
  assert.deepEqual(readHostState(f.store).binding.sourceAuthority, receipt.authority);
  const reverse = { operationId: randomUUID(), mode: 'native-owner', pins: await f.f.pins() };
  const rollback = await cutoverBoundProject(f.store, reverse, false, f.client);
  assert.equal(rollback.authority.epoch, 2);
  await cutoverBoundProject(f.store, f.request, false, f.client);
  assert.equal(
    readHostState(f.store).binding.sourceAuthority.epoch,
    2,
    'historical replay cannot rewind binding',
  );
});
test('known local source revision drift permits fresh preparation without applying stale cutover', async t => {
  const f = await setup(t),
    data = f.store.load();
  data.revision++;
  f.store.save(data);
  await assert.rejects(cutoverBoundProject(f.store, f.request, false, f.client), { code: 'WORK_STALE' });
  assert.equal(f.f.tables.projectSourceCutovers.size, 0);
  assert.equal(readHostState(f.store).authorityTransition, undefined);
});

test('a failed dry-run preserves an existing handover marker and performs no local writes', async t => {
  const f = await setup(t);
  updateHostState(f.store, state => {
    state.authorityTransition = {
      projectId: f.f.projectId,
      deployment: 'https://fixture.convex.cloud',
      operationId: f.request.operationId,
      expected: f.request.pins.authority,
      mode: f.request.mode,
      cutover: f.request.pins,
    };
  });
  const before = readHostState(f.store);
  f.f.patch('hostedProjects', f.f.projectId, { revision: 2 });
  await assert.rejects(cutoverBoundProject(f.store, f.request, true, f.client), { code: 'CHANNEL_CHANGED' });
  assert.deepEqual(readHostState(f.store), before);
});
