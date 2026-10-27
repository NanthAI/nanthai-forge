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
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  data.runs = Array.from({ length: runs }, () => ({
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
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
    runner: { pid: process.pid, host: 'synthetic' },
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
  assert(
    snapshotResolves < 40,
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
  s.tables.projectHostedOutputStreams.set('stream', { _id: 'stream', projectId: 'project', ...stream });
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
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
