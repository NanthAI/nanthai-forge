// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import {
  fixture,
  checkpoint,
  preparedCheckpoint,
  modules,
  upload,
  seedRecordCheckpoint,
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
import { continueLongAction } from '../dist/long-action.js';
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const ensureIndex = s =>
  continueLongAction('Build test index', randomUUID(), continuation =>
    index.ensure._handler(s.ctx, { projectId: 'project', continuation }),
  );
const { verifyRecordSeed } = await import(moduleUrl('../convex/projectWorkRecordExchange.ts'));
const failCode = code => error => error.data?.code === code;

test('records publication without a usable delta fails before whole-Work seed validation', async t => {
  const s = fixture(),
    first = await checkpoint(t, s);
  const initialBackup = await modules.projectExchangeActions.publish._handler(s.ctx, first.input);
  const candidate = await preparedCheckpoint(s, first.store, 0, undefined, { records: true });
  await assert.rejects(
    modules.projectExchangeActions.publish._handler(s.ctx, {
      ...candidate.input,
      previous: initialBackup,
    }),
    error =>
      error.data?.code === 'WORK_DELTA_UNAVAILABLE' &&
      /previous-records-unvalidated/.test(error.data.message),
  );
  assert.equal(s.tables.projectBackups.size, 1);
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
  const backupId = records
    ? await seedRecordCheckpoint(s, seed)
    : await modules.projectExchangeActions.publish._handler(s.ctx, seed.input);
  // Keep the record-return index fixture's existing owner display baseline.
  if (records) s.tables.projectBackups.get(backupId).ownerDerived = seed.input.ownerDerived;
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const generationId = await ensureIndex(s);
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
    ...(f.seed.tree.root.schema === 1 ? { records: false } : {}),
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
  assert.deepEqual(await recordPublication(s.ctx, next.input, 'owner', exchangeObjectReader(s.ctx, true)), {
    unavailable: 'selected-base-unvalidated',
  });
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
