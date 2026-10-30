// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { cutoverFixture, discovery, legacy } from './source-cutover-fixture.mjs';
import { requireCutoverVersion } from '../dist/cutover-version.js';
const code = expected => e => (e.data?.code ?? e.code) === expected;
const setup = async () => cutoverFixture(await acceptanceFixture());

test('dry-run writes nothing; atomic cutover keeps main identity, changes epoch and records metric-7 time', async () => {
  const f = await setup(),
    before = structuredClone(f.tables);
  const plan = await f.dryRun();
  assert.deepEqual(f.tables, before);
  assert.equal(plan.at, undefined);
  assert.equal(plan.minimumCliVersion, '0.3.1');
  const result = await f.applyCutover();
  assert.equal(result.metric7, 'cache-behind-hosted');
  assert(Number.isFinite(Date.parse(result.at)));
  assert.deepEqual(result.authority, { mode: 'server', epoch: 1 });
  assert.equal(result.main.head, plan.previous.main.head);
  assert.equal(result.main.receipt.id, plan.previous.main.receipt.id);
  assert.deepEqual(f.currentMain(), result.main);
  assert.deepEqual(await f.applyCutover(), result);
  assert.equal(f.tables.projectSourceCutovers.size, 1);
  const reverse = { operationId: randomUUID(), mode: 'native-owner', pins: await f.pins() };
  assert.deepEqual((await f.applyCutover(reverse)).authority, { mode: 'native-owner', epoch: 2 });
  assert.equal(f.currentMain().authority.epoch, 2);
  assert.deepEqual(await f.applyCutover(), result, 'original receipt survives rollback');
  await assert.rejects(
    f.applyCutover({ ...f.cutoverRequest, mode: 'native-owner' }),
    code('WORK_OPERATION_CHANGED'),
  );
});

for (const pin of ['receipt', 'head', 'backup', 'revision', 'journal'])
  test(`cutover rejects a changed ${pin} pin without publishing authority`, async () => {
    const f = await setup();
    if (pin === 'receipt')
      f.patch('projectHostedChannels', f.mainId, {
        selection: JSON.stringify({ ...f.main, receipt: { ...f.main.receipt, id: randomUUID() } }),
      });
    if (pin === 'head')
      f.patch('projectHostedChannels', f.mainId, {
        selection: JSON.stringify({ ...f.main, head: 'b'.repeat(64) }),
      });
    if (pin === 'backup')
      f.patch('projectBackups', f.cutoverRequest.pins.backupId, { digest: 'c'.repeat(64) });
    if (pin === 'revision') f.patch('hostedProjects', f.projectId, { revision: 2 });
    if (pin === 'journal')
      f.insert('projectWorkHeads', {
        projectId: f.projectId,
        backupId: f.cutoverRequest.pins.backupId,
        revision: 1,
      });
    await assert.rejects(f.applyCutover(), code('CHANNEL_CHANGED'));
    assert.equal(f.tables.projectSourceCutovers.size, 0);
    assert.equal(f.tables.hostedProjects.get(f.projectId).sourceAuthority.mode, 'native-owner');
  });

for (const phase of ['queued', 'checking', 'ready'])
  test(`forward and reverse cutover retain a ${phase} hosted request`, async () => {
    const f = await setup();
    await f.applyCutover();
    const reverse = { operationId: randomUUID(), mode: 'native-owner', pins: await f.pins() };
    f.insert('projectHostedLandingRequests', {
      projectId: f.projectId,
      channel: 'main',
      sequence: 1,
      phase,
      submissionId: 'submission',
      operationId: randomUUID(),
      actor: 'owner',
      runnable: false,
      runId: null,
      attemptId: 'attempt',
      value: '{}',
    });
    await assert.rejects(f.applyCutover(reverse), code('SOURCE_AUTHORITY_DRAIN_REQUIRED'));
    assert.equal(f.tables.hostedProjects.get(f.projectId).sourceAuthority.mode, 'server');
    assert.equal(f.tables.projectHostedLandingRequests.size, 1);
  });

test('an atomic receipt failure rolls back both authority and main pins', async () => {
  const f = await setup(),
    before = structuredClone(f.tables);
  f.decorateContext(ctx => {
    ctx.db.insert = async () => {
      throw Error('synthetic receipt failure');
    };
  });
  await assert.rejects(f.applyCutover(), code('HOSTED_REQUEST_FAILED'));
  assert.deepEqual(f.tables, before);
});

for (const actor of [null, 'stranger'])
  test(`cutover requires existing owner authority (${actor})`, async () => {
    const f = await setup();
    await assert.rejects(f.dryRun(f.cutoverRequest, actor), code('PROJECT_UNAVAILABLE'));
    await assert.rejects(f.applyCutover(f.cutoverRequest, actor), code('PROJECT_UNAVAILABLE'));
  });

test('version comparison handles numeric components and refuses missing/malformed prereleases', () => {
  for (const value of ['0.3.1', '0.3.10', '0.10.0', '1.0.0']) requireCutoverVersion(value);
  for (const value of [undefined, '0.3.0', '0.2.99', '0.3.1-beta', 'bad'])
    assert.throws(() => requireCutoverVersion(value), code('CLI_UPGRADE_REQUIRED'));
});

test('concurrent cutovers have one CAS winner; retries of one UUID reconcile the same receipt', async () => {
  const f = await setup();
  const results = await Promise.all([f.applyCutover(), f.applyCutover()]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.tables.projectSourceCutovers.size, 1);
  const g = await setup();
  const outcomes = await Promise.allSettled([
    g.applyCutover(),
    g.applyCutover({ ...g.cutoverRequest, operationId: randomUUID() }),
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(r => r.status === 'rejected').reason.data.code, 'SOURCE_AUTHORITY_STALE');
  assert.equal(g.tables.projectSourceCutovers.size, 1);
});

test('a cut-over project cannot bypass pinned rollback through the old mode-only mutation', async () => {
  const f = await setup();
  await f.applyCutover();
  const authority = await import(
    (await import('./convex-module.mjs')).moduleUrl('../convex/projectSourceAuthority.ts')
  );
  await assert.rejects(
    f.cutoverCall('modeOnly', authority.transition, {
      operationId: randomUUID(),
      expected: { mode: 'server', epoch: 1 },
      mode: 'native-owner',
    }),
    code('SOURCE_AUTHORITY_PIN_REQUIRED'),
  );
});

test('old CLI gets one actionable structured error; current/new CLI and native-owner discovery stay available', async () => {
  const f = await setup();
  const discover = clientVersion =>
    f.cutoverCall('capabilities', discovery.capabilities, { ...(clientVersion ? { clientVersion } : {}) });
  await discover(); // bound does not imply hosted authority
  await f.applyCutover();
  for (const version of [undefined, '0.2.9', '0.3.0'])
    await assert.rejects(discover(version), e => {
      assert.equal(e.data.code, 'CLI_UPGRADE_REQUIRED');
      assert.match(e.data.message, /nforge to 0\.3\.1/);
      assert.match(e.data.message, /npm install -g/);
      return true;
    });
  for (const version of ['0.3.1', '0.4.0', '1.0.0'])
    assert.equal(JSON.parse(await discover(version)).authority.mode, 'server');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  await f.applyCutover({ operationId: randomUUID(), mode: 'native-owner', pins: await f.pins() });
  assert.equal(
    JSON.parse(await discover('0.3.0')).authority.mode,
    'native-owner',
    'rollback/native authority does not acquire a hosted-only version restriction',
  );
});
