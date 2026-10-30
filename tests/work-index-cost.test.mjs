// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { setup, actions } from './hosted-planning-fixture.mjs';
import { dispatchHostedWork } from '../dist/hosted-work-client.js';
import { indexedRecord } from '../dist/work-hosted-index.js';
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const indexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const command = await import(moduleUrl('../convex/projectWorkCommand.ts'));
v8.setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
const bytes = value => Buffer.byteLength(JSON.stringify(value) ?? 'null');

// Model the provider's indexed lookup, rather than allocating a full table
// array in the general fake for every point read. This keeps fixture allocations
// out of the measured operation's memory budget at 84,000 retained rows.
function indexFixtureRecords(ctx, tables) {
  const buckets = new Map();
  const add = row => {
    if (!buckets.has(row.collection)) buckets.set(row.collection, new Map());
    buckets.get(row.collection).set(row.key, row);
  };
  for (const row of tables.projectWorkRecords.values()) add(row);
  const db = ctx.db,
    query = db.query,
    insert = db.insert;
  db.insert = async (table, row) => {
    const id = await insert(table, row);
    if (table === 'projectWorkRecords') add(tables.projectWorkRecords.get(id));
    return id;
  };
  db.query = table => {
    if (table !== 'projectWorkRecords') return query(table);
    const equals = new Map(),
      tests = [];
    let descending = false;
    const range = {
      eq: (field, value) => {
        equals.set(field, value);
        return range;
      },
      gt: (field, value) => {
        tests.push(row => row[field] > value);
        return range;
      },
      gte: (field, value) => {
        tests.push(row => row[field] >= value);
        return range;
      },
      lt: (field, value) => {
        tests.push(row => row[field] < value);
        return range;
      },
      lte: (field, value) => {
        tests.push(row => row[field] <= value);
        return range;
      },
    };
    const rows = () => {
      assert(equals.has('collection'), 'operations must select a collection');
      const bucket = buckets.get(equals.get('collection')) ?? new Map();
      const candidates = equals.has('key')
        ? [bucket.get(equals.get('key'))].filter(Boolean)
        : [...bucket.values()];
      return candidates
        .filter(
          row =>
            [...equals].every(([field, value]) => row[field] === value) && tests.every(test => test(row)),
        )
        .sort((a, b) => (descending ? -1 : 1) * (a.position - b.position));
    };
    const selected = {
      withIndex: (name, build) => {
        assert(name.startsWith('by_generation_and_collection'));
        build(range);
        return selected;
      },
      order: direction => {
        descending = direction === 'desc';
        return selected;
      },
      take: async count => structuredClone(rows().slice(0, count)),
      unique: async () => {
        const found = rows();
        assert(found.length <= 1);
        return structuredClone(found[0] ?? null);
      },
    };
    return selected;
  };
}

// Measure returned documents at the indexed DB boundary, independent of the
// in-memory fixture's scan implementation. No live deployment is involved.
function measure(ctx) {
  const metrics = { calls: {}, readDocuments: 0, readBytes: 0, writes: 0, writeBytes: 0, historyBytes: 0 };
  const db = ctx.db;
  const record = value => {
    metrics.readDocuments += Array.isArray(value) ? value.length : value ? 1 : 0;
    metrics.readBytes += bytes(value);
    return value;
  };
  const chain = query =>
    new Proxy(query, {
      get(target, key) {
        const fn = target[key];
        if (typeof fn !== 'function') return fn;
        return (...args) => {
          const value = fn.apply(target, args);
          if (['unique', 'first', 'take', 'collect'].includes(key))
            return Promise.resolve(value).then(record);
          if (key === 'paginate')
            return Promise.resolve(value).then(page => {
              record(page.page);
              return page;
            });
          return value === target ? chain(target) : value;
        };
      },
    });
  ctx.db = {
    ...db,
    get: async id => record(await db.get(id)),
    query: table => {
      assert.notEqual(table, 'projectObjects', 'normal commands never read the object catalog');
      return chain(db.query(table));
    },
    ...Object.fromEntries(
      ['insert', 'patch', 'replace', 'delete'].map(method => [
        method,
        async (...args) => {
          metrics.writes++;
          metrics.writeBytes += bytes(args);
          return db[method](...args);
        },
      ]),
    ),
  };
  for (const method of ['runQuery', 'runMutation', 'runAction']) {
    const run = ctx[method];
    ctx[method] = async (ref, args) => {
      const name = getFunctionName(ref);
      metrics.calls[name] = (metrics.calls[name] ?? 0) + 1;
      assert(!/projectWorkIndexActions|projectWorkIndexBuild|projectWork:events/.test(name), name);
      return run(ref, args);
    };
  }
  ctx.storage.get = ctx.storage.getUrl = async () => assert.fail('full-history bytes must stay at zero');
  return metrics;
}

test('doubled dogfood history retains its index through main moves and incremental commands with zero rebuild bytes', async t => {
  const s = await setup(t);
  const intentId = randomUUID();
  await s.send({
    action: 'intent',
    operationId: intentId,
    outcome: 'Cost fixture',
    constraints: '',
    base: s.preview.head,
  });
  const snapshot = await s.read();
  const template = snapshot.data.intents.find(row => row.id === intentId);
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  const generation = s.tables.projectWorkGenerations.get(generationId);
  const put = (collection, key, position, value) => {
    const id = `scale-${collection}-${key}`;
    s.tables.projectWorkRecords.set(id, {
      _id: id,
      _creationTime: 1,
      projectId: s.projectId,
      generationId,
      collection,
      key,
      parent: '',
      position,
      value: JSON.stringify(value),
    });
  };
  // Actual doubled dogfood row cardinalities; large retained payloads live in
  // storage, whose reader above fails if anything tries to download them.
  const shape = {
    intents: 1200,
    lanes: 1120,
    views: 4400,
    runs: 3000,
    checkpoints: 5600,
    sourcePins: 5000,
    sourceBlobs: 64000,
  };
  for (let i = 1; i < shape.intents; i++) {
    const id = randomUUID();
    for (const entry of indexedRecord('intents', id, '', i, { ...template, id })) {
      const rowId = `scale-intent-${i}-${entry.collection}`;
      s.tables.projectWorkRecords.set(rowId, {
        ...entry,
        _id: rowId,
        _creationTime: 1,
        projectId: s.projectId,
        generationId,
      });
    }
  }
  for (const [collection, count] of Object.entries(shape)) {
    if (collection === 'intents') continue;
    for (let i = 0; i < count; i++) put(collection, String(i), i, { id: String(i), retainedBytes: 4096 });
  }
  const metadata = JSON.parse(generation.metadata);
  Object.assign(metadata.counts, shape);
  generation.metadata = JSON.stringify(metadata);
  const head = [...s.tables.projectWorkHeads.values()][0];
  head.metadata = generation.metadata;
  indexFixtureRecords(s.ctx, s.tables);
  // Controlled GC excludes fixture garbage and measures live working memory,
  // rather than making the budget depend on V8 choosing a collection time.
  gc();
  const metrics = measure(s.ctx),
    beforeMemory = process.memoryUsage().heapUsed,
    start = performance.now();
  let maxResponseBytes = 0,
    peakHeapGrowthBytes = 0;
  const client = {
    query: async (ref, args) => {
      const name = getFunctionName(ref);
      metrics.calls[name] = (metrics.calls[name] ?? 0) + 1;
      const result = await index[name.split(':')[1]]._handler(s.ctx, args);
      maxResponseBytes = Math.max(maxResponseBytes, bytes(result));
      return result;
    },
    action: async () => assert.fail('ordinary reads never invoke actions'),
  };
  for (let i = 0; i < 1200; i++) {
    if (i % 32 === 0) gc();
    // H14 moves canonical main independently of the seed Work generation.
    s.tables.projectHostedChannels ??= new Map();
    s.tables.projectHostedChannels.set('main', {
      _id: 'main',
      projectId: s.projectId,
      name: 'main',
      selection: JSON.stringify({ head: i.toString(16).padStart(64, '0'), sourceRevision: i }),
    });
    const workspace = await dispatchHostedWork(client, s.projectId, { action: 'workspace' });
    assert.equal(workspace.generationId, generationId);
    peakHeapGrowthBytes = Math.max(peakHeapGrowthBytes, process.memoryUsage().heapUsed - beforeMemory);
    if (i % 6 === 0) {
      metrics.calls['projectWorkCommand:command'] = (metrics.calls['projectWorkCommand:command'] ?? 0) + 1;
      await command.command._handler(s.ctx, {
        projectId: s.projectId,
        operationId: randomUUID(),
        command: JSON.stringify({ action: 'note', intentId, kind: 'comment', text: `Incremental ${i}` }),
      });
    }
  }
  assert.equal(s.tables.projectWorkGenerations.size, 1);
  assert.equal(s.tables.hostedProjects.get(s.projectId).work.generationId, generationId);
  assert.equal(s.tables.projectWorkEvents.size, 201);
  assert.equal(metrics.historyBytes, 0);
  assert(maxResponseBytes < 64 * 1024);
  assert(metrics.readDocuments <= 1200 * 24, JSON.stringify(metrics));
  assert(metrics.writes <= 200 * 10, JSON.stringify(metrics));
  assert(metrics.readBytes <= 1200 * 32 * 1024, JSON.stringify(metrics));
  const elapsedMs = performance.now() - start,
    heapGrowthBytes = process.memoryUsage().heapUsed - beforeMemory;
  assert(elapsedMs < 30000, `elapsed ${elapsedMs}ms`);
  assert(peakHeapGrowthBytes < 64 * 1024 * 1024, `peak heap growth ${peakHeapGrowthBytes}`);
  t.diagnostic(
    JSON.stringify({
      shape,
      moves: 1200,
      commands: 200,
      metrics,
      maxResponseBytes,
      elapsedMs,
      heapGrowthBytes,
      peakHeapGrowthBytes,
    }),
  );
});

test('missing indexes return structured results without automatic full builds, including older clients', async t => {
  const s = await setup(t, true, undefined, false);
  const metrics = measure(s.ctx);
  const client = {
    query: (ref, args) => index[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args),
    action: async () => assert.fail('missing-index reads never rebuild'),
  };
  await assert.rejects(dispatchHostedWork(client, s.projectId, { action: 'workspace' }), {
    code: 'PROJECT_WORK_INDEX_MISSING',
  });
  for (const build of [indexActions.ensure, indexActions.ensureInternal]) {
    await assert.rejects(
      build._handler(s.ctx, { projectId: s.projectId, owner: 'owner' }),
      error => (error.data?.code ?? error.code) === 'PROJECT_WORK_INDEX_MISSING',
    );
  }
  await assert.rejects(
    actions.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId: randomUUID(),
      revision: s.preview.revision,
      command: JSON.stringify({
        action: 'intent',
        outcome: 'No auto rebuild',
        constraints: '',
        base: s.preview.head,
      }),
    }),
    error => error.data?.code === 'PROJECT_WORK_INDEX_MISSING',
  );
  assert.equal(s.tables.projectWorkGenerations.size, 0);
  assert.equal(metrics.writes, 0);
  assert.equal(metrics.historyBytes, 0);
});

test('browser and briefing entry points contain no implicit full-build path', () => {
  for (const file of [
    'web/src/HostedWork.tsx',
    'web/src/hosted-work-index.ts',
    'src/agent-brief.ts',
    'src/host-cli.ts',
    'convex/projectWorkIndexedCommand.ts',
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert(
      !/projectWorkIndexActions[.:]ensure|workIndex\.ensure|ensureWorkIndex|rebuildWorkIndex/.test(source),
      file,
    );
  }
});
