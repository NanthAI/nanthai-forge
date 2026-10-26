// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { policyPreset, policyWriteSchema, editedPolicy } from '../dist/autonomy-policy.js';
import { runLogRecord, portableCheckPath, DAY_MS } from '../dist/check-log-policy.js';
import { exportNativeWork, restoreNativeWork } from '../dist/native-backup.js';
import { prepareNativeExchange, pushNativeExchange, pullNativeExchange } from '../dist/native-exchange.js';
import { prepareHostedSeed } from '../dist/hosted-seed-capture.js';
import { cleanLocalCheckLogs } from '../dist/check-log-cleanup.js';
import { checkLogsCli } from '../dist/check-logs-cli.js';
import { compactCheckText, CompactCheckWriter, checkEvidenceLines } from '../dist/check-compact-output.js';
import { checkLogStoragePlan } from '../dist/check-log-storage-plan.js';
import { checkEvidenceFingerprint } from '../dist/check-reuse-evidence.js';
import { readRecoveryInventory } from '../dist/recovery-inventory.js';
import { digest } from '../dist/hash.js';
const now = Date.now();
function fixture(t, runner = 'github-actions', count = 1, bytes = 1024) {
  const root = mkdtempSync(join(tmpdir(), 'forge-byoci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'export const value = 1;\n');
  initNative(root);
  const work = new WorkService(root),
    store = work.store;
  const act = command => work.execute(command, store.revision()).result;
  const intent = act({ action: 'intent', outcome: 'Synthetic BYOCI evidence' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Evidence' });
  const view = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const check = act({ action: 'define-check', name: 'Synthetic', executable: process.execPath, args: [] });
  const data = store.load();
  for (let i = 0; i < count; i++) {
    const run = {
      id: randomUUID(),
      viewId: view.id,
      head: view.head,
      base: view.base,
      inputs: view.inputs,
      dependencies: [],
      check,
      environment: work.status().environment,
      status: 'passed',
      startedAt: new Date(now - 60_000).toISOString(),
      endedAt: new Date(now).toISOString(),
      exitCode: 0,
      signal: null,
      runner: { pid: process.pid, host: 'synthetic' },
      details: 'Synthetic result',
      failureSummary: 'Synthetic retained summary',
      backend: {
        requested: runner,
        actual: runner,
        runtime: 'github-actions;repo:synthetic/checks;node:24.22.1',
        executionIds: [String(123 + i)],
      },
    };
    const folder = join(store.directory, `check-${run.id}`);
    mkdirSync(folder);
    for (const name of ['stdout.log', 'stderr.log'])
      writeFileSync(join(folder, name), `${name}-${i}\n` + 'x'.repeat(bytes));
    writeFileSync(
      join(folder, 'result.json'),
      JSON.stringify({
        status: 'passed',
        endedAt: run.endedAt,
        exitCode: 0,
        backend: run.backend,
        details: run.details,
      }),
    );
    writeFileSync(
      join(folder, 'test-reports.json'),
      JSON.stringify({
        schema: 1,
        files: [
          {
            name: 'shards/0.evidence',
            text: '__FORGE_TESTS__{"file":"tests/a.test.mjs","complete":true,"durationMs":12,"results":[{"name":"synthetic","passed":true}]}\n',
          },
        ],
      }),
    );
    for (const name of ['stdout.log', 'stderr.log', 'result.json', 'test-reports.json'])
      chmodSync(join(folder, name), 0o600);
    data.runs.push(run);
  }
  data.revision++;
  store.save(data);
  return {
    root,
    work,
    store,
    data,
    run: data.runs[0],
    folder: join(store.directory, `check-${data.runs[0].id}`),
  };
}
function optIn(f, retentionDays = 90) {
  const data = f.store.load();
  data.autonomyPolicy = { ...policyPreset('trusted'), checkLogs: { uploadLocal: true, retentionDays } };
  data.revision++;
  f.store.save(data);
}
for (const runner of ['github-actions', 'modal'])
  test(`${runner} exports/results restore without log bytes or unavailable-log warnings`, async t => {
    const f = fixture(t, runner);
    optIn(f);
    const fingerprint = checkEvidenceFingerprint(f.store.load().runs[0]);
    const exported = await exportNativeWork(f.store, f.store.revision(), true);
    const manifest = JSON.parse(exported.result.json);
    assert(!manifest.files.some(file => file.path.endsWith('.log')));
    assert(!manifest.unavailable.some(path => path.endsWith('.log')));
    assert.equal(manifest.checkLogs[0].status, 'provider-held');
    assert(manifest.checkLogs[0].providerUrl.startsWith('https://'));
    assert(manifest.files.some(file => file.path.endsWith('/test-reports.json')));
    const target = join(f.root, 'restored');
    await restoreNativeWork(exported.result.archive.path, target);
    const restored = new WorkService(target).store;
    assert.equal(checkEvidenceFingerprint(restored.load().runs[0]), fingerprint);
    assert(!existsSync(join(restored.directory, `check-${f.run.id}`, 'stdout.log')));
    const inventory = await readRecoveryInventory(f.root);
    assert.equal(
      inventory.pending.evidence.find(file => file.path.endsWith('/stdout.log')).status,
      'provider-held',
    );
  });
test('local upload defaults off; explicit setting defaults to 90 days and requires finite 1..400 days', t => {
  const f = fixture(t, 'local');
  assert.equal(runLogRecord(f.store.load(), f.run, now).status, 'local-only');
  const upperRun = { ...f.run, id: f.run.id.toUpperCase(), backend: { requested: 'modal', actual: 'modal' } };
  assert.equal(portableCheckPath({ runs: [upperRun] }, `check-${upperRun.id}/stdout.log`), false);
  const command = policyWriteSchema.parse({
    action: 'set-policy',
    operationId: randomUUID(),
    checkLogs: { uploadLocal: true },
  });
  assert.deepEqual(editedPolicy(policyPreset('trusted'), command).checkLogs, {
    uploadLocal: true,
    retentionDays: 90,
  });
  for (const retentionDays of [0, 401, Infinity, 'never', null])
    assert.equal(
      policyWriteSchema.safeParse({
        action: 'set-policy',
        operationId: randomUUID(),
        checkLogs: { uploadLocal: true, retentionDays },
      }).success,
      false,
    );
  optIn(f);
  assert.equal(runLogRecord(f.store.load(), f.run, now + 90 * DAY_MS - 1).status, 'included');
  assert.equal(runLogRecord(f.store.load(), f.run, now + 90 * DAY_MS).status, 'expired');
});
test('all capture routes share explicit local opt-in and suppress an expired old exchange baseline', async t => {
  const f = fixture(t, 'local');
  let exported = await exportNativeWork(f.store, f.store.revision(), false);
  assert(!JSON.parse(exported.result.json).files.some(file => file.path.endsWith('.log')));
  optIn(f);
  const exchange = await prepareNativeExchange(f.store, f.store.revision(), randomUUID());
  assert.equal(exchange.manifest.files.filter(file => file.path.endsWith('.log')).length, 2);
  const data = f.store.load();
  data.runs[0].startedAt = data.runs[0].endedAt = new Date(now - 91 * DAY_MS).toISOString();
  data.revision++;
  f.store.save(data);
  const prepared = await prepareNativeExchange(
    f.store,
    f.store.revision(),
    randomUUID(),
    false,
    undefined,
    undefined,
    { captured: { directory: exchange.directory, data } },
  );
  assert(!prepared.manifest.files.some(file => file.path.endsWith('.log')));
  const seed = await prepareHostedSeed(f.store, f.store.revision(), randomUUID());
  const manifest = JSON.parse(readFileSync(join(seed.directory, seed.request.manifest.sha256), 'utf8'));
  assert(!manifest.files.some(file => file.path.endsWith('.log')));
  assert.equal(manifest.checkLogs[0].status, 'expired');
});
test('legacy native manifests with absent provider log pins restore; missing source/result still fails', async t => {
  const f = fixture(t);
  const exported = await exportNativeWork(f.store, f.store.revision(), false);
  const manifest = JSON.parse(exported.result.json);
  delete manifest.checkLogs;
  const log = readFileSync(join(f.folder, 'stdout.log'));
  manifest.files.push({ path: `check-${f.run.id}/stdout.log`, sha256: digest(log), size: log.length });
  writeFileSync(join(exported.result.path, 'manifest.json'), JSON.stringify(manifest));
  await restoreNativeWork(exported.result.path, join(f.root, 'legacy-restored'));
  rmSync(join(exported.result.path, `check-${f.run.id}`, 'result.json'));
  await assert.rejects(restoreNativeWork(exported.result.path, join(f.root, 'corrupt-restored')), {
    code: 'INVALID_WORK_BACKUP',
  });
});
test('old exchange pull never downloads provider logs and preserves original manifest/source pins', async t => {
  const f = fixture(t),
    objects = new Map();
  const transport = {
    missing: async pins => pins.filter(pin => !objects.has(pin.sha256)).map(pin => pin.sha256),
    upload: async (pin, bytes) => {
      objects.set(pin.sha256, bytes);
    },
    publish: async pin => pin.sha256,
  };
  const pushed = await pushNativeExchange(f.store, f.store.revision(), randomUUID(), transport);
  const manifest = JSON.parse(objects.get(pushed.digest));
  const raw = readFileSync(join(f.folder, 'stdout.log'));
  const rawDigest = digest(raw);
  manifest.files.push({ path: `check-${f.run.id}/stdout.log`, sha256: rawDigest, size: raw.length });
  delete manifest.checkLogs;
  const json = JSON.stringify(manifest);
  transport.manifest = async () => ({ json, digest: digest(json), size: Buffer.byteLength(json) });
  transport.download = async pin => {
    assert.notEqual(pin.sha256, rawDigest, 'provider logs must never be downloaded');
    return objects.get(pin.sha256);
  };
  await pullNativeExchange('synthetic', join(f.root, 'pulled'), transport);
});
test('compact framing retains split machine reports, coverage and bounded failure context, drops passing chatter', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-compact-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'output.evidence'),
    writer = new CompactCheckWriter(file);
  const marker =
    '__FORGE_TESTS__{"file":"tests/a.test.mjs","complete":true,"durationMs":7,"results":[{"name":"fails","passed":false}]}\n';
  writer.append('ordinary-provider-chatter\n' + marker.slice(0, 45));
  writer.append(marker.slice(45) + 'not ok 1 - fails\n  ---\n  error: expected value');
  writer.finish(true);
  const text = readFileSync(file, 'utf8');
  assert(!text.includes('ordinary-provider-chatter'));
  assert(text.includes(marker));
  assert(text.includes('  ---\n  error: expected value'));
  assert(
    compactCheckText(
      '__FORGE_COVERAGE__{"version":1,"test":"tests/a.test.mjs","head":"synthetic","complete":true,"touched":[]}\n',
    ).includes('__FORGE_COVERAGE__'),
  );
  const coverage =
    '__FORGE_COVERAGE__{"version":1,"test":"tests/a.test.mjs","head":"synthetic","complete":true,"touched":[]}';
  const coverageFile = join(directory, 'coverage.evidence'),
    coverageWriter = new CompactCheckWriter(coverageFile);
  coverageWriter.append(coverage);
  coverageWriter.finish(false);
  assert.equal(readFileSync(coverageFile, 'utf8'), coverage + '\n');
  assert(compactCheckText('Error: ' + 'e'.repeat(100_000)).length <= 4097);
});
test('local retention dry-run changes nothing, expiry removes full logs and keeps reports/results', t => {
  const f = fixture(t, 'local');
  const date = new Date(now - 8 * DAY_MS);
  const data = f.store.load();
  data.runs[0].endedAt = date.toISOString();
  data.revision++;
  f.store.save(data);
  for (const name of ['stdout.log', 'stderr.log']) utimesSync(join(f.folder, name), date, date);
  const plan = cleanLocalCheckLogs(f.store, { now });
  assert.equal(plan.files.length, 2);
  const late = join(f.folder, 'late.log');
  writeFileSync(late, 'became eligible after planning', { mode: 0o600 });
  utimesSync(late, date, date);
  assert(existsSync(join(f.folder, 'stdout.log')));
  const before = checkEvidenceFingerprint(f.store.load().runs[0]);
  assert.equal(cleanLocalCheckLogs(f.store, { now, apply: true, files: plan.files }).deleted, 2);
  assert(existsSync(join(f.folder, 'result.json')));
  assert(existsSync(join(f.folder, 'test-reports.json')));
  assert.equal(checkEvidenceFingerprint(f.store.load().runs[0]), before);
  assert.equal(cleanLocalCheckLogs(f.store, { now, apply: true, files: plan.files }).deleted, 0);
  assert(existsSync(late), 'a reviewed plan never expands to a newly eligible log');
});
test('provider cleanup command requires its dry-run and replays without altering evidence', async t => {
  const f = fixture(t),
    path = join(f.root, 'cleanup-plan.json');
  await checkLogsCli([f.root, '--dry-run', '--plan', path]);
  assert(existsSync(join(f.folder, 'stdout.log')));
  const applied = await checkLogsCli([f.root, '--apply', '--plan', path]);
  assert.equal(applied.local.deleted, 2);
  assert.equal((await checkLogsCli([f.root, '--apply', '--plan', path])).local.deleted, 0);
  assert.deepEqual([...checkEvidenceLines(f.folder)].filter(Boolean).length, 1);
});
test('storage deletion protects aliases and recipe chunks shared with source or an unexpired local log', t => {
  const f = fixture(t);
  const files = [
    { path: `check-${f.run.id}/stdout.log`, sha256: 'log', size: 100 },
    { path: 'objects/source', sha256: 'source', size: 2 },
  ];
  const edges = new Map([
    ['log', ['recipe']],
    ['recipe', ['shared', 'exclusive']],
    ['source', ['shared']],
  ]);
  const plan = checkLogStoragePlan([{ id: 'backup', files, data: f.store.load() }], edges);
  assert.deepEqual(plan.digests, ['exclusive', 'log', 'recipe']);
  assert.deepEqual(plan.shared, ['shared']);
});
test('synthetic realistic export and seed closure byte measurements', async t => {
  const f = fixture(t, 'github-actions', 12, 3 * 1024 * 1024);
  const exported = await exportNativeWork(f.store, f.store.revision(), false),
    manifest = JSON.parse(exported.result.json);
  const afterExport = manifest.files.reduce((sum, file) => sum + file.size, 0);
  const legacyFiles = f.store
    .load()
    .runs.flatMap(run =>
      ['stdout.log', 'stderr.log'].map(name =>
        readFileSync(join(f.store.directory, `check-${run.id}`, name)),
      ),
    );
  const excluded = legacyFiles.reduce((sum, bytes) => sum + bytes.length, 0);
  const seed = await prepareHostedSeed(f.store, f.store.revision(), randomUUID());
  const afterSeed = seed.pages.flat().reduce((sum, pin) => sum + pin.size, 0);
  console.log(
    'BYOCI synthetic bytes',
    JSON.stringify({
      exportBefore: afterExport + excluded,
      exportAfter: afterExport,
      seedClosureBefore: afterSeed + excluded,
      seedClosureAfter: afterSeed,
      excludedLogBytes: excluded,
      baseline: 'old closure file enumeration over the same synthetic owner',
    }),
  );
  assert(excluded > 72 * 1024 * 1024);
  assert(afterExport < excluded / 100);
  assert(afterSeed < excluded / 50);
});

test('hosted cleanup dry-run/apply deletes Convex and R2 log objects, preserves shared source, and retries', async t => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const { fixture: hostedFixture, modules, upload } = await import('./project-exchange-fixture.mjs');
  for (const name of ['projectCheckLogCleanup', 'projectCheckLogCleanupStore'])
    modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
  const f = fixture(t),
    s = hostedFixture();
  for (const table of [
    'projectCheckLogCleanups',
    'projectHostedStates',
    'projectHostedOutputChunks',
    'projectHostedOutputStreams',
    'projectHostedCheckRuns',
    'projectCheckLogRetentions',
  ])
    s.tables[table] = new Map();
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  const exported = await exportNativeWork(f.store, f.store.revision(), false);
  const manifest = JSON.parse(exported.result.json);
  const providerPins = [];
  for (const name of ['stdout.log', 'stderr.log']) {
    const bytes = readFileSync(join(f.folder, name)),
      pin = await upload(s, bytes);
    providerPins.push(pin);
    manifest.files.push({ path: `check-${f.run.id}/${name}`, ...pin });
  }
  // Another retained non-log member aliases one logical hash: preserve those exact bytes.
  manifest.files.push({ path: `objects/${providerPins[0].sha256}`, ...providerPins[0] });
  for (const file of manifest.files.filter(file => !providerPins.some(pin => pin.sha256 === file.sha256)))
    await upload(s, readFileSync(join(exported.result.path, file.path)));
  const root = await upload(s, Buffer.from(JSON.stringify(manifest)));
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    projectId: 'project',
    transport: 'objects',
    digest: root.sha256,
    size: root.size,
    status: 'stored',
    preview: { manifestDigest: root.sha256 },
    operationId: randomUUID(),
    _creationTime: 1,
  });
  const logRow = [...s.tables.projectObjects.values()].find(row => row.digest === providerPins[1].sha256);
  // A fake committed R2 copy plus the Convex copy exercise both delete paths.
  Object.assign(logRow, {
    location: 'r2',
    r2Committed: true,
    r2Key: `v1/p/project/objects/${logRow.digest}`,
  });
  const env = { ...process.env },
    fetch = globalThis.fetch;
  t.after(() => {
    process.env = env;
    globalThis.fetch = fetch;
  });
  Object.assign(process.env, {
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'fixture',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  });
  const deletes = [];
  globalThis.fetch = async (url, input) => {
    assert.equal(input.method, 'DELETE');
    deletes.push(String(url));
    return new Response(null, { status: 204 });
  };
  const operationId = randomUUID(),
    clean = modules.projectCheckLogCleanup.clean;
  let dry = JSON.parse(await clean._handler(s.ctx, { projectId: 'project', operationId }));
  const { saveObject } = await import(moduleUrl('../convex/projectHostedSaveStore.ts'));
  await saveObject(s.ctx, 'project', providerPins[0]);
  assert.equal(s.tables.projectCheckLogSourcePins.size, 1);
  await assert.rejects(
    clean._handler(s.ctx, {
      projectId: 'project',
      operationId,
      apply: true,
      expectedPlan: dry.planDigest,
    }),
    /EVIDENCE_CHANGED|exact reviewed cleanup plan/,
  );
  assert(logRow.storageId);
  dry = JSON.parse(await clean._handler(s.ctx, { projectId: 'project', operationId }));
  assert.equal(dry.objects, 1);
  assert(dry.shared.includes(providerPins[0].sha256));
  assert.equal(deletes.length, 0);
  const applied = JSON.parse(
    await clean._handler(s.ctx, {
      projectId: 'project',
      operationId,
      apply: true,
      expectedPlan: dry.planDigest,
    }),
  );
  assert.equal(applied.deleted, 1);
  assert.equal(applied.complete, true);
  assert.equal(deletes.length, 1);
  assert.equal(s.tables.projectObjects.get(logRow._id).r2Committed, false);
  assert([...s.tables.projectObjects.values()].find(row => row.digest === providerPins[0].sha256).storageId);
  const replay = JSON.parse(
    await clean._handler(s.ctx, {
      projectId: 'project',
      operationId,
      apply: true,
      expectedPlan: dry.planDigest,
    }),
  );
  assert.equal(replay.deleted, 1);
  assert.equal(deletes.length, 1);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'stranger' });
  await assert.rejects(clean._handler(s.ctx, { projectId: 'project', operationId: randomUUID() }));
});

test('uploaded-log expiry wakes only on lifecycle events when an indexed expiry is due', async () => {
  const { fixture: hostedFixture, modules } = await import('./project-exchange-fixture.mjs');
  const s = hostedFixture(),
    calls = [];
  s.ctx.scheduler.runAfter = async (...args) => {
    calls.push(args);
    return 'synthetic-wake';
  };
  await modules.projectCheckLogRetention.register._handler(s.ctx, {
    projectId: 'project',
    actor: 'owner',
    entries: [{ key: 'future', expiresAt: Date.now() + DAY_MS }],
  });
  assert.equal(calls.length, 0, 'no idle expiry timer');
  await modules.projectCheckLogRetention.register._handler(s.ctx, {
    projectId: 'project',
    actor: 'owner',
    entries: [{ key: 'due', expiresAt: Date.now() - 1 }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 0);
  assert.equal(
    JSON.parse(await modules.projectCheckLogRetention.due._handler(s.ctx, { projectId: 'project' })).entries
      .length,
    1,
  );
});
for (const shared of [false, true])
  test(`legacy hosted streamed cleanup preserves shared artifact chunks (${shared}), hashes and summaries`, async t => {
    const { moduleUrl } = await import('./convex-module.mjs');
    const { fixture: hostedFixture, modules } = await import('./project-exchange-fixture.mjs');
    const { purgeHostedLogStream } = await import(moduleUrl('../convex/projectHostedLogCleanup.ts'));
    const s = hostedFixture();
    s.tables.projectHostedOutputChunks = new Map();
    const runId = randomUUID(),
      streamId = digest('synthetic-stream'),
      descriptor = { shard: 0, attempt: 0, executionId: '123', stream: 'stdout', name: '' };
    const raw = Buffer.from(
      'ordinary-provider-chatter\n__FORGE_TESTS__{"file":"tests/fails.test.mjs","complete":true,"durationMs":12,"results":[{"name":"synthetic failure","passed":false}]}\nnot ok 1 - synthetic failure\n',
    );
    const object = { sha256: digest(raw), size: raw.length },
      original = { stream: descriptor, object, sequence: 0, offset: 0 };
    s.tables.projectHostedOutputStreams.set('stream', {
      _id: 'stream',
      projectId: 'project',
      runId,
      streamId,
      descriptor: JSON.stringify(descriptor),
      chunks: 1,
      bytes: raw.length,
      maxSequence: 0,
      seal: null,
    });
    s.tables.projectHostedOutputChunks.set('chunk', {
      _id: 'chunk',
      projectId: 'project',
      runId,
      streamId,
      sequence: 0,
      revision: 1,
      value: JSON.stringify(original),
    });
    if (shared) {
      s.tables.projectHostedOutputStreams.set('artifact', {
        ...s.tables.projectHostedOutputStreams.get('stream'),
        _id: 'artifact',
        streamId: 'artifact',
        descriptor: JSON.stringify({ ...descriptor, stream: 'artifact', name: 'build.log' }),
      });
      s.tables.projectHostedOutputChunks.set('artifact-chunk', {
        ...s.tables.projectHostedOutputChunks.get('chunk'),
        _id: 'artifact-chunk',
        streamId: 'artifact',
        value: JSON.stringify({
          ...original,
          stream: { ...descriptor, stream: 'artifact', name: 'build.log' },
        }),
      });
    }
    const fetch = globalThis.fetch,
      env = { ...process.env };
    t.after(() => {
      globalThis.fetch = fetch;
      process.env = env;
    });
    Object.assign(process.env, {
      R2_ACCOUNT_ID: 'synthetic',
      R2_BUCKET: 'fixture',
      R2_ACCESS_KEY_ID: 'synthetic',
      R2_SECRET_ACCESS_KEY: 'synthetic',
    });
    let gets = 0,
      deletes = 0;
    globalThis.fetch = async (_url, input = {}) =>
      input.method === 'DELETE'
        ? (deletes++, new Response(null, { status: 204 }))
        : (gets++, new Response(raw));
    const input = { projectId: 'project', actor: 'owner', runId, streamId };
    assert.equal(await purgeHostedLogStream(s.ctx, input), raw.length);
    assert.equal(gets, 1);
    assert.equal(deletes, shared ? 0 : 1);
    assert.equal(s.tables.projectHostedOutputStreams.get('stream').retired, true);
    const compact = [...s.tables.projectHostedOutputSummaries.values()].map(row => row.text).join('');
    assert(compact.includes('__FORGE_TESTS__'));
    assert(compact.includes('synthetic failure'));
    assert(!compact.includes('ordinary-provider-chatter'));
    assert.equal(
      s.tables.projectHostedOutputChunks.get('chunk').value,
      JSON.stringify(original),
      'original evidence hashes remain unchanged',
    );
    await purgeHostedLogStream(s.ctx, input);
    assert.equal(gets, 1);
    assert.equal(deletes, shared ? 0 : 2, 'shared artifact keys are retained; other DELETEs are idempotent');
  });

test('Mac pipe logs stay in private machine files and expire on a later check start', async t => {
  const { localMacLogFiles } = await import('../dist/check-local-log-files.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-local-mac-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runId = randomUUID(),
    logs = localMacLogFiles('synthetic', runId, root);
  async function* bytes() {
    yield Buffer.from('full local chatter\n');
  }
  for await (const _bytes of logs.stream(bytes(), 'stdout')) {
    /* Pipe drained. */
  }
  assert.equal(readFileSync(join(logs.directory, 'stdout.log'), 'utf8'), 'full local chatter\n');
  assert.equal((await import('node:fs')).statSync(join(logs.directory, 'stdout.log')).mode & 0o077, 0);
  logs.complete();
  writeFileSync(
    join(logs.directory, 'completed.json'),
    JSON.stringify({ endedAt: new Date(now - 8 * DAY_MS).toISOString() }),
  );
  localMacLogFiles('synthetic', randomUUID(), root, now);
  assert.equal(existsSync(logs.directory), false);
  const orphan = localMacLogFiles('synthetic', randomUUID(), root, now - 8 * DAY_MS);
  for await (const _bytes of orphan.stream(bytes(), 'stdout')) {
    /* Pipe drained. */
  }
  utimesSync(join(orphan.directory, 'stdout.log'), new Date(now - 8 * DAY_MS), new Date(now - 8 * DAY_MS));
  writeFileSync(
    join(orphan.directory, 'owner.json'),
    JSON.stringify({
      startedAt: new Date(now - 8 * DAY_MS).toISOString(),
      runner: { pid: 2147483647, startTime: 'synthetic-dead' },
    }),
  );
  const active = localMacLogFiles('synthetic', randomUUID(), root, now - 8 * DAY_MS);
  localMacLogFiles('synthetic', randomUUID(), root, now);
  assert.equal(
    existsSync(orphan.directory),
    false,
    'a crashed collector cannot retain orphaned logs forever',
  );
  assert.equal(existsSync(active.directory), true, 'a live collector keeps its current log files');
});

test('hosted summary seals keep failing names and redact their bounded diagnostic excerpt', async () => {
  const { compactProviderOutput } = await import('../dist/check-compact-output.js');
  const { collectHostedOutput } = await import('../dist/hosted-output-collector.js');
  const retained = [],
    marker =
      '__FORGE_TESTS__{"file":"tests/fails.test.mjs","complete":true,"durationMs":12,"results":[{"name":"fails","passed":false}]}\n';
  async function* source() {
    yield Buffer.from('ordinary-chatter\n' + marker + 'Error: synthetic-private');
  }
  let summary = '';
  const seal = await collectHostedOutput(
    compactProviderOutput(source(), value => {
      summary = value;
    }),
    { kind: 'summary', shard: 0, attempt: 0, executionId: 'synthetic', stream: 'stdout', name: '' },
    { secrets: ['synthetic-private'], paths: [] },
    {
      retain: async (_chunk, bytes) => {
        retained.push(Buffer.from(bytes));
      },
      publish: async () => {},
      seal: async () => {},
    },
    65536,
    true,
    () => summary,
  );
  assert(seal.failureSummary.includes('tests/fails.test.mjs'));
  assert(seal.failureSummary.includes('[redacted]'));
  assert(!seal.failureSummary.includes('synthetic-private'));
  assert(seal.failureSummary.length <= 4096);
  assert(!Buffer.concat(retained).toString().includes('ordinary-chatter'));
  async function* coverageSource() {
    yield Buffer.from(
      '__FORGE_COVERAGE__{"version":1,"test":"tests/fails.test.mjs","head":"synthetic","complete":true,"touched":[]}',
    );
  }
  const coverageChunks = [];
  for await (const bytes of compactProviderOutput(coverageSource())) coverageChunks.push(Buffer.from(bytes));
  assert(Buffer.concat(coverageChunks).toString().startsWith('__FORGE_COVERAGE__'));
});
