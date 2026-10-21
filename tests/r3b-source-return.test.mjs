// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { setup, client } from './r2-harness.mjs';
import { modules, fixture, checkpoint, preparedCheckpoint, upload } from './project-exchange-fixture.mjs';
import { land } from './source-landings-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { pushNativeExchange } from '../dist/native-exchange.js';
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const progress = await import(moduleUrl('../convex/projectSourceReturnProgress.ts'));
const cursors = await import(moduleUrl('../convex/projectSourceReturnCursor.ts'));
async function initialize(s, backupId) {
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  return index.ensure._handler(s.ctx, { projectId: 'project' });
}
for (const interrupted of [false, true])
  test(`R3b metadata return reads no storage, including cold resume (${interrupted})`, async t => {
    const { s, fake } = await setup(t),
      dir = mkdtempSync(join(tmpdir(), 'forge-r3b-')),
      root = join(dir, 'owner');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(root);
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    initNative(root);
    const store = new WorkStore(root),
      first = client(s);
    const base = await pushNativeExchange(store, store.revision(), first.operationId, first);
    await initialize(s, base.backupId);
    land(store, 4);
    const sender = client(s);
    sender.previous = base.backupId;
    const candidate = await pushNativeExchange(store, store.revision(), sender.operationId, sender);
    if (!interrupted) {
      const { source } = await import(moduleUrl('../convex/projectWorkLoad.ts'));
      s.tables.projectContributors.set('grant', {
        _id: 'grant',
        projectId: 'project',
        contributor: 'contributor',
      });
      s.caller('contributor');
      const shared = await source(s.ctx, base.backupId, 'contributor');
      assert.equal(
        shared.backup._id,
        base.backupId,
        'owner-only metadata sessions do not narrow existing source access',
      );
      s.caller('owner');
    }
    const args = {
      projectId: 'project',
      backupId: candidate.backupId,
      expectedBackupId: base.backupId,
      revision: 0,
      operationId: randomUUID(),
      continuation: true,
    };
    const savedBudget = { ...progress.RETURN_BUDGET };
    if (interrupted) Object.assign(progress.RETURN_BUDGET, { rows: 3, actionSteps: 1, commitMs: 0 });
    t.after(() => Object.assign(progress.RETURN_BUDGET, savedBudget));
    let reads = 0,
      writes = 0,
      lost = false;
    const get = s.ctx.storage.get,
      put = s.ctx.storage.store,
      mutate = s.ctx.runMutation;
    s.ctx.storage.get = (...a) => {
      reads++;
      return get(...a);
    };
    s.ctx.storage.store = (...a) => {
      writes++;
      return put(...a);
    };
    const gets = fake.requests.filter(r => r.method === 'GET').length;
    if (!interrupted) {
      const row = s.tables.projectBackups.get(candidate.backupId);
      const session = s.tables.projectPublications.get(row.metadataPublication);
      session.validated = false;
      await assert.rejects(
        modules.projectSourceReturn.returnSource._handler(s.ctx, args),
        e => e.data?.code === 'INVALID_WORK_BACKUP',
      );
      session.validated = true;
      const original = row.metadataPublication;
      row.metadataPublication = s.tables.projectBackups.get(base.backupId).metadataPublication;
      await assert.rejects(
        modules.projectSourceReturn.returnSource._handler(s.ctx, args),
        e => e.data?.code === 'INVALID_WORK_BACKUP',
      );
      row.metadataPublication = original;
      s.caller('stranger');
      await assert.rejects(
        modules.projectSourceReturn.returnSource._handler(s.ctx, args),
        e => e.data?.code === 'PROJECT_UNAVAILABLE',
      );
      s.caller('owner');
      assert.equal(reads, 0, 'authority/session failures do not read stored bytes');
    }

    s.ctx.runMutation = async (ref, input) => {
      const result = await mutate(ref, input);
      if (interrupted && !lost && getFunctionName(ref) === 'projectReturnIndexStage:batch') {
        lost = true;
        throw Error('lost metadata cursor commit reply');
      }
      return result;
    };
    if (interrupted) {
      await assert.rejects(
        modules.projectSourceReturn.returnSource._handler(s.ctx, args),
        e => e.data?.code === 'HOSTED_REQUEST_FAILED',
      );
      const paused = [...s.tables.projectWorkGenerations.values()].find(
        g => g.returnOperationId === args.operationId,
      );
      assert.equal(paused.status, 'building', 'interruption occurred before the phase output completed');
      assert.ok(paused.returnMetadataCursor);
      cursors.forgetReturnCursors();
    }
    let result;
    do {
      result = await modules.projectSourceReturn.returnSource._handler(s.ctx, args);
    } while (result.pending);
    assert.equal(lost, interrupted);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.equal(fake.requests.filter(r => r.method === 'GET').length - gets, 0);
    assert.equal(result.accounting.storageReads, 0);
    assert.equal(result.accounting.storageBytes, 0);
    assert.ok(s.tables.projectReturnPages.size > 0);
    const stage = [...s.tables.projectWorkGenerations.values()].find(
      g => g.returnOperationId === args.operationId,
    );
    assert.equal(stage.returnMetadataCursor, undefined, 'published cursor released like the old blob cursor');
    assert.equal(stage.returnCursor, undefined);
    const replay = await modules.projectSourceReturn.returnSource._handler(s.ctx, args);
    const receipt = { ...result };
    delete receipt.accounting;
    assert.deepEqual(replay, receipt);
    await assert.rejects(
      modules.projectSourceReturn.returnSource._handler(s.ctx, { ...args, revision: 1 }),
      e => e.data?.code === 'WORK_OPERATION_CHANGED',
    );
    console.log('R3B_STORAGE', JSON.stringify({ interrupted, reads, writes, accounting: result.accounting }));
  });

for (const missing of ['baseline Work', 'View', 'comparison'])
  test(`partial owner coverage derives only missing ${missing}`, async t => {
    const s = fixture(),
      base = await checkpoint(t, s);
    const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, base.input);
    await initialize(s, backupId);
    land(base.store, 4);
    const next = await preparedCheckpoint(s, base.store);
    next.input.previous = backupId;
    const candidate = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
    const { ownerDerivedBytes } = await import('../dist/owner-derived-local.js');
    const bytes = ownerDerivedBytes(base.store, base.store.load(), { states: new Set(), data: undefined });
    assert.ok(bytes, 'missing exact baseline Work supplies full facts instead of omitting the sidecar');
    const derived = JSON.parse(bytes);
    const missingView = missing === 'View' ? derived.views.pop()[0] : undefined;
    if (missing === 'comparison') derived.stats.pop();
    const pin = await upload(s, Buffer.from(JSON.stringify(derived)));
    let compared = 0;
    const action = s.ctx.runAction;
    s.ctx.runAction = (ref, args) => {
      if (getFunctionName(ref) === 'projectDiffstats:compare') compared++;
      return action(ref, args);
    };
    const args = {
      projectId: 'project',
      backupId: candidate,
      expectedBackupId: backupId,
      revision: 0,
      operationId: randomUUID(),
      ownerDerived: pin,
      continuation: true,
    };
    let result;
    do {
      result = await modules.projectSourceReturn.returnSource._handler(s.ctx, args);
    } while (result.pending);
    assert.equal(compared, missing === 'comparison' ? 1 : 0, 'only the missing comparison is computed');
    const rows = [...s.tables.projectWorkRecords.values()];
    for (const view of base.store.load().views) {
      const row = rows.find(r => r.collection === 'viewDetails' && r.key === view.id);
      assert.equal(
        JSON.parse(row.value).provenanceAvailable,
        true,
        view.id === missingView ? 'missing View derived on server' : 'covered View retained',
      );
    }
  });

test('ancestry checkpoints inside one deep head and CLI renders its inner progress', async () => {
  const { advance, RETURN_BUDGET } = await import(moduleUrl('../convex/projectSourceReturnStep.ts'));
  const { formatSourceReturnProgress } = await import('../dist/source-return-progress.js');
  const parents = Array.from({ length: 3001 }, (_, i) => [String(i), i ? [String(i - 1)] : []]);
  const c = {
    snapshot: { data: {}, manifest: { files: [] }, backup: {} },
    final: {},
    phase: 'ancestry',
    heads: ['3000'],
    head: 0,
    parents,
    rows: [],
    delta: {},
    positions: [],
    states: [],
    pending: [],
  };
  const first = await advance({}, c);
  assert.equal(c.head, 0);
  assert.equal(c.ancestryProgress.seen.length, RETURN_BUDGET.ancestryItems);
  assert.equal(first.last, false);
  const resumed = structuredClone(c);
  for (let i = 0; i < 10 && resumed.head === 0; i++) await advance({}, resumed);
  assert.equal(resumed.head, 1);
  assert.equal(resumed.ancestryProgress, undefined);
  assert.match(
    formatSourceReturnProgress({
      phase: 'ancestry',
      done: 0,
      total: 1,
      step: 1,
      elapsedMs: 30000,
      etaSeconds: null,
      resumed: false,
      itemDone: 1000,
      itemPending: 1,
    }),
    /current item 1000 visited, 1 pending/,
  );
});

test('simultaneous public returns replay the winner when preparation races publication', async t => {
  const s = fixture(),
    base = await checkpoint(t, s);
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, base.input);
  await initialize(s, backupId);
  land(base.store, 2);
  const next = await preparedCheckpoint(s, base.store);
  next.input.previous = backupId;
  const candidate = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
  const args = {
    projectId: 'project',
    backupId: candidate,
    expectedBackupId: backupId,
    revision: 0,
    operationId: randomUUID(),
    continuation: true,
  };
  const mutate = s.ctx.runMutation;
  let enter,
    release,
    held = false;
  const entered = new Promise(resolve => {
    enter = resolve;
  });
  const wait = new Promise(resolve => {
    release = resolve;
  });
  s.ctx.runMutation = async (ref, input) => {
    if (getFunctionName(ref) === 'projectReturnIndexStage:begin' && !held) {
      held = true;
      enter();
      await wait;
    }
    return mutate(ref, input);
  };
  const duplicate = modules.projectSourceReturn.returnSource._handler(s.ctx, args);
  await entered;
  let receipt;
  do {
    receipt = await modules.projectSourceReturn.returnSource._handler(s.ctx, args);
  } while (receipt.pending);
  release();
  const { accounting: _accounting, ...stored } = receipt;
  assert.deepEqual(await duplicate, stored);
  assert.equal(
    [...s.tables.projectWorkEvents.values()].filter(e => e.operationId === args.operationId).length,
    1,
  );
  await assert.rejects(
    modules.projectSourceReturn.returnSource._handler(s.ctx, { ...args, revision: 1 }),
    e => e.data?.code === 'WORK_OPERATION_CHANGED',
  );
});
