// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { fixture, modules, upload } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { prepareNativeExchange } from '../dist/native-exchange.js';
import { buildExchangeRoot } from '../dist/native-exchange-tree.js';
import { digest } from '../dist/hash.js';
const cleanup = await import(moduleUrl('../convex/projectCheckLogCleanup.ts'));
const streamCleanup = await import(moduleUrl('../convex/projectCheckLogCleanupStream.ts'));
const { snapshotReader } = await import(moduleUrl('../convex/projectCheckLogCleanupSnapshot.ts'));

/** The general fixture deliberately scans Maps. Maintain its cleanup-page index
 * here so measuring 32k retained objects does not benchmark a quadratic fake DB. */
function indexCleanupPages(s) {
  const indexes = new Map(),
    query = s.ctx.db.query,
    insert = s.ctx.db.insert,
    patch = s.ctx.db.patch;
  const remember = row => {
    const key = JSON.stringify([row.projectId, row.operationId]);
    let parts = indexes.get(key);
    if (!parts) indexes.set(key, (parts = new Map()));
    let positions = parts.get(row.part);
    if (!positions) parts.set(row.part, (positions = new Map()));
    positions.set(row.position, row._id);
  };
  s.ctx.db.insert = async (table, value) => {
    const id = await insert(table, value);
    if (table === 'projectCheckLogCleanupPages') remember(s.tables[table].get(id));
    return id;
  };
  s.ctx.db.patch = async (id, fields) => {
    await patch(id, fields);
    if (s.tables.projectCheckLogCleanupPages.has(id)) remember(s.tables.projectCheckLogCleanupPages.get(id));
  };
  s.ctx.db.query = table => {
    if (table !== 'projectCheckLogCleanupPages') return query(table);
    const eq = {},
      bounds = [];
    const result = {
      withIndex: (_name, select) => {
        const q = Object.fromEntries(
          ['eq', 'gte', 'lt'].map(kind => [
            kind,
            (key, value) => {
              if (kind === 'eq') eq[key] = value;
              else bounds.push({ kind, key, value });
              return q;
            },
          ]),
        );
        select(q);
        return result;
      },
      unique: async () => {
        const id = indexes
          .get(JSON.stringify([eq.projectId, eq.operationId]))
          ?.get(eq.part)
          ?.get(eq.position);
        return id ? structuredClone(s.tables.projectCheckLogCleanupPages.get(id)) : null;
      },
      take: async count => rows().slice(0, count),
      paginate: async ({ cursor, numItems }) => {
        const selected = rows(),
          offset = Number(cursor ?? 0),
          page = selected.slice(offset, offset + numItems);
        return {
          page,
          isDone: offset + page.length >= selected.length,
          continueCursor: String(offset + page.length),
        };
      },
    };
    function rows() {
      const parts = indexes.get(JSON.stringify([eq.projectId, eq.operationId])) ?? new Map();
      const selected = [];
      for (const [part, positions] of parts) {
        if (eq.part !== undefined && eq.part !== part) continue;
        for (const [position, id] of positions) {
          if (
            bounds.some(b =>
              b.kind === 'gte' ? { part, position }[b.key] < b.value : { part, position }[b.key] >= b.value,
            )
          )
            continue;
          selected.push(s.tables.projectCheckLogCleanupPages.get(id));
        }
      }
      return selected
        .sort((a, b) => a.part.localeCompare(b.part) || a.position - b.position)
        .map(row => structuredClone(row));
    }
    return result;
  };
}
async function seeded(t, runs = 1, objectCount = 0) {
  const root = mkdtempSync(join(tmpdir(), 'forge-cleanup-paged-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  const store = new WorkStore(root),
    service = new WorkService(root),
    act = command => service.execute(command, store.revision()).result;
  const intent = act({ action: 'intent', outcome: 'Synthetic cleanup' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Cleanup' });
  const view = act({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
    operationId: randomUUID(),
  });
  const check = act({ action: 'define-check', name: 'Synthetic', executable: process.execPath, args: [] });
  const s = fixture(),
    prepared = await prepareNativeExchange(store, store.revision(), randomUUID(), false);
  const data = JSON.parse(readFileSync(join(prepared.directory, 'work.json'))),
    manifest = structuredClone(prepared.manifest);
  const environment = service.status().environment;
  // Stable IDs keep content-defined catalog boundaries reproducible for call budgets.
  data.runs = Array.from({ length: runs }, (_, i) => ({
    id: `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`,
    startedAt: '2026-10-27T00:00:00.000Z',
    endedAt: '2026-10-27T00:00:01.000Z',
    viewId: view.id,
    head: view.head,
    base: view.base,
    inputs: view.inputs,
    dependencies: [],
    check,
    environment,
    status: 'passed',
    exitCode: 0,
    signal: null,
    runner: { pid: 1, host: 'synthetic' },
    details: 'Synthetic passed',
    backend: { requested: 'github-actions', actual: 'github-actions' },
  }));
  const work = Buffer.from(JSON.stringify(data, null, 2));
  Object.assign(
    manifest.files.find(f => f.path === 'work.json'),
    { sha256: digest(work), size: work.length },
  );
  const logBytes = Math.floor((4 * 1024 ** 3) / (runs * 2));
  for (const [i, run] of data.runs.entries())
    for (const name of ['stdout', 'stderr']) {
      const pin = { sha256: digest(`log-${i}-${name}`), size: logBytes };
      manifest.files.push({ path: `check-${run.id}/${name}.log`, ...pin });
      const id = `log-${i}-${name}`;
      s.tables.projectObjects.set(id, {
        _id: id,
        _creationTime: 1,
        projectId: 'project',
        digest: pin.sha256,
        size: pin.size,
        storageId: id,
        nonce: randomUUID(),
        removed: false,
      });
    }
  for (const file of prepared.manifest.files.filter(f => f.path !== 'work.json'))
    await upload(s, readFileSync(join(store.directory, file.path)));
  const tree = buildExchangeRoot(Buffer.from(JSON.stringify(manifest)), work, { records: true });
  for (const bytes of tree.objects.values()) await upload(s, bytes);
  const pin = await upload(s, tree.bytes);
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    _creationTime: 1,
    projectId: 'project',
    transport: 'objects',
    digest: pin.sha256,
    size: pin.size,
    status: 'stored',
    preview: { manifestDigest: digest(JSON.stringify(manifest)), revision: manifest.revision },
  });
  for (let i = s.tables.projectObjects.size; i < objectCount; i++) {
    const id = `unrelated-${i}`;
    s.tables.projectObjects.set(id, {
      _id: id,
      _creationTime: 1,
      projectId: 'project',
      digest: digest(id),
      size: 1,
      nonce: randomUUID(),
      removed: false,
    });
  }
  indexCleanupPages(s);
  return { s, logBytes: logBytes * runs * 2 };
}
async function drive(s, input) {
  let result,
    calls = 0,
    maxActionMs = 0,
    maxHeapDelta = 0;
  do {
    const before = process.memoryUsage().heapUsed;
    result = JSON.parse(await cleanup.clean._handler(s.ctx, input));
    maxActionMs = Math.max(maxActionMs, result.actionMs);
    maxHeapDelta = Math.max(maxHeapDelta, process.memoryUsage().heapUsed - before);
    assert(++calls < 10000, 'requested operation advances finitely');
  } while (result.pending);
  return { ...result, calls, maxActionMs, maxHeapDelta };
}
test('paged cleanup resumes after a lost durable step, applies only the reviewed plan, and replays completed deletes', async t => {
  const { s } = await seeded(t, 5),
    input = { projectId: 'project', operationId: randomUUID() };
  const mutate = s.ctx.runMutation;
  let lost = true;
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutate(ref, args);
    if (lost && getFunctionName(ref) === 'projectCheckLogCleanupStore:planStep') {
      lost = false;
      throw Error('Synthetic lost step reply');
    }
    return result;
  };
  await assert.rejects(cleanup.clean._handler(s.ctx, input));
  assert.equal(s.tables.projectCheckLogCleanups.size, 1);
  const dry = await drive(s, input);
  assert.equal(dry.objects, 10);
  assert.equal(
    [...s.tables.projectObjects.values()].filter(row => row.storageId?.startsWith('log-')).length,
    10,
  );
  await assert.rejects(
    drive(s, { ...input, apply: true, expectedPlan: 'wrong' }),
    /exact reviewed cleanup plan/,
  );
  lost = true;
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutate(ref, args);
    if (lost && getFunctionName(ref) === 'projectCheckLogCleanupStore:complete') {
      lost = false;
      throw Error('Synthetic lost delete reply');
    }
    return result;
  };
  const apply = { ...input, apply: true, expectedPlan: dry.planDigest };
  await assert.rejects(drive(s, apply));
  assert.equal((await drive(s, apply)).deleted, 10);
  assert.equal((await drive(s, apply)).complete, true);
  s.tables.hostedProjects.get('project').revision++;
  assert.equal((await drive(s, apply)).complete, true, 'completed receipt survives later source revisions');
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'stranger' });
  await assert.rejects(drive(s, input), /PROJECT_UNAVAILABLE|unavailable/);
});
test('dogfood-shaped synthetic inventory measures bounded actions, calls and memory without loading 4 GB of log bytes', async t => {
  const { s, logBytes } = await seeded(t, 1400, 32237),
    counts = new Map();
  for (const method of ['runQuery', 'runMutation']) {
    const run = s.ctx[method];
    s.ctx[method] = (ref, args) => {
      const name = getFunctionName(ref);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return run(ref, args);
    };
  }
  const snapshot = snapshotReader(s.ctx, {
    projectId: 'project',
    actor: 'owner',
    operationId: randomUUID(),
  });
  const selected = await snapshot(s.tables.projectBackups.get('backup'), 0);
  assert.equal(selected.files.length, 50);
  const snapshotResolves = counts.get('projectObjects:resolve') ?? 0;
  // Content-defined catalog boundaries still move with the service's random record IDs,
  // so the count spans ~22–44 across runs. Per-run resolution would need at least 100
  // (stdout and stderr for 50 runs); the bound proves batching without chunk-alignment flakes.
  assert(
    snapshotResolves < 60,
    `one resumed snapshot page batches its catalog chunks as well as its selected runs (${snapshotResolves})`,
  );
  counts.clear();
  const baselineStart = performance.now(),
    baselineHeap = process.memoryUsage().heapUsed;
  const baselinePlan = await cleanup.planProjectCheckLogs(s.ctx, 'project', 'owner');
  const baseline = {
    elapsedMs: performance.now() - baselineStart,
    heapDeltaBytesIncludingFakeDB: Math.max(0, process.memoryUsage().heapUsed - baselineHeap),
    calls: Object.fromEntries(counts),
  };
  assert.equal(baselinePlan.objects.length, 2800);
  counts.clear();
  const input = { projectId: 'project', operationId: randomUUID() };
  const start = performance.now(),
    dry = await drive(s, input);
  assert.equal(dry.objects, 2800);
  assert.equal(dry.bytes, logBytes);
  assert(dry.maxActionMs < 10000, 'each finite metadata action stays well inside server time');
  assert(
    dry.maxHeapDelta < 128 * 1024 * 1024,
    'includes the in-memory fake database, rather than real server storage',
  );
  const resolves = counts.get('projectObjects:resolve') ?? 0;
  assert(resolves < 400, `batched selected run reads replace whole historical Work hydration (${resolves})`);
  const planningCalls = Object.fromEntries(counts),
    planElapsedMs = performance.now() - start;
  counts.clear();
  const applyStart = performance.now(),
    applied = await drive(s, { ...input, apply: true, expectedPlan: dry.planDigest });
  assert.equal(applied.deleted, 2800);
  assert.equal(applied.complete, true);
  const applying = {
    elapsedMs: performance.now() - applyStart,
    actions: applied.calls,
    maxActionMs: applied.maxActionMs,
    maxHeapDeltaBytesIncludingFakeDB: applied.maxHeapDelta,
    calls: Object.fromEntries(counts),
  };
  console.log(
    'S54 synthetic cleanup',
    JSON.stringify({
      runs: 1400,
      snapshotResolves,
      retainedObjects: 32237,
      logicalLogBytes: logBytes,
      elapsedMs: planElapsedMs,
      actions: dry.calls,
      maxActionMs: dry.maxActionMs,
      maxHeapDeltaBytesIncludingFakeDB: dry.maxHeapDelta,
      peakRssBytesIncludingFakeDB: process.resourceUsage().maxRSS * 1024,
      calls: planningCalls,
      baseline,
      applying,
      baselineFromBrief: { resolves: 3200, inventory: 800, actionMs: 300000 },
      provider: 'local indexed storage fake; no hosted network or log-byte downloads',
    }),
  );
});

test('streamed apply advances one chunk/reference page, retains split evidence and replays lost summary/deletion replies', async t => {
  const s = fixture(),
    raw = Buffer.from(
      'ordinary chatter\n__FORGE_TESTS__{"file":"tests/a.test.mjs","complete":true,"results":[{"name":"fails","passed":false}]}\nError: synthetic\n',
    );
  s.tables.projectHostedOutputChunks = new Map();
  const descriptor = { shard: 0, attempt: 0, executionId: 'synthetic', stream: 'stdout', name: '' },
    stream = {
      runId: randomUUID(),
      streamId: digest('stream'),
      bytes: raw.length,
      chunks: 2,
      maxSequence: 1,
      seal: null,
      descriptor: JSON.stringify(descriptor),
    };
  s.tables.projectHostedOutputStreams.set('stream', {
    _id: 'stream',
    _creationTime: 1,
    projectId: 'project',
    ...stream,
  });
  const chunks = [raw.subarray(0, 38), raw.subarray(38)],
    content = new Map();
  let offset = 0;
  for (const [sequence, bytes] of chunks.entries()) {
    const chunk = {
      stream: descriptor,
      sequence,
      offset,
      object: { sha256: digest(bytes), size: bytes.length },
    };
    offset += bytes.length;
    s.tables.projectHostedOutputChunks.set(`chunk-${sequence}`, {
      _id: `chunk-${sequence}`,
      _creationTime: 1,
      projectId: 'project',
      runId: stream.runId,
      streamId: stream.streamId,
      sequence,
      revision: sequence + 1,
      value: JSON.stringify(chunk),
    });
    content.set(chunk.object.sha256, bytes);
  }
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
  let gets = 0,
    deletes = 0,
    loseSummary = true,
    loseDelete = true;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'DELETE') {
      deletes++;
      if (loseDelete) {
        loseDelete = false;
        throw Error('Synthetic lost DELETE reply');
      }
      return new Response(null, { status: 204 });
    }
    gets++;
    const pin = [...content.keys()].find(pin => String(url).includes(pin));
    assert(pin);
    return new Response(content.get(pin));
  };
  const scratch = new Map(),
    query = s.ctx.runQuery,
    mutation = s.ctx.runMutation;
  s.ctx.runQuery = (ref, args) =>
    getFunctionName(ref) === 'projectCheckLogCleanupStore:planLookup'
      ? Promise.resolve(scratch.get(`${args.part}:${args.position}`) ?? null)
      : query(ref, args);
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutation(ref, args);
    if (loseSummary && getFunctionName(ref) === 'projectHostedLogCleanupStore:summary') {
      loseSummary = false;
      throw Error('Synthetic lost summary reply');
    }
    return result;
  };
  let state = { outputOffset: 0 },
    steps = 0,
    interrupted = 0;
  const input = { projectId: 'project', actor: 'owner', operationId: randomUUID() };
  while (!state.outputOffset) {
    const next = structuredClone(state);
    try {
      const writes = await streamCleanup.cleanupStreamStep(s.ctx, input, next, stream);
      for (const w of writes) scratch.set(`${w.part}:${w.position}`, w.value);
      state = next;
    } catch {
      interrupted++;
    }
    assert(++steps < 20);
  }
  assert.equal(interrupted, 2);
  assert.equal(gets, 3, 'lost first summary rereads one raw chunk only');
  assert.equal(deletes, 3, 'same DELETE is idempotently retried');
  const summary = [...s.tables.projectHostedOutputSummaries.values()]
    .sort((a, b) => a.position - b.position)
    .map(r => r.text)
    .join('');
  assert(summary.includes('__FORGE_TESTS__'));
  assert(summary.includes('tests/a.test.mjs'));
  assert(summary.includes('Error: synthetic'));
  assert(!summary.includes('ordinary chatter'));
  assert.equal(s.tables.projectHostedOutputStreams.get('stream').retired, true);
});

test('CLI saves the original UUID before IO, resumes dry-run pages, and surfaces structured server diagnostics', async t => {
  const { createServer } = await import('node:http');
  const { checkLogsCli } = await import('../dist/check-logs-cli.js');
  const { updateHostState } = await import('../dist/host-binding.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-cleanup-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  let fail = true,
    pending = true;
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)),
      input = body.args[0];
    requests.push({ name: body.path, input });
    response.setHeader('Content-Type', 'application/json');
    if (body.path === 'projectCheckLogCleanup:clean' && fail) {
      fail = false;
      response.end(
        JSON.stringify({
          status: 'error',
          errorMessage: 'Opaque outer transport message',
          errorData: {
            code: 'INTERNAL_ERROR',
            message: 'Synthetic server diagnostic: inventory read failed.',
          },
        }),
      );
    } else if (body.path === 'projectCheckLogCleanup:clean') {
      const result = pending
        ? { pending: true, progress: '{"phase":"objects","step":1}' }
        : { pending: false, planDigest: digest('reviewed'), objects: 0, bytes: 0, complete: !!input.apply };
      pending = false;
      response.end(JSON.stringify({ status: 'success', value: JSON.stringify(result) }));
    } else
      response.end(
        JSON.stringify({
          status: 'success',
          value: JSON.stringify({ page: [], isDone: true, continueCursor: '' }),
        }),
      );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env };
  t.after(() => {
    process.env = env;
  });
  process.env.FORGE_AUTH_TOKEN = 'synthetic-cleanup-device';
  const store = new WorkStore(root),
    deployment = `http://127.0.0.1:${server.address().port}`;
  updateHostState(store, state => {
    state.binding = {
      projectId: 'project',
      deployment,
      projectUrl: 'https://forge.example/owner/project',
      operationId: randomUUID(),
      name: 'Synthetic',
      visibility: 'private',
      backupId: 'backup',
    };
  });
  const path = join(root, 'reviewed-plan.json'),
    args = [root, '--dry-run', '--plan', path, '--hosted'];
  await assert.rejects(
    checkLogsCli([...args]),
    error => error.code === 'INTERNAL_ERROR' && error.message.includes('inventory read failed'),
  );
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.status, 'planning');
  const result = await checkLogsCli([...args]);
  assert.equal(result.status, 'reviewed');
  assert.equal(result.operationId, saved.operationId);
  assert(
    requests
      .filter(r => r.name === 'projectCheckLogCleanup:clean')
      .every(r => r.input.operationId === saved.operationId),
  );
  assert.equal((await checkLogsCli([root, '--apply', '--plan', path, '--hosted'])).hosted.complete, true);
  assert.equal(requests.at(-1).input.expectedPlan, digest('reviewed'));
});

test('server cleanup preserves structured INTERNAL_ERROR diagnostics', async () => {
  const { ConvexError } = await import('convex/values');
  const s = fixture();
  s.ctx.runQuery = async () => {
    throw new ConvexError({ code: 'INTERNAL_ERROR', message: 'Synthetic inventory diagnostic' });
  };
  await assert.rejects(
    cleanup.clean._handler(s.ctx, { projectId: 'project', operationId: randomUUID() }),
    error => error.data?.code === 'INTERNAL_ERROR' && error.data.message === 'Synthetic inventory diagnostic',
  );
});

test('E3 dogfood State closure parses 2,500 3,000-file States once within 15,000 calls', async () => {
  const { resumePlan, planStep } = await import(moduleUrl('../convex/projectCheckLogCleanupPlan.ts'));
  const s = fixture();
  indexCleanupPages(s);
  const input = { projectId: 'project', actor: 'owner', operationId: randomUUID() };
  const blobs = Array.from({ length: 32000 }, (_, i) => digest(`protected-${i}`));
  const heads = [],
    sizes = [],
    reads = new Map();
  const bytesAt = i =>
    Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: i ? [heads[i - 1]] : [],
        files: Array.from({ length: 3000 }, (_, j) => ({
          path: `file-${j}.ts`,
          blob: blobs[(i * 13 + j) % blobs.length],
          mode: 'file',
        })),
        message: `State ${i}`,
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
  for (let i = 0; i < 2500; i++) {
    const bytes = bytesAt(i),
      head = digest(bytes);
    heads.push(head);
    sizes.push(bytes.length);
    s.tables.projectObjects.set(`state-${i}`, {
      _id: `state-${i}`,
      _creationTime: 1,
      projectId: 'project',
      digest: head,
      size: bytes.length,
      storageId: `state-${i}`,
      removed: false,
    });
  }
  const metadata = s.ctx.storage.getMetadata,
    get = s.ctx.storage.get;
  s.ctx.storage.getMetadata = async id =>
    id.startsWith('state-')
      ? { size: sizes[Number(id.slice(6))], sha256: heads[Number(id.slice(6))] }
      : metadata(id);
  s.ctx.storage.get = async id => {
    if (!id.startsWith('state-')) return get(id);
    const i = Number(id.slice(6));
    reads.set(i, (reads.get(i) ?? 0) + 1);
    return new Blob([bytesAt(i)]);
  };
  let state = await resumePlan(s.ctx, input);
  const original = JSON.stringify(state);
  state.phase = 'closure';
  state = JSON.parse(
    await s.ctx.runMutation(
      (await import('convex/server')).makeFunctionReference('projectCheckLogCleanupStore:planStep'),
      {
        ...input,
        expected: original,
        value: JSON.stringify(state),
        nodes: JSON.stringify([{ key: heads.at(-1), state: true }]),
        writes: '[]',
      },
    ),
  );
  const counts = new Map();
  let documentReads = 0,
    documentWrites = 0;
  const query = s.ctx.db.query;
  const getDocument = s.ctx.db.get;
  s.ctx.db.get = async id => {
    const row = await getDocument(id);
    documentReads += Number(!!row);
    return row;
  };
  s.ctx.db.query = table => {
    const q = query(table);
    for (const method of ['unique', 'take', 'paginate']) {
      const run = q[method];
      q[method] = async (...args) => {
        const result = await run(...args);
        documentReads +=
          method === 'unique' ? Number(!!result) : method === 'paginate' ? result.page.length : result.length;
        return result;
      };
    }
    return q;
  };
  for (const method of ['insert', 'patch']) {
    const run = s.ctx.db[method];
    s.ctx.db[method] = (...args) => {
      documentWrites++;
      return run(...args);
    };
  }
  for (const method of ['runQuery', 'runMutation']) {
    const run = s.ctx[method];
    s.ctx[method] = (ref, args) => {
      const name = getFunctionName(ref);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return run(ref, args);
    };
  }
  const started = performance.now(),
    heap = process.memoryUsage().heapUsed;
  // Production sweeps share one snapshot per invocation of up to twenty steps.
  let snapshot = snapshotReader(s.ctx, input);
  for (let step = 0; ['closure', 'source-union', 'source-closure'].includes(state.phase); step++) {
    if (step % 20 === 0) snapshot = snapshotReader(s.ctx, input);
    state = await planStep(s.ctx, input, state, snapshot);
  }
  const calls = [...counts.values()].reduce((sum, n) => sum + n, 0);
  assert(calls <= 15000, `State closure calls: ${calls}`);
  assert.equal(reads.size, 2500);
  assert(
    [...reads.values()].every(n => n === 1),
    'one byte read per State',
  );
  const nodes = [...s.tables.projectCheckLogCleanupPages.values()]
    .filter(row => row.part.startsWith('node:'))
    .map(row => JSON.parse(row.value));
  assert.equal(nodes.filter(node => node.protected && blobs.includes(node.key)).length, 32000);
  assert(documentReads < 1000000, `bounded union document reads: ${documentReads}`);
  assert(documentWrites < 100000, `deduplicated durable union writes: ${documentWrites}`);
  console.log(
    'E3 State closure',
    JSON.stringify({
      states: 2500,
      filesPerState: 3000,
      uniqueBlobs: 32000,
      calls,
      functions: Object.fromEntries(counts),
      documentReads,
      documentWrites,
      StateByteReads: [...reads.values()].reduce((a, b) => a + b, 0),
      elapsedMs: performance.now() - started,
      heapDeltaBytesIncludingFakeDB: Math.max(0, process.memoryUsage().heapUsed - heap),
      peakRssBytesIncludingFakeDB: process.resourceUsage().maxRSS * 1024,
      beforeAuditEstimateCalls: 762500,
    }),
  );
});

test('E3 output cleanup indexes legacy chunks once and rechecks 1,000 candidates in bounded windows', async t => {
  const s = fixture();
  s.tables.projectHostedOutputChunks = new Map();
  const descriptor = { shard: 0, attempt: 0, executionId: 'synthetic', stream: 'stdout', name: '' };
  const stream = {
    runId: randomUUID(),
    streamId: digest('E3 raw'),
    bytes: 1000,
    chunks: 1000,
    maxSequence: 999,
    seal: null,
    descriptor: JSON.stringify(descriptor),
  };
  s.tables.projectHostedOutputStreams.set('raw', {
    _id: 'raw',
    _creationTime: 1,
    projectId: 'project',
    ...stream,
    retired: true,
  });
  s.tables.projectHostedOutputStreams.set('artifact', {
    _id: 'artifact',
    _creationTime: 1,
    projectId: 'project',
    ...stream,
    streamId: 'artifact',
    descriptor: JSON.stringify({ ...descriptor, stream: 'artifact' }),
    retired: true,
  });
  const rawPins = Array.from({ length: 1000 }, (_, i) => digest(`E3 raw ${i}`));
  for (let i = 0; i < 2000; i++) {
    const raw = i < 1000,
      sequence = i % 1000;
    const pin = raw || sequence < 50 ? rawPins[sequence] : digest(`E3 artifact ${sequence}`);
    s.tables.projectHostedOutputChunks.set(`chunk-${i}`, {
      _id: `chunk-${i}`,
      _creationTime: 1,
      projectId: 'project',
      runId: stream.runId,
      streamId: raw ? stream.streamId : 'artifact',
      sequence,
      revision: i,
      value: JSON.stringify({
        stream: raw ? descriptor : { ...descriptor, stream: 'artifact' },
        sequence,
        offset: sequence,
        object: { sha256: pin, size: 1 },
      }),
    });
  }
  const env = { ...process.env },
    fetch = globalThis.fetch,
    deleted = new Set();
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
  globalThis.fetch = async (url, init) => {
    assert.equal(init.method, 'DELETE');
    const pin = rawPins.find(pin => String(url).includes(pin));
    assert(pin);
    deleted.add(pin);
    return new Response(null, { status: 204 });
  };
  let calls = 0;
  for (const method of ['runQuery', 'runMutation']) {
    const run = s.ctx[method];
    s.ctx[method] = (ref, args) => {
      calls++;
      return run(ref, args);
    };
  }
  const identity = { projectId: 'project', actor: 'owner', operationId: randomUUID() },
    state = { outputOffset: 0 };
  const expected = JSON.stringify({
    bytes: stream.bytes,
    chunks: stream.chunks,
    maxSequence: stream.maxSequence,
    seal: stream.seal,
    descriptor: stream.descriptor,
  });
  const unknown = JSON.parse(
    await modules.projectHostedLogCleanupStore.retainedBatch._handler(s.ctx, {
      ...identity,
      ...stream,
      digests: [rawPins[0]],
      expected,
    }),
  );
  assert.equal(unknown.indexed, false, 'missing index coverage cannot authorize deletion');
  const started = performance.now();
  while (!state.outputOffset) await streamCleanup.cleanupStreamStep(s.ctx, identity, state, stream);
  assert(calls <= 200, `cleanup control calls: ${calls}`);
  assert.equal(deleted.size, 950);
  assert(
    rawPins.slice(0, 50).every(pin => !deleted.has(pin)),
    'retired artifact references still protect shared bytes',
  );
  s.tables.hostedProjects.get('project').removal = 'deleting';
  await assert.rejects(
    modules.projectHostedLogCleanupStore.retainedBatch._handler(s.ctx, {
      ...identity,
      ...stream,
      digests: [rawPins[99]],
      expected,
    }),
    /unavailable/,
  );
  console.log(
    'E3 output cleanup',
    JSON.stringify({
      rawChunks: 1000,
      otherChunks: 1000,
      calls,
      deletes: deleted.size,
      elapsedMs: performance.now() - started,
      beforeAuditEstimateReferenceCalls: 40000,
    }),
  );
});

test('E3 due expiry coalesces concurrent events and drains a backlog with one resumable plan', async () => {
  const s = fixture(),
    retention = modules.projectCheckLogRetention;
  for (let i = 0; i < 150; i++)
    s.tables.projectCheckLogRetentions.set(`due-${i}`, {
      _id: `due-${i}`,
      _creationTime: 1,
      projectId: 'project',
      key: `output:${i}`,
      expiresAt: Date.now() - 10000,
    });
  for (let i = 0; i < 20; i++)
    await retention.register._handler(s.ctx, { projectId: 'project', actor: 'owner', entries: [] });
  assert.equal(s.scheduled.length, 1, 'concurrent lifecycle wakes share the durable project sweep');
  const operationIds = new Set();
  let actions = 0;
  for (let at = 0; at < s.scheduled.length; at++) {
    const { args } = s.scheduled[at];
    operationIds.add(args.operationId);
    const first = await retention.claimSweep._handler(s.ctx, args);
    assert(first);
    assert.equal(await retention.claimSweep._handler(s.ctx, args), null, 'one driver wins this continuation');
    // Release the test claim so the real action drives its planner/settlement.
    s.tables.hostedProjects.get('project').checkLogSweep.running = false;
    await modules.projectCheckLogRetentionActions.sweep._handler(s.ctx, args);
    assert(++actions < 20);
  }
  assert.equal(operationIds.size, 1);
  assert.equal(s.tables.projectCheckLogCleanups.size, 1);
  assert.equal(s.tables.projectCheckLogRetentions.size, 0);
  assert.equal(s.tables.hostedProjects.get('project').checkLogSweep, undefined);
  const scheduled = s.scheduled.length;
  await retention.register._handler(s.ctx, { projectId: 'project', actor: 'owner', entries: [] });
  assert.equal(s.scheduled.length, scheduled, 'settled project has zero idle wake cost');
  console.log(
    'E3 coalesced retention',
    JSON.stringify({ lifecycleWakes: 20, dueReceipts: 150, plans: 1, actions, scheduled }),
  );
});

test('E3 source union splits skewed hashes into bounded durable pages and deduplicates retries', async () => {
  const { protectSourceUnion } = await import(moduleUrl('../convex/projectCheckLogCleanupSource.ts'));
  const s = fixture();
  indexCleanupPages(s);
  const input = { projectId: 'project', actor: 'owner', operationId: randomUUID() };
  const pins = Array.from({ length: 6000 }, (_, i) => `0000${digest(`skewed-${i}`).slice(4)}`);
  await protectSourceUnion(s.ctx, input, pins);
  const prior = structuredClone([...s.tables.projectCheckLogCleanupPages.values()]);
  await protectSourceUnion(s.ctx, input, [...pins].reverse());
  assert.deepEqual([...s.tables.projectCheckLogCleanupPages.values()], prior);
  const pages = prior.map(row => JSON.parse(row.value));
  assert(pages.every(page => page.pins.length <= 512));
  assert.equal(new Set(pages.flatMap(page => page.pins)).size, 6000);
});

test('E3 interrupted sweep resumes its original plan and source changes retain stale receipts', async () => {
  const s = fixture(),
    retention = modules.projectCheckLogRetention;
  s.tables.projectCheckLogRetentions.set('due', {
    _id: 'due',
    _creationTime: 1,
    projectId: 'project',
    key: 'output:expired',
    expiresAt: 1,
  });
  await retention.register._handler(s.ctx, { projectId: 'project', actor: 'owner', entries: [] });
  const original = s.scheduled[0].args,
    mutate = s.ctx.runMutation;
  let lost = true;
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutate(ref, args);
    if (lost && getFunctionName(ref) === 'projectCheckLogCleanupStore:planStep') {
      lost = false;
      throw Error('Synthetic lost automatic step reply');
    }
    return result;
  };
  await assert.rejects(
    modules.projectCheckLogRetentionActions.sweep._handler(s.ctx, original),
    /lost automatic/,
  );
  assert.equal(s.tables.projectCheckLogCleanups.size, 1);
  const systemGet = s.ctx.db.system.get;
  s.ctx.db.system.get = id =>
    id === 'task-0' ? Promise.resolve({ state: { kind: 'failed' } }) : systemGet(id);
  await retention.register._handler(s.ctx, { projectId: 'project', actor: 'owner', entries: [] });
  assert.equal(s.scheduled[1].args.operationId, original.operationId);
  s.tables.hostedProjects.get('project').revision++;
  await modules.projectCheckLogRetentionActions.sweep._handler(s.ctx, s.scheduled[1].args);
  const restarted = s.scheduled[2].args;
  assert.notEqual(
    restarted.operationId,
    original.operationId,
    'a changed guard retains the stale plan and prepares fresh scope',
  );
  await modules.projectCheckLogRetentionActions.sweep._handler(s.ctx, restarted);
  assert.equal(s.tables.projectCheckLogCleanups.size, 2);
  assert.equal(s.tables.projectCheckLogRetentions.size, 0);
  assert.equal(s.tables.hostedProjects.get('project').checkLogSweep, undefined);
});

test('E3 heavily repeated digests complete the existing paged safety scan rather than retaining unused bytes', async t => {
  const s = fixture();
  s.tables.projectHostedOutputChunks = new Map();
  const descriptor = { shard: 0, attempt: 0, executionId: 'synthetic', stream: 'stdout', name: '' };
  const pin = digest('same raw chunk');
  const stream = {
    runId: randomUUID(),
    streamId: digest('repeated'),
    bytes: 120,
    chunks: 120,
    maxSequence: 119,
    seal: null,
    descriptor: JSON.stringify(descriptor),
  };
  s.tables.projectHostedOutputStreams.set('raw', {
    _id: 'raw',
    _creationTime: 1,
    projectId: 'project',
    ...stream,
    retired: true,
  });
  for (let sequence = 0; sequence < 120; sequence++)
    s.tables.projectHostedOutputChunks.set(`chunk-${sequence}`, {
      _id: `chunk-${sequence}`,
      _creationTime: 1,
      projectId: 'project',
      runId: stream.runId,
      streamId: stream.streamId,
      sequence,
      revision: sequence,
      digest: pin,
      value: JSON.stringify({
        stream: descriptor,
        sequence,
        offset: sequence,
        object: { sha256: pin, size: 1 },
      }),
    });
  const env = { ...process.env },
    fetch = globalThis.fetch;
  let deletes = 0;
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
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.method, 'DELETE');
    deletes++;
    return new Response(null, { status: 204 });
  };
  const state = { outputOffset: 0 },
    input = { projectId: 'project', actor: 'owner', operationId: randomUUID() };
  let steps = 0;
  while (!state.outputOffset) {
    await streamCleanup.cleanupStreamStep(s.ctx, input, state, stream);
    assert(++steps < 50);
  }
  assert.equal(
    deletes,
    120,
    'shared address deletion stays idempotent; no reference-count ceiling changes retention',
  );
});

test('E3 a State-only source reference protects a log candidate without relying on source projections', async t => {
  const { s } = await seeded(t, 1);
  const source = [...s.tables.projectObjects.values()].find(row => row.storageId === 'log-0-stdout');
  const pin = await upload(
    s,
    Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [{ path: 'retained-source.txt', blob: source.digest, mode: 'file' }],
        message: 'source',
        at: new Date().toISOString(),
      }),
    ),
  );
  s.tables.projectHostedStates.set('source', { _id: 'source', projectId: 'project', head: pin.sha256 });
  const input = { projectId: 'project', operationId: randomUUID() },
    dry = await drive(s, input);
  assert.equal(dry.objects, 1);
  assert.equal(dry.counts.shared, 1);
  const applied = await drive(s, { ...input, apply: true, expectedPlan: dry.planDigest });
  assert.equal(applied.complete, true);
  assert.equal(s.tables.projectObjects.get(source._id).storageId, source.storageId);
});
