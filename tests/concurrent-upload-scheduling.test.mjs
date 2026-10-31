// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fixture, modules } from './project-exchange-fixture.mjs';
import { defaultR2Objects, defaultR2Config, interceptDefaultR2 } from './default-r2.mjs';
import { ForgeError } from '../dist/errors.js';
import { digest } from '../dist/hash.js';
import { uploadPhysicalObjects } from '../dist/exchange-upload.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { mapExchange } from '../dist/exchange-parallel.js';
const data = (count = 64) =>
  Array.from({ length: count }, (_, i) => {
    const bytes = Buffer.alloc(64 * 1024, i);
    return { pin: { sha256: digest(bytes), size: bytes.length }, bytes, read: () => bytes };
  });
function environment(t) {
  const s = fixture(),
    invoke = s.ctx.runMutation;
  let transaction = Promise.resolve(),
    posts = 0,
    postBytes = 0,
    active = 0,
    peak = 0,
    largeActive = 0,
    largeOverlap = false;
  const mutation = (ref, args) => {
    const value = transaction.then(() => invoke(ref, args));
    transaction = value.catch(() => {});
    return value;
  };
  // Counts R2 PUTs (bytes always go to R2) before the test bucket stores them.
  const restore = interceptDefaultR2(async (url, init, serve) => {
    if (init?.method !== 'PUT') return serve(url, init);
    posts++;
    postBytes += init.body.byteLength;
    active++;
    if (init.body.byteLength > 8 * 1024 * 1024) largeActive++;
    if (largeActive && active > 1) largeOverlap = true;
    peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      return await serve(url, init);
    } finally {
      active--;
      if (init.body.byteLength > 8 * 1024 * 1024) largeActive--;
    }
  });
  t.after(restore);
  return {
    s,
    client: { mutation, query: (ref, args) => invoke(ref, args), action: (ref, args) => invoke(ref, args) },
    mutate: mutation,
    stats: () => ({ posts, postBytes, active, peak, largeOverlap }),
  };
}
// Preserved original batch algorithm for deterministic differential comparison;
// FORGE_UPLOAD_BASELINE_RUNTIME can select the actual installed old transport.
async function original(client, objects) {
  const prepared = await client.mutation('projectObjects:prepareBatch', {
    projectId: 'project',
    objects: objects.map(({ pin }) => ({ digest: pin.sha256, size: pin.size })),
  });
  const done = await Promise.all(
    prepared.map(async (row, index) => {
      if (row.stored) return null;
      await fetch(row.target.url, { method: 'PUT', headers: row.target.headers, body: objects[index].bytes });
      return { id: row.id };
    }),
  );
  await client.action('projectObjectCommit:commitBatch', { objects: done.filter(Boolean) });
}
test('separate simultaneous clients reduce duplicate cold bytes by doing different available work', async t => {
  const objects = data(),
    batches = Array.from({ length: 8 }, (_, i) => objects.slice(i * 8, (i + 1) * 8)),
    run = async candidate => {
      const e = environment(t),
        started = performance.now();
      const clients = [0, 1].map(() => {
        const c = new ConvexExchange(
          'https://fixture.convex.cloud',
          'fixture',
          'project',
          randomUUID(),
          null,
        );
        c.client = e.client;
        return c;
      });
      if (candidate) await Promise.all(clients.map(c => uploadPhysicalObjects(c.client, 'project', objects)));
      else if (process.env.FORGE_UPLOAD_BASELINE_RUNTIME) {
        const { ConvexExchange: Old } = await import(
          pathToFileURL(`${process.env.FORGE_UPLOAD_BASELINE_RUNTIME}/dist/exchange-client.js`)
        );
        await Promise.all(
          clients.map(() => {
            const c = new Old('https://fixture.convex.cloud', 'fixture', 'project', randomUUID(), null);
            c.client = e.client;
            return mapExchange(batches, 2, batch => c.uploadBatch(batch));
          }),
        );
      } else
        await Promise.all(
          clients.map(() =>
            mapExchange(batches, 2, batch =>
              original(
                {
                  mutation: (name, args) => e.mutate(name, args),
                  action: (name, args) => e.client.action(name, args),
                },
                batch,
              ),
            ),
          ),
        );
      assert.equal(e.stats().active, 0);
      for (const object of objects) {
        const row = [...e.s.tables.projectObjects.values()].find(row => row.digest === object.pin.sha256);
        assert(row?.r2Committed);
        assert.equal(defaultR2Objects.get(`${defaultR2Config.bucket}/${row.r2Key}`).length, object.pin.size);
      }
      const first = e.stats(),
        reads = { count: 0 };
      await uploadPhysicalObjects(
        e.client,
        'project',
        objects.map(x => ({
          ...x,
          read: () => {
            reads.count++;
            return x.bytes;
          },
        })),
      );
      assert.equal(reads.count, 0);
      assert.equal(e.stats().posts, first.posts);
      return {
        ...first,
        elapsedMs: performance.now() - started,
        uniqueBytes: objects.reduce((n, x) => n + x.pin.size, 0),
      };
    };
  const baseline = await run(false),
    candidate = await run(true);
  // Two naive clients send every byte twice. The baseline can skip objects the other
  // client already committed, so it is compared to that bound rather than to the candidate.
  assert(baseline.postBytes > baseline.uniqueBytes && baseline.postBytes <= 2 * baseline.uniqueBytes);
  assert(candidate.postBytes < 2 * candidate.uniqueBytes);
  assert(candidate.postBytes >= candidate.uniqueBytes);
  assert(candidate.peak > 1);
  t.diagnostic(
    JSON.stringify({
      baseline,
      candidate,
      environment:
        'Two independent client objects; actual backend handlers with atomic serialized mutation fixture and concurrent R2 PUTs. No shared upload promise, sleep or lease. Not a live-provider benchmark; remaining tail overlap may duplicate.',
    }),
  );
});
test('fresh-first preparation leaves abandoned pending content immediately uploadable and legacy APIs unchanged', async t => {
  const e = environment(t),
    objects = data(12),
    pins = objects.map(x => ({ digest: x.pin.sha256, size: x.pin.size }));
  const first = await modules.projectObjects.available._handler(e.s.ctx, {
    projectId: 'project',
    objects: pins,
  });
  assert.equal(first.selected.length, 8);
  assert.equal(e.s.tables.projectObjects.size, 0);
  const rows = await modules.projectObjects.prepareBatch._handler(e.s.ctx, {
    projectId: 'project',
    objects: first.selected.map(i => pins[i]),
  });
  const second = await modules.projectObjects.available._handler(e.s.ctx, {
    projectId: 'project',
    objects: pins,
  });
  assert.deepEqual(second.selected, [8, 9, 10, 11]);
  await modules.projectObjects.prepareBatch._handler(e.s.ctx, {
    projectId: 'project',
    objects: second.selected.map(i => pins[i]),
  });
  const fallback = await modules.projectObjects.available._handler(e.s.ctx, {
    projectId: 'project',
    objects: pins,
  });
  assert.equal(fallback.selected.length, 8);
  const legacy = await modules.projectObjects.prepare._handler(e.s.ctx, { projectId: 'project', ...pins[0] });
  assert.equal(legacy.id, rows[0].id);
  assert(legacy.target);
  await uploadPhysicalObjects(e.client, 'project', objects);
  assert.equal(
    e.stats().postBytes,
    objects.reduce((n, x) => n + x.pin.size, 0),
  );
  e.s.caller('stranger');
  await assert.rejects(
    uploadPhysicalObjects(e.client, 'project', objects),
    x => x.data?.code === 'PROJECT_UNAVAILABLE',
  );
  e.s.caller('owner');
  await assert.rejects(
    modules.projectObjects.available._handler(e.s.ctx, {
      projectId: 'project',
      objects: [{ ...pins[0], size: 3 }],
    }),
    x => x.data?.code === 'INVALID_WORK_BACKUP',
  );
});
test('changed lazy bytes fail before PUT while successful active siblings settle and remain reusable', async t => {
  const e = environment(t),
    objects = data(16);
  objects[0].read = () => Buffer.from('changed source');
  await assert.rejects(
    uploadPhysicalObjects(e.client, 'project', objects),
    x => x.code === 'EXCHANGE_SOURCE_CHANGED',
  );
  assert.equal(e.stats().active, 0);
  const retained = [...e.s.tables.projectObjects.values()].filter(x => x.r2Committed);
  assert(retained.length > 0);
  const prior = e.stats().posts;
  objects[0].read = () => objects[0].bytes;
  await uploadPhysicalObjects(e.client, 'project', objects);
  assert.equal(e.stats().posts - prior, objects.length - retained.length);
});
test('oversized existing raw members run alone while normal windows retain bounded parallelism', async t => {
  const e = environment(t),
    bytes = Buffer.alloc(17 * 1024 * 1024, 42),
    large = { pin: { sha256: digest(bytes), size: bytes.length }, read: () => bytes };
  await uploadPhysicalObjects(e.client, 'project', [large, ...data(12)]);
  assert(e.stats().peak <= 16);
  assert.equal(e.stats().largeOverlap, false);
  assert.equal(e.stats().postBytes, bytes.length + 12 * 64 * 1024);
  assert.equal([...e.s.tables.projectObjects.values()].filter(row => row.r2Committed).length, 13);
});
test('discovery hints cannot retain authority or force a repeated upload after concurrent completion', async t => {
  const e = environment(t),
    objects = data(8);
  let first = true;
  const completed = {
    mutation: e.client.mutation,
    query: async (ref, args) => {
      const hints = await e.client.query(ref, args);
      if (first) {
        first = false;
        await uploadPhysicalObjects(e.client, 'project', objects);
      }
      return hints;
    },
  };
  await uploadPhysicalObjects(
    completed,
    'project',
    objects.map(x => ({
      ...x,
      read: () => {
        throw Error('Concurrent stored binding must skip source read');
      },
    })),
  );
  assert.equal(e.stats().posts, objects.length);
  const f = environment(t),
    denied = {
      mutation: f.client.mutation,
      query: async (ref, args) => {
        const hints = await f.client.query(ref, args);
        f.s.caller('stranger');
        return hints;
      },
    };
  await assert.rejects(
    uploadPhysicalObjects(denied, 'project', objects),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(f.stats().posts, 0);
});
test('authoritative preparation reads only selected pins despite unrelated discoveries changing', async t => {
  const e = environment(t),
    objects = data(64),
    pins = objects.map(x => ({ digest: x.pin.sha256, size: x.pin.size })),
    hints = await modules.projectObjects.available._handler(e.s.ctx, { projectId: 'project', objects: pins });
  assert.equal(hints.selected.length, 8);
  assert.equal(e.s.tables.projectObjects.size, 0);
  // Other clients may prepare/complete every nonselected pin after discovery.
  await uploadPhysicalObjects(e.client, 'project', objects.slice(8));
  const reads = [],
    query = e.s.ctx.db.query.bind(e.s.ctx.db);
  e.s.ctx.db.query = table => {
    const builder = query(table),
      withIndex = builder.withIndex.bind(builder);
    builder.withIndex = (name, apply) =>
      withIndex(name, q => {
        let proxy;
        proxy = new Proxy(q, {
          get(target, key) {
            if (key === 'eq')
              return (field, value) => {
                if (table === 'projectObjects' && field === 'digest') reads.push(value);
                target.eq(field, value);
                return proxy;
              };
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return apply(proxy);
      });
    return builder;
  };
  try {
    await modules.projectObjects.prepareBatch._handler(e.s.ctx, {
      projectId: 'project',
      objects: hints.selected.map(i => pins[i]),
    });
  } finally {
    e.s.ctx.db.query = query;
  }
  assert.deepEqual([...new Set(reads)].sort(), hints.selected.map(i => pins[i].digest).sort());
  assert.equal(reads.length, 8);
});

test('hosting batches 64 pins with bounded posts and exact once-only lazy reads', async t => {
  const e = environment(t),
    objects = data(150),
    calls = [],
    reads = new Map();
  const client = {
    query: e.client.query,
    action: e.client.action,
    mutation: (ref, args) => {
      const name = getFunctionName(ref);
      if (name === 'projectObjects:prepareBatch') {
        assert(args.objects.length <= 64);
        calls.push(args.objects.length);
      }
      return e.client.mutation(ref, args);
    },
  };
  const result = await uploadPhysicalObjects(
    client,
    'project',
    objects.map(object => ({
      ...object,
      read: () => {
        reads.set(object.pin.sha256, (reads.get(object.pin.sha256) ?? 0) + 1);
        return object.bytes;
      },
    })),
    { batchSize: 64 },
  );
  assert.equal(result.uploadedObjects, 150);
  assert.equal(result.uploadedBytes, 150 * 64 * 1024);
  assert.equal(reads.size, 150);
  assert([...reads.values()].every(count => count === 1));
  assert.deepEqual(
    calls.slice().sort((a, b) => b - a),
    [64, 64, 22],
  );
  assert(e.stats().peak <= 64);
  await uploadPhysicalObjects(
    client,
    'project',
    objects.map(object => ({ ...object, read: () => assert.fail('stored bytes reread') })),
    { batchSize: 64 },
  );
  assert.equal(e.stats().posts, 150);
});

test('unknown upload exhausts bounded attempts with pin and attempt count; deterministic errors do not retry', async t => {
  const e = environment(t),
    objects = data(1),
    delays = [];
  let calls = 0;
  await assert.rejects(
    uploadPhysicalObjects(e.client, 'project', objects, {
      batchSize: 100,
      blobs: {
        put: async () => {
          calls++;
          throw new ForgeError('EXCHANGE_UPLOAD_UNKNOWN', 'Synthetic offline upload');
        },
      },
      wait: async ms => {
        delays.push(ms);
      },
    }),
    error =>
      error.code === 'EXCHANGE_UPLOAD_UNKNOWN' &&
      error.message.includes(objects[0].pin.sha256) &&
      error.message.includes('4 attempts'),
  );
  assert.equal(calls, 4);
  assert.deepEqual(delays, [250, 500, 1000]);
  calls = 0;
  await assert.rejects(
    uploadPhysicalObjects(e.client, 'project', objects, {
      batchSize: 100,
      blobs: {
        put: async () => {
          calls++;
          throw new ForgeError('EXCHANGE_SOURCE_CHANGED', 'Changed');
        },
      },
      wait: async () => assert.fail('deterministic rejection must not back off'),
    }),
    error => error.code === 'EXCHANGE_SOURCE_CHANGED',
  );
  assert.equal(calls, 1);
});

test('raw upload acknowledgements identify exact committed members despite reused recipes and retry counters', async t => {
  const e = environment(t),
    objects = data(3);
  await uploadPhysicalObjects(e.client, 'project', [objects[0]], { batchSize: 100 });
  const row = [...e.s.tables.projectObjects.values()].find(row => row.digest === objects[0].pin.sha256);
  // An existing logical recipe is stored, but is not a newly committed raw member.
  row.r2Committed = undefined;
  row.recipe = { digest: digest('synthetic-recipe'), size: 16 };
  const raw = new Set();
  await uploadPhysicalObjects(e.client, 'project', objects, {
    batchSize: 100,
    onRaw: id => raw.add(id),
    wait: async () => {},
  });
  assert(!raw.has(objects[0].pin.sha256));
  assert(raw.has(objects[2].pin.sha256), 'successful raw peer has an exact acknowledgement');
  for (const id of raw) assert(objects.slice(1).some(object => object.pin.sha256 === id));
  assert.equal(e.stats().posts, 3, 'the recipe-stored member uploads no bytes');
});
