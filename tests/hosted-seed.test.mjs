// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fixture, modules, upload } from './project-exchange-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { prepareHostedSeed, seedHostedProject } from '../dist/hosted-seed.js';
import { SEED_EMPTY } from '../dist/hosted-seed-protocol.js';
import { digest } from '../dist/hash.js';
import { readRecoveryInventory } from '../dist/recovery-inventory.js';
import { storedBytes } from './default-r2.mjs';
for (const name of ['projectHostedSeed', 'projectHostedSeedActions'])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
function setup(t, count = 220) {
  const root = mkdtempSync(join('/tmp', 'forge-seed-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (let i = 0; i < count; i++) writeFileSync(join(root, `file-${i}.ts`), `export const value = ${i};\n`);
  initNative(root);
  const store = new WorkStore(root);
  new WorkService(root).execute(
    { action: 'intent', outcome: 'Synthetic seed records', constraints: 'Preserve exact IDs and history' },
    store.revision(),
  );
  const s = fixture();
  for (const table of ['projectHostedSeeds', 'projectHostedSeedPages', 'projectHostedChannels'])
    s.tables[table] = new Map();
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const calls = [],
    uploaded = [];
  const client = {
    mutation: async (ref, args) => {
      calls.push(getFunctionName(ref));
      return s.ctx.runMutation(ref, args);
    },
    action: async (ref, args) => {
      calls.push(getFunctionName(ref));
      return s.ctx.runAction(ref, args);
    },
  };
  const exchange = {
    missing: async pins =>
      pins
        .filter(
          pin =>
            ![...s.tables.projectObjects.values()].some(
              row => row.projectId === 'project' && row.digest === pin.sha256 && row.storageId,
            ),
        )
        .map(p => p.sha256),
    upload: async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      assert.equal(bytes.length, pin.size);
      uploaded.push(pin.sha256);
      await upload(s, bytes);
    },
    publish: () => {
      throw new Error('seed must not push');
    },
  };
  const input = { projectId: 'project', revision: store.revision(), operationId: randomUUID() };
  return { root, store, s, calls, uploaded, client, exchange, input };
}

test('native main and complete record bytes seed through bounded pages without a push; completed replay is a no-op', async t => {
  const f = setup(t);
  mkdirSync(join(f.store.directory, 'agent-finish'));
  const source = new NativeSource(f.root);
  const journalBlob = source.put(Buffer.from('journal-only source'));
  const journalHead = source.writeState(
    [{ path: 'pending.ts', blob: journalBlob, mode: 'file' }],
    [f.store.load().nativeHead],
    'Journal only',
    new Date().toISOString(),
  );
  const recovery = JSON.stringify({
    head: journalHead,
    command: { operationId: randomUUID() },
    attempts: [{ number: 3, status: 'unknown' }],
    dependencyWait: true,
  });
  writeFileSync(join(f.store.directory, 'agent-finish', 'pending.json'), recovery);
  const before = f.store.snapshotBytes();
  const prepared = await prepareHostedSeed(f.store, f.input.revision, f.input.operationId);
  assert(prepared.pages.length >= 3);
  assert(
    prepared.pages.every(page => page.length <= 100 && Buffer.byteLength(JSON.stringify(page)) <= 128 * 1024),
  );
  const result = await seedHostedProject(f.store, f.input, f.client, f.exchange);
  const selected = JSON.parse([...f.s.tables.projectHostedChannels.values()][0].selection);
  assert.equal(selected.head, f.store.load().nativeHead);
  assert.equal(result.mainDigest, digest(new NativeSource(f.root).object(selected.head)));
  assert.equal(result.mainDigest, prepared.request.head);
  assert.equal(result.recovery.status, 'recorded');
  assert.equal(result.recovery.capture.kind, 'seed');
  assert.equal(result.recovery.capture.backupId, result.backupId);
  assert.equal(f.s.tables.projectHostedSeedPages.size, prepared.pages.length);
  const retained = JSON.parse(readFileSync(join(prepared.directory, prepared.request.recovery.sha256)));
  assert.equal(retained.kind, 'forge-native-seed-recovery');
  assert(f.uploaded.includes(journalBlob));
  assert(f.uploaded.includes(journalHead));
  const workRow = [...f.s.tables.projectObjects.values()].find(
    row => row.digest === prepared.request.work.sha256,
  );
  assert.deepEqual(await storedBytes(f.s, workRow), before);
  assert.equal(Buffer.from(retained.files[0].bytes, 'base64').toString(), recovery);
  assert.equal(digest(before), prepared.request.work.sha256);
  const count = f.uploaded.length,
    pageCount = f.s.tables.projectHostedSeedPages.size;
  const replay = await seedHostedProject(f.store, f.input, f.client, f.exchange);
  assert.equal(replay.backupId, result.backupId);
  assert.equal(replay.uploadedObjects, 0);
  assert.deepEqual(replay.recovery, result.recovery);
  assert.equal((await readRecoveryInventory(f.root)).captures.length, 1);
  assert.equal(f.uploaded.length, count);
  assert.equal(f.s.tables.projectHostedSeedPages.size, pageCount);
  assert.equal(f.s.scheduled.length, 0);
  assert(f.calls.every(name => !/projectExchangeActions|completeHistory/.test(name)));
});

test('lost page reply resumes from its committed cursor, preserving the original snapshot after local writes', async t => {
  const f = setup(t),
    action = f.client.action;
  let fail = true;
  f.client.action = async (ref, args) => {
    const value = await action(ref, args);
    if (getFunctionName(ref).endsWith(':stage') && args.index === 1 && fail) {
      fail = false;
      throw new Error('lost page reply');
    }
    return value;
  };
  await assert.rejects(seedHostedProject(f.store, f.input, f.client, f.exchange), /lost page/);
  const pending = [...f.s.tables.projectHostedSeeds.values()][0];
  assert.equal(pending.nextPage, 2);
  assert.equal(f.s.tables.projectHostedChannels.size, 0);
  assert.equal(f.s.tables.projectBackups.size, 0);
  assert.equal((await readRecoveryInventory(f.root)).latestCompleteOffMachine, null);
  const pin = (await prepareHostedSeed(f.store, f.input.revision, f.input.operationId)).request.head;
  const data = f.store.load();
  data.revision++;
  f.store.locked(() => f.store.save(data));
  const resumed = [];
  f.client.action = async (ref, args) => {
    if (getFunctionName(ref).endsWith(':stage')) resumed.push(args.index);
    return action(ref, args);
  };
  const result = await seedHostedProject(f.store, f.input, f.client, f.exchange);
  assert.equal(resumed[0], 2);
  assert.equal(result.mainDigest, pin);
  assert.equal(new Set(f.uploaded).size, f.uploaded.length);
});

for (const reply of ['finish', 'completed begin'])
  test(`mismatched main in ${reply} reply records no recovery capture`, async t => {
    const f = setup(t, 5),
      action = f.client.action,
      mutation = f.client.mutation;
    let completed;
    f.client.action = async (ref, args) => {
      const result = await action(ref, args);
      if (getFunctionName(ref).endsWith(':finish')) {
        completed = JSON.parse(result);
        return JSON.stringify({ ...completed, mainDigest: '0'.repeat(64) });
      }
      return result;
    };
    await assert.rejects(seedHostedProject(f.store, f.input, f.client, f.exchange), {
      code: 'SOURCE_HASH_MISMATCH',
    });
    assert.equal((await readRecoveryInventory(f.root)).captures.length, 0);
    if (reply === 'completed begin') {
      f.client.mutation = async (ref, args) => {
        const result = await mutation(ref, args);
        return getFunctionName(ref).endsWith(':begin')
          ? JSON.stringify({ ...JSON.parse(result), mainDigest: '0'.repeat(64) })
          : result;
      };
      await assert.rejects(seedHostedProject(f.store, f.input, f.client, f.exchange), {
        code: 'SOURCE_HASH_MISMATCH',
      });
      assert.equal((await readRecoveryInventory(f.root)).captures.length, 0);
    }
    f.client.action = action;
    f.client.mutation = mutation;
    const result = await seedHostedProject(f.store, f.input, f.client, f.exchange);
    assert.equal(result.recovery.status, 'recorded');
    assert.equal(result.backupId, completed.backupId);
    assert.equal((await readRecoveryInventory(f.root)).captures.length, 1);
  });

test('missing or mismatched page bytes, out-of-order pages, and incomplete finish leave main unselected', async t => {
  const f = setup(t, 5),
    prepared = await prepareHostedSeed(f.store, f.input.revision, f.input.operationId);
  await modules.projectHostedSeed.begin._handler(f.s.ctx, {
    projectId: 'project',
    request: JSON.stringify(prepared.request),
  });
  await assert.rejects(
    modules.projectHostedSeed.commitPage._handler(f.s.ctx, {
      projectId: f.input.projectId,
      operationId: f.input.operationId,
      owner: 'owner',
      index: 0,
      previous: SEED_EMPTY,
      body: JSON.stringify(prepared.pages[0]),
    }),
    { code: 'INVALID_WORK_BACKUP' },
  );
  await assert.rejects(
    modules.projectHostedSeedActions.finish._handler(f.s.ctx, {
      projectId: f.input.projectId,
      operationId: f.input.operationId,
    }),
    error => error.data?.code === 'INVALID_WORK_BACKUP',
  );
  assert.equal(f.s.tables.projectHostedChannels.size, 0);
  assert.equal([...f.s.tables.projectHostedSeeds.values()][0].nextPage, 0);
});

test('moved authority or selected hosted source cannot be overwritten by final seed', async t => {
  const f = setup(t, 5),
    action = f.client.action;
  f.client.action = async (ref, args) => {
    if (getFunctionName(ref).endsWith(':finish'))
      f.s.tables.hostedProjects.get('project').sourceAuthority = { mode: 'server', epoch: 1 };
    return action(ref, args);
  };
  await assert.rejects(
    seedHostedProject(f.store, f.input, f.client, f.exchange),
    error => error.data?.code === 'SOURCE_AUTHORITY_STALE',
  );
  assert.equal(f.s.tables.projectHostedChannels.size, 0);
  assert.equal(f.s.tables.projectBackups.size, 0);
});

test('seed endpoints recheck owner authority, including completed replay', async t => {
  const f = setup(t, 5);
  await seedHostedProject(f.store, f.input, f.client, f.exchange);
  f.s.ctx.auth.getUserIdentity = async () => ({ subject: 'stranger' });
  await assert.rejects(
    seedHostedProject(f.store, f.input, f.client, f.exchange),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(f.s.tables.projectBackups.size, 1);
});

test('actual accepted main and receipt chain are preserved independently of the bootstrap State', async t => {
  const f = setup(t, 5),
    data = f.store.load(),
    source = new NativeSource(f.root);
  const bootstrap = data.nativeHead,
    firstId = randomUUID(),
    secondId = randomUUID();
  let previous = bootstrap;
  for (const [id, message] of [
    [firstId, 'First accepted'],
    [secondId, 'Second accepted'],
  ]) {
    const head = source.writeState(
      source.state(bootstrap).files,
      [previous],
      message,
      new Date().toISOString(),
    );
    data.channelMoves.push({
      id,
      channel: 'main',
      viewId: randomUUID(),
      head,
      previous,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    previous = head;
  }
  data.revision++;
  f.store.locked(() => f.store.save(data));
  f.input.revision = f.store.revision();
  const result = await seedHostedProject(f.store, f.input, f.client, f.exchange);
  const selected = JSON.parse([...f.s.tables.projectHostedChannels.values()][0].selection);
  assert.equal(f.s.tables.projectBackups.get(result.backupId).preview.head, bootstrap);
  assert.notEqual(result.mainDigest, bootstrap);
  assert.equal(result.mainDigest, previous);
  assert.equal(selected.receipt.id, secondId);
  assert.equal(selected.receipt.previousReceiptId, firstId);
  const prepared = await prepareHostedSeed(f.store, f.input.revision, f.input.operationId);
  assert.deepEqual(
    JSON.parse(readFileSync(join(prepared.directory, prepared.request.receipt.sha256))),
    data.channelMoves.at(-1),
  );
});

test('a selected-source CAS race and a wrong final digest leave the seed staged', async t => {
  const f = setup(t, 5),
    action = f.client.action;
  f.client.action = async (ref, args) => {
    if (getFunctionName(ref).endsWith(':finish')) {
      await assert.rejects(
        modules.projectHostedSeed.commit._handler(f.s.ctx, {
          projectId: f.input.projectId,
          operationId: f.input.operationId,
          owner: 'owner',
          mainDigest: '0'.repeat(64),
        }),
        { code: 'SOURCE_HASH_MISMATCH' },
      );
      f.s.tables.hostedProjects.get('project').revision++;
    }
    return action(ref, args);
  };
  await assert.rejects(
    seedHostedProject(f.store, f.input, f.client, f.exchange),
    error => error.data?.code === 'CHANNEL_CHANGED',
  );
  assert.equal(f.s.tables.projectHostedChannels.size, 0);
  assert.equal(f.s.tables.projectBackups.size, 0);
});

test('page validation rejects a hash-valid record with an invalid shape before committing progress', async t => {
  const f = setup(t, 5),
    prepared = await prepareHostedSeed(f.store, f.input.revision, f.input.operationId);
  await modules.projectHostedSeed.begin._handler(f.s.ctx, {
    projectId: 'project',
    request: JSON.stringify(prepared.request),
  });
  const entry = prepared.pages
    .flat()
    .find(pin => pin.records?.some(record => record.collection === 'intents'));
  assert(entry);
  const record = entry.records.find(record => record.collection === 'intents');
  const bytes = Buffer.from(JSON.stringify({ id: record.key, outcome: false }));
  const pin = await upload(f.s, bytes);
  await assert.rejects(
    modules.projectHostedSeedActions.stage._handler(f.s.ctx, {
      projectId: f.input.projectId,
      operationId: f.input.operationId,
      index: 0,
      previous: SEED_EMPTY,
      body: JSON.stringify([{ ...pin, kind: 'metadata', records: [record] }]),
    }),
    error => error.data?.code === 'INVALID_WORK_BACKUP',
  );
  assert.equal([...f.s.tables.projectHostedSeeds.values()][0].nextPage, 0);
  assert.equal(f.s.tables.projectHostedChannels.size, 0);
});

test('another driver advancing the cursor skips its already committed pages', async t => {
  const f = setup(t),
    prepared = await prepareHostedSeed(f.store, f.input.revision, f.input.operationId);
  const locations = JSON.parse(readFileSync(join(prepared.directory, 'locations.json')));
  const action = f.client.action,
    indexes = [];
  f.client.action = async (ref, args) => {
    const result = await action(ref, args);
    if (getFunctionName(ref).endsWith(':stage')) {
      indexes.push(args.index);
      if (args.index === 0) {
        const page = prepared.pages[1];
        for (const pin of page)
          if ((await f.exchange.missing([pin])).length)
            await f.exchange.upload(pin, readFileSync(locations[pin.sha256].path));
        return modules.projectHostedSeedActions.stage._handler(f.s.ctx, {
          projectId: f.input.projectId,
          operationId: f.input.operationId,
          index: 1,
          previous: JSON.parse(result).chain,
          body: JSON.stringify(page),
        });
      }
    }
    return result;
  };
  const result = await seedHostedProject(f.store, f.input, f.client, f.exchange);
  assert(result.backupId);
  assert.deepEqual(indexes.slice(0, 2), [0, 2]);
  assert.equal(f.s.tables.projectHostedSeedPages.size, prepared.pages.length);
});

test('an oversized native receipt remains an object pin in the small seed request', async t => {
  const f = setup(t, 5),
    data = f.store.load(),
    head = data.nativeHead;
  data.channelMoves.push({
    id: randomUUID(),
    channel: 'main',
    viewId: randomUUID(),
    head,
    previous: null,
    at: new Date().toISOString(),
    status: 'accepted',
    provenance: 'user-declared-local',
    fastPath: {
      policy: data.autonomyPolicy,
      kind: 'disjoint-fast-path',
      checkedViewId: randomUUID(),
      checkedHead: head,
      runId: randomUUID(),
      checkDefinition: head,
      environmentFingerprint: head,
      composedMain: head,
      previousMain: head,
      lanePaths: Array.from({ length: 10_000 }, (_, n) => `src/${'a'.repeat(128)}-${n}.ts`),
      mainPaths: [],
      cleanComposition: true,
      descendant: true,
      postAccept: { checkId: randomUUID(), mode: 'full', required: true },
    },
  });
  data.revision++;
  f.store.locked(() => f.store.save(data));
  const prepared = await prepareHostedSeed(f.store, f.store.revision(), f.input.operationId);
  assert(prepared.request.receipt.size > 1024 * 1024);
  assert(Buffer.byteLength(JSON.stringify(prepared.request)) < 4096);
  assert.equal(
    JSON.parse(readFileSync(join(prepared.directory, prepared.request.receipt.sha256))).id,
    prepared.request.receiptId,
  );
});
