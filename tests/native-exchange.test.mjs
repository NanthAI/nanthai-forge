import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { NativeSource } from '../dist/native-source.js';
import { pushNativeExchange, pullNativeExchange, prepareNativeExchange } from '../dist/native-exchange.js';
import { digest } from '../dist/hash.js';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-exchange-test-')),
    root = join(dir, 'owner');
  mkdirSync(root);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'large.bin'), Buffer.alloc(256 * 1024, 25));
  initNative(root);
  const w = new WorkService(root),
    act = c => w.execute(c, w.status().revision).result;
  const intent = act({ action: 'intent', outcome: 'Exchange one edit' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Change' });
  const objects = new Map(),
    snapshots = new Map();
  let uploads = 0;
  const transport = {
    missing: async pins => pins.filter(p => !objects.has(p.sha256)).map(p => p.sha256),
    upload: async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      assert.equal(bytes.length, pin.size);
      objects.set(pin.sha256, Buffer.from(bytes));
      uploads++;
    },
    publish: async pin => {
      snapshots.set(pin.sha256, pin);
      return pin.sha256;
    },
    manifest: async id => ({ json: objects.get(id).toString(), digest: id, size: snapshots.get(id).size }),
    download: async pin => Buffer.from(objects.get(pin.sha256)),
  };
  return { dir, root, w, act, intent, lane, objects, transport, uploads: () => uploads };
}
test('native object exchange reuses history and unchanged large files, retries without uploads, and restores original IDs without archives', async t => {
  const f = fixture(t),
    operation = randomUUID(),
    revision = f.w.status().revision;
  const first = await pushNativeExchange(f.w.store, revision, operation, f.transport);
  assert.ok(first.uploadedBytes > 256 * 1024);
  const retry = await pushNativeExchange(f.w.store, revision, operation, f.transport);
  assert.equal(retry.backupId, first.backupId);
  assert.deepEqual(retry.ownerDerived, first.ownerDerived, 'retry pins identical owner-derived bytes');
  assert.equal(retry.uploadedObjects, 0);
  writeFileSync(join(f.w.store.path(f.lane.id), 'source.ts'), 'export const value = 2;\n');
  const observed = f.w.status().lanes[0];
  f.act({
    action: 'checkpoint',
    laneId: f.lane.id,
    expectedHead: observed.head,
    expectedTree: observed.indexTree,
    message: 'One edit',
  });
  const next = await pushNativeExchange(f.w.store, f.w.status().revision, randomUUID(), f.transport);
  assert.ok(
    next.uploadedBytes < 12 * 1024,
    `Only changed source, State, Work and manifest: ${next.uploadedBytes}`,
  );
  assert.ok(next.reusedObjects >= 3);
  assert.equal(next.archiveCreated, false);
  assert.equal(
    readdirSync(f.w.store.directory).some(
      name => name.startsWith('native-backup-') || name.endsWith('.tar.gz'),
    ),
    false,
  );
  const target = join(f.dir, 'restored');
  const restored = await pullNativeExchange(next.backupId, target, f.transport, { cacheRoot: f.root });
  assert.ok(restored.reusedBytes >= 256 * 1024);
  assert.ok(restored.downloadedBytes < 12 * 1024);
  const store = new WorkStore(target);
  assert.equal(store.load().lanes[0].id, f.lane.id);
  assert.equal(readFileSync(join(store.path(f.lane.id), 'source.ts'), 'utf8'), 'export const value = 2;\n');
  assert.equal(new NativeSource(target).ancestors(store.load().lanes[0].head).has(f.lane.base), true);
  await assert.rejects(
    pushNativeExchange(f.w.store, revision + 1, operation, f.transport),
    e => e.code === 'WORK_OPERATION_CHANGED',
  );
  await assert.rejects(
    pullNativeExchange(next.backupId, target, f.transport),
    e => e.code === 'RESTORE_TARGET_EXISTS',
  );
});
test('missing or corrupt exchange bytes never create a partial destination; original saved request survives an unknown publish reply', async t => {
  const f = fixture(t),
    op = randomUUID(),
    revision = f.w.status().revision,
    original = f.transport.publish;
  f.transport.publish = async pin => {
    await original(pin);
    throw new Error('lost response');
  };
  await assert.rejects(pushNativeExchange(f.w.store, revision, op, f.transport), /lost response/);
  f.transport.publish = original;
  const result = await pushNativeExchange(f.w.store, revision, op, f.transport);
  assert.equal(result.uploadedObjects, 0);
  f.transport.download = async () => Buffer.from('corrupt');
  await assert.rejects(
    pullNativeExchange(result.backupId, join(f.dir, 'never-created'), f.transport),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
  assert.ok(!readdirSync(f.dir).includes('never-created'));
});
test(
  'retained artifact bytes are reused across independent runs and restored as independent writable files',
  { timeout: 30000 },
  async t => {
    const f = fixture(t),
      view = f.act({
        action: 'compose',
        operationId: randomUUID(),
        intentId: f.intent.id,
        inputs: [{ laneId: f.lane.id, head: f.lane.head }],
      });
    const check = f.act({
      action: 'define-check',
      name: 'Artifact',
      executable: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('result.bin',Buffer.alloc(65536,42))"],
      artifactPaths: ['result.bin'],
    });
    async function run() {
      const operationId = randomUUID(),
        status = f.w.status();
      await f.w.dispatch(
        {
          action: 'run-check',
          operationId,
          viewId: view.id,
          expectedHead: view.head,
          checkId: check.id,
          expectedDefinition: check.definition,
          expectedEnvironment: status.environment.fingerprint,
        },
        status.revision,
      );
      for (let n = 0; n < 300; n++) {
        const run = f.w.status().runs.find(run => run.id === operationId);
        if (run?.status === 'passed') return run;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Check did not complete');
    }
    const firstRun = await run(),
      first = await pushNativeExchange(f.w.store, f.w.status().revision, randomUUID(), f.transport);
    const secondRun = await run(),
      second = await pushNativeExchange(f.w.store, f.w.status().revision, randomUUID(), f.transport);
    assert.ok(second.uploadedBytes < first.uploadedBytes - 65536);
    assert.equal(firstRun.artifacts[0].sha256, secondRun.artifacts[0].sha256);
    const restored = join(f.dir, 'artifacts');
    await pullNativeExchange(second.backupId, restored, f.transport);
    const owner = new WorkStore(restored),
      one = join(owner.directory, `check-${firstRun.id}/artifacts/artifact-0.bin`),
      two = join(owner.directory, `check-${secondRun.id}/artifacts/artifact-0.bin`);
    writeFileSync(one, 'changed');
    assert.equal(readFileSync(two).length, 65536);
  },
);
test('interrupted preparation cannot publish a partial retry manifest and concurrent same-operation preparation preserves original bytes', async t => {
  const f = fixture(t),
    operation = randomUUID(),
    revision = f.w.status().revision;
  const orphan = join(f.w.store.directory, `.exchange-${operation}-preparing-interrupted`);
  mkdirSync(orphan);
  writeFileSync(join(orphan, 'manifest.json'), '{partial');
  const [one, two] = await Promise.all([
    pushNativeExchange(f.w.store, revision, operation, f.transport),
    pushNativeExchange(f.w.store, revision, operation, f.transport),
  ]);
  assert.equal(one.backupId, two.backupId);
  assert.doesNotThrow(() =>
    JSON.parse(readFileSync(join(f.w.store.directory, `exchange-${operation}`, 'manifest.json'), 'utf8')),
  );
});
test('companion metadata preserves new lifecycle fields and promotes the received reader version without erasing local history', async () => {
  const { mergeCompanion } = await import('../dist/native-companion.js'),
    { workSchema } = await import('../dist/work-types.js');
  const intent = {
    id: randomUUID(),
    outcome: 'Task',
    constraints: '',
    base: 'a'.repeat(64),
    status: 'active',
    notes: [],
    createdAt: 'start',
  };
  const base = workSchema.parse({
      schema: 7,
      revision: 0,
      nativeHead: 'a'.repeat(64),
      intents: [intent],
      lanes: [],
      views: [],
    }),
    local = structuredClone(base),
    hosted = structuredClone(base);
  hosted.schema = 8;
  hosted.intents[0].status = 'completed';
  hosted.intents[0].lifecycle = [{ from: 'active', to: 'completed', at: 'done' }];
  const result = mergeCompanion(base, local, hosted);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.merged.schema, 8);
  assert.deepEqual(result.merged.intents[0].lifecycle, hosted.intents[0].lifecycle);
  local.intents[0].status = 'ready';
  local.intents[0].lifecycle = [{ from: 'active', to: 'ready', at: 'local' }];
  assert.ok(mergeCompanion(base, local, hosted).conflicts.some(item => item.field === 'status'));
  const common = structuredClone(hosted),
    changed = structuredClone(hosted);
  changed.intents[0].lifecycle = [];
  assert.ok(mergeCompanion(common, hosted, changed).conflicts.some(item => item.field === 'lifecycle'));
});
test('optional agent exchange tools disclose migration semantics and require account-token configuration', async t => {
  const { registerExchangeTools } = await import('../dist/mcp-exchange.js'),
    saved = process.env.FORGE_AUTH_TOKEN,
    savedConfig = process.env.XDG_CONFIG_HOME,
    config = mkdtempSync(join(tmpdir(), 'forge-exchange-auth-')),
    tools = [];
  t.after(() => rmSync(config, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  try {
    delete process.env.FORGE_AUTH_TOKEN;
    process.env.XDG_CONFIG_HOME = config;
    registerExchangeTools({ registerTool: (...args) => tools.push(args) }, '/unused');
    assert.equal(tools.length, 0);
    process.env.FORGE_AUTH_TOKEN = 'test-only';
    registerExchangeTools({ registerTool: (...args) => tools.push(args) }, '/unused');
    assert.deepEqual(
      tools.map(item => item[0]),
      ['forge_exchange', 'forge_migrate_archive'],
    );
    assert.equal(tools[1][1].annotations.destructiveHint, true);
    assert.match(tools[1][1].description, /compressed-container bytes/);
    assert.equal(
      tools[0][1].inputSchema.command.safeParse({ action: 'push', url: 'bad', projectId: 'x' }).success,
      false,
    );
  } finally {
    if (saved === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = saved;
    if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfig;
  }
});

test('fresh recovery downloads independent content concurrently and waits for sibling transfers before failure cleanup', async t => {
  const f = fixture(t),
    snapshot = await pushNativeExchange(f.w.store, f.w.status().revision, randomUUID(), f.transport);
  const download = f.transport.download;
  let active = 0,
    peak = 0,
    completed = 0;
  f.transport.download = async pin => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    const bytes = await download(pin);
    active--;
    completed++;
    return bytes;
  };
  const restored = await pullNativeExchange(snapshot.backupId, join(f.dir, 'fresh'), f.transport);
  assert.ok(peak > 1 && peak <= 8);
  assert.ok(restored.downloadedBytes > 256 * 1024);
  assert.equal(active, 0);
  const files = JSON.parse((await f.transport.manifest(snapshot.backupId)).json).files;
  assert.equal(completed, new Set(files.map(file => file.sha256)).size);
  let failed = false;
  f.transport.download = async pin => {
    if (!failed) {
      failed = true;
      throw new Error('remote transfer failed');
    }
    active++;
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return download(pin);
  };
  await assert.rejects(
    pullNativeExchange(snapshot.backupId, join(f.dir, 'failed'), f.transport),
    /remote transfer failed/,
  );
  assert.equal(active, 0);
  assert.ok(!readdirSync(f.dir).includes('failed'));
});
test('actual transfer receipts distinguish missing offers from objects concurrently stored or reconciled', async t => {
  const f = fixture(t);
  f.transport.uploadBatch = async content => {
    for (const { pin, bytes } of content) f.objects.set(pin.sha256, bytes);
    return { uploadedObjects: 0, uploadedBytes: 0 };
  };
  const result = await pushNativeExchange(f.w.store, f.w.status().revision, randomUUID(), f.transport);
  assert.equal(result.uploadedBytes, 0);
  assert.equal(result.uploadedObjects, 0);
  assert.equal(result.reusedObjects, result.objects);
  delete f.transport.uploadBatch;
  f.transport.missing = async pins => pins.map(pin => pin.sha256);
  f.transport.upload = async () => ({ uploadedObjects: 0, uploadedBytes: 0 });
  const retry = await pushNativeExchange(f.w.store, f.w.status().revision, randomUUID(), f.transport);
  assert.equal(retry.uploadedBytes, 0);
  assert.equal(retry.uploadedObjects, 0);
});
test('running output is pinned with the atomic request so appends do not break the original exchange retry', async t => {
  let releaseRun;
  t.after(async () => releaseRun?.());
  const { prepareNativeExchange } = await import('../dist/native-exchange.js');
  const f = fixture(t);
  const { policyPreset } = await import('../dist/autonomy-policy.js');
  const opted = f.w.store.load();
  opted.autonomyPolicy = { ...policyPreset('trusted'), checkLogs: { uploadLocal: true, retentionDays: 90 } };
  opted.revision++;
  f.w.store.save(opted);
  const view = f.act({
      action: 'compose',
      operationId: randomUUID(),
      intentId: f.intent.id,
      inputs: [{ laneId: f.lane.id, head: f.lane.head }],
    }),
    release = join(f.dir, 'release-log'),
    check = f.act({
      action: 'define-check',
      name: 'Live log',
      executable: process.execPath,
      args: [
        '-e',
        `const fs=require('node:fs');console.log('started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){console.log('later');clearInterval(timer)}},20);`,
      ],
    }),
    operationId = randomUUID(),
    status = f.w.status();
  await f.w.dispatch(
    {
      action: 'run-check',
      operationId,
      viewId: view.id,
      expectedHead: view.head,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: status.environment.fingerprint,
    },
    status.revision,
  );
  const output = join(f.w.store.directory, `check-${operationId}`, 'stdout.log');
  async function until(condition) {
    const end = Date.now() + 30000;
    while (!condition()) {
      assert.ok(Date.now() < end, 'live-log fixture did not reach its barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  // Hold the writer between messages: a real snapshot may reject a concurrent
  // append with SOURCE_CHANGED. This test exercises appends after preparation.
  releaseRun = async () => {
    writeFileSync(release, 'release');
    const { AgentWorkflow } = await import('../dist/agent-workflow.js');
    const observed = (
      await new AgentWorkflow(f.root).dispatch({ action: 'observe', operationId, waitMs: 30000 })
    ).result;
    assert.equal(observed.status, 'passed');
  };
  await until(() => existsSync(output) && readFileSync(output, 'utf8').includes('started'));
  f.w.store.locked(() => {
    const data = f.w.store.load();
    data.futureExtension = { retained: 'original' };
    data.runs.find(run => run.id === operationId).futureRunExtension = { retained: true };
    data.revision++;
    f.w.store.save(data);
  });
  const exchange = randomUUID(),
    revision = f.w.status().revision,
    prepared = await prepareNativeExchange(f.w.store, revision, exchange),
    stdout = prepared.manifest.files.find(file => file.path === `check-${operationId}/stdout.log`);
  assert.ok(stdout);
  const captured = readFileSync(join(prepared.directory, `pinned-${stdout.sha256}`));
  assert.equal(captured.toString(), 'started\n');
  writeFileSync(release, 'release');
  await until(() => readFileSync(output, 'utf8').includes('later'));
  assert.equal(readFileSync(output, 'utf8'), 'started\nlater\n');
  const first = await pushNativeExchange(f.w.store, revision, exchange, f.transport),
    retry = await pushNativeExchange(f.w.store, revision, exchange, f.transport);
  assert.equal(retry.uploadedBytes, 0);
  assert.equal(retry.backupId, first.backupId);
  assert.deepEqual(f.objects.get(stdout.sha256), captured);
  const restored = join(f.dir, 'live-snapshot');
  await pullNativeExchange(first.backupId, restored, f.transport);
  const recovered = new WorkStore(restored).load();
  assert.deepEqual(recovered.futureExtension, { retained: 'original' });
  assert.deepEqual(recovered.runs.find(run => run.id === operationId).futureRunExtension, { retained: true });
  assert.equal(recovered.runs.find(run => run.id === operationId).status, 'interrupted');
  // A hosted reconciliation overlays metadata onto the original capture rather
  // than taking another local snapshot or rereading a running log.
  const candidate = JSON.parse(readFileSync(join(prepared.directory, 'work.json'), 'utf8'));
  candidate.intents[0].notes.push({ kind: 'comment', text: 'Hosted observation', at: 'hosted' });
  candidate.revision++;
  f.act({ action: 'note', intentId: f.intent.id, kind: 'comment', text: 'Later local observation' });
  const derivedId = randomUUID(),
    derived = await pushNativeExchange(f.w.store, candidate.revision, derivedId, f.transport, {
      pinCurrent: true,
      captured: { directory: prepared.directory, data: candidate },
    });
  assert.deepEqual(f.objects.get(stdout.sha256), captured);
  const derivedTarget = join(f.dir, 'derived-snapshot');
  await pullNativeExchange(derived.backupId, derivedTarget, f.transport);
  assert.deepEqual(new WorkStore(derivedTarget).load().intents[0].notes, candidate.intents[0].notes);
  assert.equal(f.w.store.load().intents[0].notes.at(-1).text, 'Later local observation');
  const derivedRetry = await pushNativeExchange(f.w.store, candidate.revision, derivedId, f.transport, {
    pinCurrent: true,
  });
  assert.equal(derivedRetry.backupId, derived.backupId);
  assert.equal(derivedRetry.uploadedBytes, 0);
});
test('retained closure validates overlapping roots once per unique object and rechecks changed bytes on the next operation', async t => {
  const { nativeReachable } = await import('../dist/native-reachable.js'),
    f = fixture(t),
    source = new NativeSource(f.root),
    data = f.w.store.load();
  let head = data.nativeHead;
  for (let i = 0; i < 20; i++) {
    head = source.writeState(source.state(head).files, [head], `Shared ancestry ${i}`, `time-${i}`);
    data.intents.push({ ...data.intents[0], id: randomUUID(), base: head });
  }
  data.nativeHead = head;
  const original = NativeSource.prototype.object,
    reads = new Map();
  NativeSource.prototype.object = function (id) {
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return original.call(this, id);
  };
  let ids;
  try {
    ids = nativeReachable(f.w.store, data);
  } finally {
    NativeSource.prototype.object = original;
  }
  assert.equal(
    [...reads.values()].reduce((n, value) => n + value, 0),
    ids.length,
  );
  assert.ok(reads.size > 20);
  const file = source.state(head).files.find(file => file.path === 'large.bin');
  writeFileSync(join(source.directory, file.blob), 'changed');
  assert.throws(
    () => nativeReachable(f.w.store, data),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
});
test('logical archive validation preserves original bytes and cleans scratch on failure without materializing Lanes', async t => {
  const { exportNativeWork } = await import('../dist/native-backup.js'),
    { withValidatedNativeArchive } = await import('../dist/native-archive-validation.js'),
    f = fixture(t);
  const exported = await exportNativeWork(f.w.store, f.w.status().revision, false),
    directory = exported.result.path,
    manifestBytes = readFileSync(join(directory, 'manifest.json')),
    workBytes = readFileSync(join(directory, 'work.json'));
  await assert.rejects(
    withValidatedNativeArchive(directory, async validated => {
      assert.equal(
        readdirSync(validated.directory).some(name => name.startsWith('lane-')),
        false,
      );
      assert.deepEqual(readFileSync(join(validated.directory, 'work.json')), workBytes);
      throw new Error('stop after validation');
    }),
    /stop after validation/,
  );
  assert.deepEqual(readFileSync(join(directory, 'manifest.json')), manifestBytes);
  assert.deepEqual(readFileSync(join(directory, 'work.json')), workBytes);
  const manifest = JSON.parse(manifestBytes),
    blob = new NativeSource(f.root).state(f.w.store.load().nativeHead).files[0].blob;
  manifest.files = manifest.files.filter(file => file.path !== `objects/${blob}`);
  rmSync(join(directory, 'objects', blob));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(
    withValidatedNativeArchive(directory, async () => assert.fail('Invalid closure reached transfer')),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
  assert.ok(readdirSync(directory).includes('work.json'));
});

test('native push selects optional file transport for large source while retaining raw metadata and old transports', async t => {
  const f = fixture(t),
    bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 41);
  writeFileSync(join(f.w.store.path(f.lane.id), 'large.bin'), bytes);
  const observed = f.w.status().lanes[0];
  f.act({
    action: 'checkpoint',
    laneId: f.lane.id,
    expectedHead: observed.head,
    expectedTree: observed.indexTree,
    message: 'Large streamed source',
  });
  const called = [];
  f.transport.uploadFile = async (pin, root, path) => {
    called.push({ pin, root, path });
    const content = readFileSync(join(root, path));
    assert.equal(digest(content), pin.sha256);
    assert.equal(content.length, pin.size);
    f.objects.set(pin.sha256, content);
    return { uploadedObjects: 1, uploadedBytes: content.length, uploadedLogicalObjects: 1 };
  };
  const result = await pushNativeExchange(f.w.store, f.w.status().revision, randomUUID(), f.transport);
  assert.equal(called.length, 1);
  assert.equal(called[0].pin.sha256, digest(bytes));
  assert.match(called[0].path, /^objects\//);
  assert(result.uploadedBytes > bytes.length);
  const restored = join(f.dir, 'streamed-recovery');
  await pullNativeExchange(result.backupId, restored, f.transport);
  assert.deepEqual(readFileSync(join(new WorkStore(restored).path(f.lane.id), 'large.bin')), bytes);
});

test('exchange source traversal releases the owner lock and preserves concurrent Work and collection', async t => {
  const f = fixture(t),
    store = f.w.store,
    revision = store.revision(),
    original = NativeSource.prototype.object;
  const { existsSync } = await import('node:fs');
  const { nativeObjects } = await import('../dist/native-objects.js');
  let traversed = false;
  NativeSource.prototype.object = function (...args) {
    if (this.owner === store.root && !traversed) {
      assert.equal(existsSync(join(store.directory, 'lock')), false);
      traversed = true;
      const peer = new WorkStore(store.root);
      peer.locked(() => {
        const tx = peer.records();
        tx.patchFields('lanes', f.lane.id, { name: 'Concurrent writer survived' });
        peer.commitRecords(tx);
      });
      nativeObjects(peer, { action: 'collect-native-objects' });
    }
    return original.apply(this, args);
  };
  try {
    const pushed = await pushNativeExchange(store, revision, randomUUID(), f.transport);
    assert.equal(traversed, true);
    assert.ok(pushed.backupId);
    assert.equal(store.revision(), revision + 1);
    assert.equal(store.select('lanes', f.lane.id).name, 'Concurrent writer survived');
    const restored = join(f.dir, 'pinned-snapshot');
    await pullNativeExchange(pushed.backupId, restored, f.transport);
    assert.equal(new WorkStore(restored).revision(), revision);
    assert.equal(new WorkStore(restored).select('lanes', f.lane.id).name, f.lane.name);
  } finally {
    NativeSource.prototype.object = original;
  }
});

test('a published baseline reuses unchanged source and negotiation while owner diffstats read changed bytes, and corrupt hints fall back', async t => {
  const f = fixture(t);
  let previous;
  f.transport.checkpointKey = (id = previous) => id && `synthetic-project/${id}`;
  const first = await pushNativeExchange(f.w.store, f.w.store.revision(), randomUUID(), f.transport);
  previous = first.backupId;
  const oldBlobs = new Set(new NativeSource(f.root).state(f.lane.base).files.map(file => file.blob));
  writeFileSync(join(f.w.store.path(f.lane.id), 'source.ts'), 'export const value = 3;\n');
  const selected = f.w.status().lanes[0];
  f.act({
    action: 'checkpoint',
    laneId: f.lane.id,
    expectedHead: selected.head,
    expectedTree: selected.indexTree,
    message: 'Delta with retained baseline',
  });
  const object = NativeSource.prototype.object,
    missing = f.transport.missing;
  let retainedReads = 0,
    negotiated = 0;
  NativeSource.prototype.object = function (id) {
    if (oldBlobs.has(id)) retainedReads++;
    return object.call(this, id);
  };
  t.after(() => {
    NativeSource.prototype.object = object;
  });
  f.transport.missing = pins => {
    negotiated += pins.length;
    return missing(pins);
  };
  const next = await pushNativeExchange(f.w.store, f.w.store.revision(), randomUUID(), f.transport);
  assert.equal(retainedReads, 1, 'owner diffstats read the previous changed-file bytes once');
  assert.ok(negotiated < next.objects, `${negotiated} of ${next.objects} pins negotiated`);
  assert.ok(next.uploadedBytes < 12 * 1024);
  previous = next.backupId;
  for (const name of readdirSync(f.w.store.directory).filter(name => name.startsWith('exchange-baseline-')))
    writeFileSync(join(f.w.store.directory, name), '{corrupt local hint');
  retainedReads = 0;
  const fallback = await pushNativeExchange(f.w.store, f.w.store.revision(), randomUUID(), f.transport);
  assert.ok(retainedReads > 0);
  assert.equal(fallback.archiveCreated, false);
});

test('preparation hints distinguish validated State identities from retained file blobs', async t => {
  const f = fixture(t);
  let previous;
  f.transport.checkpointKey = (id = previous) => id && `typed-source/${id}`;
  const saved = await pushNativeExchange(f.w.store, f.w.store.revision(), randomUUID(), f.transport);
  previous = saved.backupId;
  const source = new NativeSource(f.root),
    blob = source.state(f.lane.base).files[0].blob;
  const data = f.w.store.load();
  data.intents.find(item => item.id === f.intent.id).base = blob;
  data.revision++;
  f.w.store.save(data);
  await assert.rejects(
    pushNativeExchange(f.w.store, data.revision, randomUUID(), f.transport),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
});

test('push pins its original snapshot while another writer advances Work during upload and lost publication replies reconcile', async t => {
  const f = fixture(t),
    operationId = randomUUID(),
    revision = f.w.store.revision();
  const { retryExchange } = await import('../dist/exchange-retry.js');
  const originalMissing = f.transport.missing;
  let moved = false,
    publications = 0,
    accepted;
  f.transport.missing = async pins => {
    if (!moved) {
      moved = true;
      f.act({
        action: 'note',
        intentId: f.intent.id,
        kind: 'comment',
        text: 'Concurrent synthetic metadata write',
      });
    }
    return originalMissing(pins);
  };
  f.transport.publish = async pin => {
    publications++;
    if (!accepted) {
      accepted = pin.sha256;
      throw Error('INTERNAL_ERROR after commit');
    }
    assert.equal(pin.sha256, accepted);
    return accepted;
  };
  f.transport.published = async () => accepted ?? null;
  const result = await retryExchange(
    'checkpoint publication',
    operationId,
    () => pushNativeExchange(f.w.store, revision, operationId, f.transport),
    { delayMs: 0, localSnapshot: true },
  );
  assert.equal(result.backupId, accepted);
  assert.equal(result.revision, revision);
  assert.ok(f.w.store.revision() > revision);
  assert.equal(publications, 1);
  const again = await pushNativeExchange(f.w.store, revision, operationId, f.transport);
  assert.equal(again.backupId, result.backupId);
  assert.equal(publications, 1);
});

test('large owner sidecars use their prepared directory with file transport', async t => {
  const f = fixture(t),
    operationId = randomUUID(),
    revision = f.w.store.revision();
  const prepared = await prepareNativeExchange(f.w.store, revision, operationId);
  const path = join(prepared.directory, 'owner-derived.json');
  const bytes = Buffer.concat([readFileSync(path), Buffer.alloc(2 * 1024 * 1024, 32)]);
  writeFileSync(path, bytes);
  let sidecars = 0;
  f.transport.uploadFile = async (pin, root, file) => {
    assert.equal(file, 'owner-derived.json');
    assert.equal(root, prepared.directory);
    sidecars++;
    await f.transport.upload(pin, readFileSync(join(root, file)));
    return { uploadedObjects: 1, uploadedBytes: pin.size };
  };
  const result = await pushNativeExchange(f.w.store, revision, operationId, f.transport);
  assert.equal(sidecars, 1);
  assert.deepEqual(result.ownerDerived, { sha256: digest(bytes), size: bytes.length });
});

test('optional owner derivation cache failures retain computed sidecar rows', async t => {
  const f = fixture(t);
  mkdirSync(join(f.w.store.directory, 'owner-derived-cache.json'));
  const result = await pushNativeExchange(f.w.store, f.w.store.revision(), randomUUID(), f.transport);
  assert.ok(result.ownerDerived, 'cache persistence does not discard computed owner data');
  assert.equal(result.archiveCreated, false);
});

test('a missing retained display document is recomputed from pinned Work before upload', async t => {
  const f = fixture(t),
    operationId = randomUUID(),
    revision = f.w.store.revision();
  const prepared = await prepareNativeExchange(f.w.store, revision, operationId);
  rmSync(join(prepared.directory, 'owner-derived.json'));
  const result = await pushNativeExchange(f.w.store, revision, operationId, f.transport);
  assert.ok(result.ownerDerived);
  assert.equal(JSON.parse(readFileSync(join(prepared.directory, 'owner-derived.json'))).schema, 3);
});

test('receipt replay reports the stored display pin after local display metadata changes', async t => {
  const f = fixture(t),
    operationId = randomUUID(),
    revision = f.w.store.revision();
  const first = await pushNativeExchange(f.w.store, revision, operationId, f.transport);
  f.transport.published = async () => first.backupId;
  f.transport.publishedOwnerDerived = async id => {
    assert.equal(id, first.backupId);
    return first.ownerDerived;
  };
  f.transport.missing = async () => {
    throw Error('receipt replay must not negotiate again');
  };
  const prepared = await prepareNativeExchange(f.w.store, revision, operationId);
  writeFileSync(join(prepared.directory, 'owner-derived.json'), JSON.stringify({ schema: 3, changed: true }));
  const retry = await pushNativeExchange(f.w.store, revision, operationId, f.transport);
  assert.deepEqual(retry.ownerDerived, first.ownerDerived);
  assert.equal(retry.uploadedObjects, 0);
});

test('owner display capability is queried only after the durable snapshot and capture callback', async t => {
  const f = fixture(t),
    operationId = randomUUID(),
    revision = f.w.store.revision();
  let captured = false;
  f.transport.ownerDisplayBaseline = async () => {
    assert.equal(captured, true);
    const preparedWork = JSON.parse(
      readFileSync(join(f.w.store.directory, `exchange-${operationId}`, 'work.json')),
    );
    assert.equal(preparedWork.revision, revision);
    throw Error('synthetic capability outage');
  };
  await assert.rejects(
    pushNativeExchange(f.w.store, revision, operationId, f.transport, {
      onPrepared: observed => {
        assert.equal(observed, revision);
        captured = true;
      },
    }),
    /synthetic capability outage/,
  );
  assert.equal(f.uploads(), 0);
  assert.ok(existsSync(join(f.w.store.directory, `exchange-${operationId}`, 'manifest.json')));
  f.transport.ownerDisplayBaseline = async () => false;
  assert.ok((await pushNativeExchange(f.w.store, revision, operationId, f.transport)).ownerDerived);
});

test('a fresh captured push supplies full local facts when the hosted display baseline is absent', async t => {
  const { retainExchangeBaseline } = await import('../dist/native-exchange-baseline.js');
  const f = fixture(t),
    key = 'synthetic/existing-baseline';
  const base = await prepareNativeExchange(f.w.store, f.w.store.revision(), randomUUID());
  retainExchangeBaseline(
    f.w.store,
    key,
    base.manifest,
    f.w.store.load(),
    [],
    JSON.parse(readFileSync(join(base.directory, 'states.json'))),
  );
  f.act({ action: 'note', intentId: f.intent.id, kind: 'comment', text: 'New metadata' });
  f.transport.checkpointKey = () => key;
  f.transport.ownerDisplayBaseline = async () => false;
  const result = await pushNativeExchange(f.w.store, f.w.store.revision(), randomUUID(), f.transport);
  const document = JSON.parse(f.objects.get(result.ownerDerived.sha256));
  assert.equal(document.complete, true);
  assert.ok(document.parents.length > 0);
});

test('local derivation retains oversized Views, bounds its cache and ignores oversized legacy caches', async t => {
  const { OWNER_DERIVED_MAX_BYTES } = await import('../dist/owner-derived.js');
  const { ownerDerivedBytes } = await import('../dist/owner-derived-local.js');
  const { statSync } = await import('node:fs');
  const f = fixture(t),
    data = f.w.store.load();
  const cache = join(f.w.store.directory, 'owner-derived-cache.json');
  writeFileSync(cache, Buffer.alloc(OWNER_DERIVED_MAX_BYTES + 1, 32));
  assert.ok(ownerDerivedBytes(f.w.store, data));
  assert.ok(statSync(cache).size <= OWNER_DERIVED_MAX_BYTES);
  const lane = data.lanes[0];
  data.intents[0].outcome = 'Synthetic '.repeat(OWNER_DERIVED_MAX_BYTES / 5);
  data.views.push({
    id: 'large',
    intentId: lane.intentId,
    base: lane.base,
    head: lane.head,
    inputs: [{ laneId: lane.id, head: lane.head }],
    status: 'clean',
    at: 'a',
  });
  const partial = JSON.parse(ownerDerivedBytes(f.w.store, data));
  assert.ok(partial.parents.length > 0, 'oversized View retains usable State facts');
  assert.equal(partial.views.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(partial)) > OWNER_DERIVED_MAX_BYTES);
  assert.ok(statSync(cache).size <= OWNER_DERIVED_MAX_BYTES);
});

test('legacy baseline recovery uses exact pinned Work and missing metadata supplies full facts', async t => {
  const { retainExchangeBaseline, exchangeBaseline } = await import('../dist/native-exchange-baseline.js');
  const { ownerDerivedBytes } = await import('../dist/owner-derived-local.js');
  const f = fixture(t),
    key = 'legacy-hosted-baseline',
    original = f.w.store.load();
  const prepared = await prepareNativeExchange(f.w.store, original.revision, randomUUID());
  retainExchangeBaseline(
    f.w.store,
    key,
    prepared.manifest,
    original,
    [],
    JSON.parse(readFileSync(join(prepared.directory, 'states.json'))),
  );
  const path = join(f.w.store.directory, `exchange-baseline-${digest(key)}.json`);
  const envelope = JSON.parse(readFileSync(path));
  const value = JSON.parse(envelope.payload);
  delete value.data;
  const payload = JSON.stringify(value);
  writeFileSync(path, JSON.stringify({ payload, sha256: digest(payload) }));
  assert.deepEqual(exchangeBaseline(f.w.store, key).data, original);
  writeFileSync(join(prepared.directory, 'work.json'), '{}');
  const unavailable = exchangeBaseline(f.w.store, key);
  assert.equal(unavailable.data, undefined);
  const derived = JSON.parse(ownerDerivedBytes(f.w.store, original, unavailable));
  assert.ok(derived.parents.length > 0, 'server can select from full facts when baseline Work is missing');
});
