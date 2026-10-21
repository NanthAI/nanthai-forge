// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import {
  fixture,
  checkpoint,
  preparedCheckpoint,
  modules,
  upload,
  currentOwnerDisplay,
} from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { land } from './source-landings-fixture.mjs';
import { retainExchangeBaseline } from '../dist/native-exchange-baseline.js';
import { workBytes, applyHostedEvent, parseWorkBytes } from '../dist/work-metadata.js';
import { recordBytes, buildWorkRecords } from '../dist/work-exchange-records.js';
import { buildExchangeRoot } from '../dist/native-exchange-tree.js';
import { convertWorkTo18 } from '../dist/work-intent-converter.js';
import { legacyPolicy } from '../dist/autonomy-policy.js';
import { unifyIntent } from '../dist/work-intent-local.js';
import { digest } from '../dist/hash.js';
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const { verifyRecordSeed } = await import(moduleUrl('../convex/projectWorkRecordExchange.ts'));
const failCode = code => error => error.data?.code === code;

test('complete record publication validates the original field order rather than schema order', async t => {
  const s = fixture(),
    first = await checkpoint(t, s),
    { schema, ...rest } = first.store.load(),
    data = { ...rest, schema, nativeCompanionReceipts: [] },
    work = Buffer.from(workBytes(data));
  assert.notEqual(workBytes(parseWorkBytes(work)), work.toString('utf8'));
  const manifest = {
    ...first.manifest,
    files: first.manifest.files.map(file =>
      file.path === 'work.json' ? { ...file, sha256: digest(work), size: work.length } : file,
    ),
  };
  const tree = buildExchangeRoot(Buffer.from(JSON.stringify(manifest)), work, { records: true });
  for (const bytes of tree.objects.values()) await upload(s, bytes);
  const pin = await upload(s, tree.bytes);
  const initialBackup = await modules.projectExchangeActions.publish._handler(s.ctx, first.input);
  const initialized = await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId: initialBackup,
    operationId: randomUUID(),
  });
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, {
    ...first.input,
    operationId: randomUUID(),
    previous: initialBackup,
    digest: pin.sha256,
    size: pin.size,
    ...(await currentOwnerDisplay(s, first.store, data)),
  });
  assert.equal(s.tables.projectBackups.get(backupId).validatedWorkRecords, 1);
  const receipt = await complete(s, {
    projectId: 'project',
    backupId,
    expectedBackupId: initialBackup,
    revision: initialized.work.revision,
    operationId: randomUUID(),
    continuation: true,
  });
  const hosted = await modules.projectWorkActions.load(s.ctx, 'project', 'owner');
  first.store.save(hosted.data);
  const next = await preparedCheckpoint(s, first.store, 0, undefined, {
    records: true,
    baseline: data,
    journalRevision: receipt.revision,
  });
  next.input.previous = backupId;
  const nextBackup = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
  await complete(s, {
    projectId: 'project',
    backupId: nextBackup,
    expectedBackupId: backupId,
    revision: receipt.revision,
    operationId: randomUUID(),
    continuation: true,
  });
  const returned = await modules.projectWorkActions.load(s.ctx, 'project', 'owner');
  assert.equal(returned.data.hostedEvents.length, 2, 'complete fallback preserves both journal receipts');
});

test('complete record seed preserves absent defaults and rejects changed Work at the same revision', async () => {
  const data = { schema: 15, revision: 0, nativeHead: 'a'.repeat(64), intents: [], lanes: [], views: [] },
    work = Buffer.from(workBytes(data)),
    encoded = buildWorkRecords(data),
    exchange = { root: { records: encoded.pin } };
  assert.notEqual(workBytes(parseWorkBytes(work)), work.toString('utf8'));
  await verifyRecordSeed(exchange, work);
  await assert.rejects(
    verifyRecordSeed(exchange, Buffer.from(workBytes({ ...data, nativeHead: 'b'.repeat(64) }))),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
  await assert.rejects(
    verifyRecordSeed(exchange, Buffer.from(workBytes({ ...data, revision: 1 }))),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
});

async function setup(t, records = true, history = 3, active = false, unified = false, bindings = false) {
  const s = fixture(),
    first = await checkpoint(t, s);
  land(first.store, history, 2);
  if (active) {
    const data = first.store.load();
    data.intents[0].status = 'active';
    first.store.save(data);
  }
  if (unified) {
    const raw = first.store.load();
    raw.schema = 15;
    const data = convertWorkTo18(raw);
    data.intents.push(
      unifyIntent({
        id: randomUUID(),
        outcome: 'Planned without a Lane',
        constraints: '',
        status: 'active',
        createdAt: 'now',
        notes: [],
      }),
    );
    data.intentAliases.push({ aliasId: randomUUID(), intentId: data.intents[0].id });
    // Catalog metadata itself can exceed the old delta budget. This is not a delta-size limit.
    data.legacyIntentMerge.fields.synthetic = 'x'.repeat(4 * 1024 * 1024 + 1);
    first.store.save(data);
  }
  if (bindings) {
    const data = first.store.load();
    const view = data.views[0],
      runId = randomUUID(),
      checkId = randomUUID();
    const check = {
      id: checkId,
      name: 'Synthetic historical check',
      executable: 'node',
      args: [],
      environmentLabel: 'synthetic',
      definition: 'a'.repeat(64),
      at: 'now',
    };
    data.checks.push(check);
    data.runs.push({
      id: runId,
      viewId: view.id,
      head: view.head,
      base: view.base,
      inputs: view.inputs,
      dependencies: [],
      check,
      environment: {
        platform: 'synthetic',
        arch: 'synthetic',
        os: 'synthetic',
        node: 'synthetic',
        env: {},
        fingerprint: 'b'.repeat(64),
      },
      status: 'passed',
      startedAt: 'now',
      endedAt: 'later',
      runner: { pid: 1, host: 'synthetic' },
      details: 'x'.repeat(3 * 1024 * 1024),
    });
    for (const move of data.channelMoves)
      move.fastPath = {
        policy: legacyPolicy(),
        kind: 'disjoint-fast-path',
        checkedViewId: view.id,
        checkedHead: view.head,
        runId,
        checkDefinition: check.definition,
        environmentFingerprint: 'b'.repeat(64),
        composedMain: move.head,
        previousMain: move.previous,
        lanePaths: [],
        mainPaths: [],
        cleanComposition: true,
        descendant: true,
        postAccept: { checkId, mode: 'full', required: true },
      };
    data.githubSync = {
      repository: 'synthetic/project',
      branch: 'main',
      adoptedCommit: '',
      pushed: 0,
      commits: [
        {
          operationId: randomUUID(),
          state: data.nativeHead,
          acceptanceId: randomUUID(),
          viewId: randomUUID(),
          commit: 'a'.repeat(40),
          parent: '',
          tree: 'b'.repeat(40),
          message: 'Synthetic mirror',
          author: { name: 'Synthetic', email: 'synthetic@example.invalid' },
          committer: { name: 'Synthetic', email: 'synthetic@example.invalid' },
          seconds: 0,
        },
      ],
    };
    data.githubAutoPush = {
      id: 'github-auto-push',
      repository: 'synthetic/project',
      acceptanceId: randomUUID(),
      state: data.nativeHead,
      operationId: randomUUID(),
      status: 'queued',
      attempts: 0,
      at: 'now',
      undo: 'Synthetic undo',
    };
    first.store.save(data);
  }
  const baseline = first.store.load();
  const seed = await preparedCheckpoint(s, first.store, 0, undefined, { records });
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, seed.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const generationId = await index.ensure._handler(s.ctx, { projectId: 'project' });
  const baselineKey = 'synthetic/work-records';
  retainExchangeBaseline(
    first.store,
    baselineKey,
    seed.manifest,
    baseline,
    [],
    JSON.parse(
      readFileSync(join(first.store.directory, `exchange-${seed.input.operationId}`, 'states.json'), 'utf8'),
    ),
  );
  return { s, first, baseline, seed, backupId, generationId, baselineKey };
}
async function candidate(f, count = 1, options = {}) {
  land(f.first.store, count);
  const next = await preparedCheckpoint(f.s, f.first.store, 0, f.baselineKey, {
    records: true,
    baseline: f.baseline,
    journalRevision: f.baseline.revision,
    ...options,
  });
  next.input.previous = f.backupId;
  const id = await modules.projectExchangeActions.publish._handler(f.s.ctx, next.input);
  const ownerDerived = await upload(
    f.s,
    readFileSync(join(f.first.store.directory, `exchange-${next.input.operationId}`, 'owner-derived.json')),
  );
  return {
    next,
    input: {
      projectId: 'project',
      backupId: id,
      expectedBackupId: f.backupId,
      revision: options.journalRevision ?? f.baseline.revision,
      operationId: randomUUID(),
      continuation: true,
      ownerDerived,
    },
  };
}
async function complete(s, input) {
  let result;
  do result = await modules.projectSourceReturn.returnSource._handler(s.ctx, input);
  while (result.pending);
  // A completing durable return adds per-push accounting; replays return the stored receipt.
  delete result.accounting;
  return result;
}
for (const landings of [1, 20])
  test(
    `record-delta return after ${landings} landings equals full Work and preserves index counts`,
    { timeout: 300000 },
    async t => {
      const f = await setup(t, true, 5, true),
        c = await candidate(f, landings);
      assert.equal(c.next.tree.root.schema, 2);
      assert.equal(f.s.tables.projectBackups.get(c.input.backupId).validatedWorkRecords, 1);
      let unrelatedReads = 0;
      const unrelated = [...f.s.tables.projectObjects.values()].find(
        row => row.digest === digest(recordBytes(f.baseline.intents[2])),
      );
      const get = f.s.ctx.storage.get;
      f.s.ctx.storage.get = id => {
        if (id === unrelated.storageId) unrelatedReads++;
        return get(id);
      };
      const receipt = await complete(f.s, c.input);
      assert.equal(unrelatedReads, 0, 'source return does not load unrelated retained Work records');
      f.s.ctx.storage.get = get;
      const expected = f.first.store.load();
      applyHostedEvent(expected, {
        projectKey: f.s.tables.hostedProjects.get('project').key,
        archiveSha256: f.s.tables.projectBackups.get(c.input.backupId).digest,
        id: receipt.operationId,
        actor: receipt.actor,
        at: receipt.at,
        request: receipt.request,
        previousRevision: receipt.previousRevision,
        command: JSON.parse(receipt.command),
      });
      const loaded = await modules.projectWorkActions.load(f.s.ctx, 'project', 'owner');
      assert.equal(workBytes(loaded.data), workBytes(expected));
      assert.deepEqual(await complete(f.s, c.input), receipt);
      const generation = f.s.tables.projectWorkGenerations.get(f.generationId),
        counts = JSON.parse(generation.metadata).counts;
      assert.equal(generation.backupId, c.input.backupId);
      assert.equal(JSON.parse(generation.metadata).defaultIntentId, f.baseline.intents[0].id);
      const rows = [...f.s.tables.projectWorkRecords.values()].filter(
        row => row.generationId === (generation.recordsGenerationId ?? generation._id),
      );
      for (const [collection, count] of Object.entries(counts))
        assert.equal(rows.filter(row => row.collection === collection).length, count, collection);
      assert.equal(
        JSON.parse(rows.find(r => r.collection === 'channels' && r.key === 'main').value).head,
        expected.nativeHead,
      );
    },
  );
test('source return rejects stale hosted revision and retries the exact original receipt', async t => {
  const f = await setup(t),
    c = await candidate(f);
  await assert.rejects(
    () => complete(f.s, { ...c.input, revision: c.input.revision + 1 }),
    failCode('WORK_STALE'),
  );
  const receipt = await complete(f.s, c.input);
  assert.deepEqual(await complete(f.s, c.input), receipt);
  await assert.rejects(
    () => complete(f.s, { ...c.input, revision: c.input.revision + 1 }),
    failCode('WORK_OPERATION_CHANGED'),
  );
});
test('old checkpoints retain the full source-return fallback', async t => {
  const f = await setup(t, false),
    c = await candidate(f);
  const result = await complete(f.s, c.input);
  assert.equal(result.revision, f.first.store.revision() + 1);
  assert.equal(f.s.tables.projectBackups.get(f.backupId).validatedWorkRecords, undefined);
});
test('record exchange and source return retain current authority checks', async t => {
  const f = await setup(t),
    c = await candidate(f);
  f.s.ctx.auth.getUserIdentity = async () => ({ subject: 'stranger' });
  await assert.rejects(() => complete(f.s, c.input), failCode('PROJECT_UNAVAILABLE'));
  await assert.rejects(
    () => modules.projectExchangeActions.publish._handler(f.s.ctx, c.next.input),
    failCode('PROJECT_UNAVAILABLE'),
  );
});
test('a second delta replays hosted source-return and note events without changing portable Work', async t => {
  const f = await setup(t),
    first = await candidate(f);
  const receipt = await complete(f.s, first.input);
  await modules.projectWorkActions.command._handler(f.s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    revision: receipt.revision,
    command: JSON.stringify({
      action: 'note',
      intentId: f.baseline.intents[0].id,
      kind: 'comment',
      text: 'Hosted observation',
    }),
  });
  const hosted = await modules.projectWorkActions.load(f.s.ctx, 'project', 'owner');
  f.first.store.save(hosted.data);
  f.baseline = JSON.parse(
    readFileSync(
      join(f.first.store.directory, `exchange-${first.next.input.operationId}`, 'work.json'),
      'utf8',
    ),
  );
  f.backupId = first.input.backupId;
  retainExchangeBaseline(
    f.first.store,
    f.baselineKey,
    first.next.manifest,
    f.baseline,
    [],
    JSON.parse(
      readFileSync(
        join(f.first.store.directory, `exchange-${first.next.input.operationId}`, 'states.json'),
        'utf8',
      ),
    ),
  );
  const second = await candidate(f, 1, { journalRevision: hosted.data.revision });
  await complete(f.s, second.input);
  const loaded = await modules.projectWorkActions.load(f.s.ctx, 'project', 'owner');
  assert.equal(loaded.data.intents[0].notes.at(-1).text, 'Hosted observation');
  assert.equal(loaded.data.hostedEvents.length, 3);
  assert.equal(loaded.data.channelMoves.length, 5);
});
test('hosted publication rejects a delta with an invalid prior record hash', async t => {
  const f = await setup(t);
  land(f.first.store, 1);
  const next = await preparedCheckpoint(f.s, f.first.store, 0, f.baselineKey, {
    records: true,
    baseline: f.baseline,
    journalRevision: f.baseline.revision,
  });
  const delta = JSON.parse(next.tree.objects.get(next.tree.root.delta.sha256));
  delta.changes[0].previous = 'f'.repeat(64);
  const pin = await upload(f.s, Buffer.from(JSON.stringify(delta)));
  const root = await upload(f.s, Buffer.from(JSON.stringify({ ...next.tree.root, delta: pin })));
  await assert.rejects(
    () =>
      modules.projectExchangeActions.publish._handler(f.s.ctx, {
        ...next.input,
        operationId: randomUUID(),
        previous: f.backupId,
        digest: root.sha256,
        size: root.size,
      }),
    failCode('INVALID_WORK_BACKUP'),
  );
  assert.equal(f.s.tables.hostedProjects.get('project').currentBackup, f.backupId);
});
for (const kind of ['dangling', 'inbound-removal'])
  test(`hosted record apply rejects ${kind}`, async t => {
    const f = await setup(t),
      data = f.first.store.load();
    data.revision++;
    if (kind === 'dangling') data.lanes[0].intentId = randomUUID();
    else data.intents.shift();
    f.first.store.save(data);
    const next = await preparedCheckpoint(f.s, f.first.store, 0, f.baselineKey, {
      records: true,
      baseline: f.baseline,
      journalRevision: f.baseline.revision,
    });
    await assert.rejects(
      () => modules.projectExchangeActions.publish._handler(f.s.ctx, { ...next.input, previous: f.backupId }),
      failCode('INVALID_WORK_BACKUP'),
    );
    assert.equal(f.s.tables.hostedProjects.get('project').currentBackup, f.backupId);
  });
test('a hosted writer racing final record publication keeps the selected source and index', async t => {
  const f = await setup(t),
    c = await candidate(f),
    mutate = f.s.ctx.runMutation;
  f.s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectWork:returnSource') {
      for (const head of f.s.tables.projectWorkHeads.values()) head.revision++;
    }
    return mutate(ref, args);
  };
  await assert.rejects(() => complete(f.s, c.input), failCode('WORK_STALE'));
  assert.equal(f.s.tables.hostedProjects.get('project').work.backupId, f.backupId);
  assert.equal(f.s.tables.projectWorkGenerations.get(f.generationId).backupId, f.backupId);
});
test('lost stage-begin replies retain the source-return timestamp and original operation', async t => {
  const f = await setup(t),
    c = await candidate(f),
    mutate = f.s.ctx.runMutation;
  let lose = true;
  f.s.ctx.runMutation = async (ref, args) => {
    const result = await mutate(ref, args);
    if (lose && getFunctionName(ref) === 'projectReturnIndexStage:begin') {
      lose = false;
      throw new ConvexError({ code: 'HOSTED_ACTION_FAILED', message: 'Synthetic lost stage reply' });
    }
    return result;
  };
  await assert.rejects(() => complete(f.s, c.input), failCode('HOSTED_ACTION_FAILED'));
  const at = [...f.s.tables.projectWorkGenerations.values()].find(
    row => row.returnOperationId === c.input.operationId,
  ).returnAt;
  const receipt = await complete(f.s, c.input);
  assert.equal(receipt.at, at);
  assert.deepEqual(await complete(f.s, c.input), receipt);
});

test('dogfood-like unified Work seeds validated large catalogs and returns through record delta', async t => {
  const f = await setup(t, true, 5, true, true);
  assert.equal(f.seed.tree.root.schema, 2);
  assert.ok(f.seed.tree.root.records.size > 4 * 1024 * 1024);
  assert.equal(f.s.tables.projectBackups.get(f.backupId).validatedWorkRecords, 1);
  const c = await candidate(f);
  assert.equal(f.s.tables.projectBackups.get(c.input.backupId).validatedWorkRecords, 1);
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args));
  await complete(f.s, c.input);
  assert.ok(
    logs.some(([name]) => name === 'work-record return prepared'),
    JSON.stringify(logs),
  );
  assert.ok(
    !logs.some(([name]) => name === 'source-return prepare load done'),
    'record delta never loads complete Work',
  );
  const hosted = await modules.projectWorkActions.load(f.s.ctx, 'project', 'owner');
  assert.equal(hosted.data.schema, 18);
  assert.deepEqual(hosted.data.intentAliases, f.baseline.intentAliases);
  assert.ok(hosted.data.intents.some(i => i.base === undefined));
});

test('format-18 seed followed by routine record and mirror metadata changes publishes delta and returns through records', async t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args));
  const f = await setup(t, true, 5, true, true, true);
  assert.ok(
    logs.some(([name, details]) => name === 'work-record exchange prepared' && details.mode === 'seed'),
  );
  const data = f.first.store.load();
  data.revision++;
  data.intents.at(-1).notes.push({ kind: 'comment', text: 'Routine synthetic change', at: 'later' });
  for (const move of data.channelMoves) move.postAcceptRunId = data.runs[0].id;
  data.githubSync.pushed = 1;
  data.githubSync.pushedAt = '2026-10-21T09:00:00Z';
  data.githubAutoPush.status = 'pushed';
  data.githubAutoPush.attempts++;
  f.first.store.save(data);
  const next = await preparedCheckpoint(f.s, f.first.store, 0, f.baselineKey, {
    records: true,
    baseline: f.baseline,
    journalRevision: f.baseline.revision,
  });
  next.input.previous = f.backupId;
  const uploadedBytes = [...next.tree.objects]
    .filter(([sha]) => !f.seed.tree.objects.has(sha))
    .reduce((sum, [, bytes]) => sum + bytes.length, 0);
  assert.ok(uploadedBytes < 512 * 1024, `routine metadata upload: ${uploadedBytes}`);
  const backupId = await modules.projectExchangeActions.publish._handler(f.s.ctx, next.input);
  assert.ok(
    logs.some(([name, details]) => name === 'work-record exchange prepared' && details.mode === 'delta'),
  );
  assert.ok(
    !logs.some(
      ([name, details]) =>
        name === 'work-record publication skip' && details.reason === 'delta-layout-unsupported',
    ),
  );
  let unrelatedReads = 0;
  const runPin = digest(recordBytes(f.baseline.runs[0]));
  const runObject = [...f.s.tables.projectObjects.values()].find(row => row.digest === runPin);
  const get = f.s.ctx.storage.get;
  f.s.ctx.storage.get = id => {
    if (id === runObject.storageId) unrelatedReads++;
    return get(id);
  };
  const receipt = await complete(f.s, {
    projectId: 'project',
    backupId,
    expectedBackupId: f.backupId,
    revision: f.baseline.revision,
    operationId: randomUUID(),
    continuation: true,
  });
  assert.ok(logs.some(([name]) => name === 'work-record return prepared'));
  assert.equal(unrelatedReads, 0, 'post-accept links do not reload unchanged historical check logs');
  f.s.ctx.storage.get = get;
  const loaded = await modules.projectWorkActions.load(f.s.ctx, 'project', 'owner');
  assert.equal(loaded.data.runs[0].details, f.baseline.runs[0].details);
  assert.equal(loaded.data.githubSync.pushed, 1);
  assert.equal(loaded.data.githubAutoPush.status, 'pushed');
  assert.equal(loaded.data.intents.at(-1).notes.at(-1).text, 'Routine synthetic change');
  assert.equal(loaded.data.revision, receipt.revision);
});

for (const [from, to] of [
  [17, 19],
  [18, 20],
])
  test(`format ${from} to ${to} publication and source return retain record delta mode`, async t => {
    const s = fixture(),
      first = await checkpoint(t, s);
    const initial = { ...first.store.load(), schema: 17 };
    const data = from === 18 ? convertWorkTo18(initial) : initial;
    first.store.save(data);
    const baseline = await preparedCheckpoint(s, first.store, 0, undefined, { records: true });
    const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, baseline.input);
    await modules.projectWorkActions.initialize._handler(s.ctx, {
      projectId: 'project',
      backupId,
      operationId: randomUUID(),
    });
    await index.ensure._handler(s.ctx, { projectId: 'project' });
    const before = JSON.parse(
      readFileSync(join(first.store.directory, `exchange-${baseline.input.operationId}`, 'work.json')),
    );
    first.store.save({ ...before, schema: to, revision: before.revision + 1 });
    const candidate = await preparedCheckpoint(s, first.store, 0, undefined, {
      records: true,
      baseline: before,
      journalRevision: before.revision,
    });
    candidate.input.previous = backupId;
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args));
    assert.ok(candidate.tree.root.delta);
    const nextId = await modules.projectExchangeActions.publish._handler(s.ctx, candidate.input);
    assert.ok(
      logs.some(([name, details]) => name === 'work-record exchange prepared' && details.mode === 'delta'),
    );
    assert.ok(
      !logs.some(([name, details]) => name === 'work-record exchange prepared' && details.mode === 'seed'),
    );
    await complete(s, {
      projectId: 'project',
      backupId: nextId,
      expectedBackupId: backupId,
      revision: before.revision,
      operationId: randomUUID(),
      continuation: true,
    });
    assert.ok(logs.some(([name]) => name === 'work-record return prepared'));
  });

test('replacement publication authenticates selected Work independently of an unreturned predecessor', async t => {
  const f = await setup(t, true, 1),
    { s } = f;
  const orphan = await candidate(f);
  // The upload changed currentBackup, but its return never selected hosted Work.
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, f.backupId);
  const next = await preparedCheckpoint(s, f.first.store, 0, f.baselineKey, {
    records: true,
    baseline: f.baseline,
    journalRevision: f.baseline.revision,
  });
  next.input.previous = orphan.input.backupId;
  const { recordPublication } = await import(moduleUrl('../convex/projectWorkRecordExchange.ts'));
  const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args));
  const selected = s.tables.projectBackups.get(f.backupId);
  delete selected.validatedClosure;
  assert.equal(
    await recordPublication(s.ctx, next.input, 'owner', exchangeObjectReader(s.ctx, true)),
    undefined,
  );
  assert.equal(logs.at(-1)[1].reason, 'selected-base-unvalidated');
  selected.validatedClosure = 1;
  // Even a legacy/unvalidated predecessor cannot hide a usable selected base.
  delete s.tables.projectBackups.get(orphan.input.backupId).validatedWorkRecords;
  const id = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
  assert.equal(s.tables.projectBackups.get(id).previous, orphan.input.backupId);
  assert.equal(s.tables.projectBackups.get(id).validatedWorkRecords, 1);
  assert.equal(logs.at(-1)[0], 'work-record exchange prepared');
  assert.equal(logs.at(-1)[1].mode, 'delta');
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, f.backupId);
});
