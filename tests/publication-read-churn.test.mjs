// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getFunctionName } from 'convex/server';
import { fixture, checkpoint, modules } from './project-exchange-fixture.mjs';
import { ForgeError } from '../dist/errors.js';
import { digest } from '../dist/hash.js';
import { LONG_ACTION_BUDGET_MS } from '../dist/long-action.js';
import { nativeManifestSchema } from '../dist/work-archive-metadata.js';
import { publicationPages } from '../dist/publication-metadata.js';
import { publicationPinWindow, publicationPagePins } from '../dist/publication-pin-window.js';
const code = expected => error => error.data?.code === expected || error.code === expected;

async function staged(t, count = 10000) {
  const s = fixture(),
    { input, manifest } = await checkpoint(t, s);
  s.tables.hostedProjects.get('project').r2Writes = true;
  const pins = manifest.files
    .filter(f => f.path !== 'work.json')
    .map(({ sha256, size }) => ({ sha256, size }));
  pins.push({ sha256: input.digest, size: input.size });
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.from(
      JSON.stringify({ collection: 'intents', id: `record-${i}`, outcome: `Synthetic ${i}` }),
    );
    const pin = { sha256: digest(bytes), size: bytes.length };
    pins.push(pin);
    manifest.files.push({ path: `objects/${pin.sha256}`, ...pin });
    s.tables.projectObjects.set(`record-${i}`, {
      _id: `record-${i}`,
      projectId: 'project',
      digest: pin.sha256,
      size: pin.size,
      storageId: `synthetic-${i}`,
      removed: false,
    });
  }
  const normalizedManifest = nativeManifestSchema.parse(manifest);
  const preview = {
    manifestDigest: digest(JSON.stringify(normalizedManifest)),
    head: manifest.head,
    format: 'native',
    revision: manifest.revision,
    intents: 0,
    lanes: 0,
    views: 0,
    runs: 0,
    files: manifest.files.length,
    unavailable: 0,
    channels: [],
  };
  const metadata = {
    schema: 1,
    manifest: normalizedManifest,
    pins,
    edges: [{ head: manifest.head, parents: [], blobs: [] }],
    ownerDerived: {
      schema: 3,
      work: manifest.files.find(f => f.path === 'work.json').sha256,
      parents: [],
      ancestry: [],
      stats: [],
      views: [],
      trees: [],
    },
    preview,
  };
  const { pages, digest: metadataDigest } = publicationPages(metadata);
  const request = digest(JSON.stringify(['project', input.operationId, null, input.digest, input.size]));
  let cursor = await modules.projectPublicationStore.begin._handler(s.ctx, {
    projectId: 'project',
    operationId: input.operationId,
    request,
    digest: input.digest,
    size: input.size,
    metadataDigest,
    pages: pages.length,
  });
  for (const body of pages)
    cursor = await modules.projectPublicationStore.append._handler(s.ctx, {
      id: cursor.id,
      position: cursor.cursor,
      previous: cursor.chain,
      body,
    });
  return { s, input: { ...input, metadataOnly: 1, continuation: true }, id: cursor.id, pages, pins };
}

/** Attribute returned DB document bytes and reads to the actual fake ctx function,
 * including reads performed inside mutations (not just runQuery response bytes). */
function meter(s) {
  const active = new AsyncLocalStorage(),
    stats = new Map();
  const record = row => {
    const name = active.getStore() ?? 'direct';
    const value = stats.get(name) ?? {
      calls: 0,
      reads: 0,
      bytes: 0,
      pageReads: 0,
      pageBytes: 0,
      objectReads: 0,
    };
    value.reads++;
    value.bytes += Buffer.byteLength(JSON.stringify(row ?? null));
    if (row && s.tables.projectPublicationPages.has(row._id)) {
      value.pageReads++;
      value.pageBytes += Buffer.byteLength(row.body);
    }
    if (row && s.tables.projectObjects.has(row._id)) value.objectReads++;
    stats.set(name, value);
    return row;
  };
  const get = s.ctx.db.get,
    query = s.ctx.db.query;
  s.ctx.db.get = async id => record(await get(id));
  s.ctx.db.query = table => {
    const result = query(table),
      unique = result.unique,
      take = result.take;
    result.take = async count => (await take(count)).map(record);
    result.unique = async () => record(await unique());
    return result;
  };
  for (const method of ['runQuery', 'runMutation']) {
    const run = s.ctx[method];
    s.ctx[method] = (ref, args) =>
      active.run(getFunctionName(ref), async () => {
        const value = stats.get(getFunctionName(ref)) ?? {
          calls: 0,
          reads: 0,
          bytes: 0,
          pageReads: 0,
          pageBytes: 0,
          objectReads: 0,
        };
        value.calls++;
        stats.set(getFunctionName(ref), value);
        return method === 'runMutation' ? s.transaction(() => run(ref, args)) : run(ref, args);
      });
  }
  return stats;
}

test('10k-record publication continuations read metadata at most twice, never once per resume', async t => {
  const f = await staged(t),
    stats = meter(f.s),
    run = f.s.ctx.runMutation;
  let now = Date.now(),
    resumes = 0,
    failFinal = true,
    loseFinal = true;
  t.mock.method(Date, 'now', () => now);
  const positions = new Set();
  f.s.ctx.runMutation = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectExchange:publish' && failFinal) {
      failFinal = false;
      throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'failed before final commit');
    }
    const result = await run(ref, args);
    if (name === 'projectPublicationProgress:advance') {
      assert.ok(!positions.has(args.position), 'no verified page is revisited');
      positions.add(args.position);
      now += LONG_ACTION_BUDGET_MS + 1;
    }
    if (name === 'projectExchange:publish' && loseFinal) {
      loseFinal = false;
      throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'lost final reply');
    }
    return result;
  };
  let progress = -1,
    pageCursor = -1;
  while (true) {
    try {
      const value = await modules.projectExchangeActions.publish._handler(f.s.ctx, f.input);
      assert.equal(value.pending, true);
      const saved = JSON.parse(value.progress);
      assert.ok(saved.cursor > pageCursor);
      pageCursor = saved.cursor;
      const current = saved.done;
      assert.ok(current > progress);
      progress = current;
      resumes++;
    } catch (error) {
      assert.match(error.message, /failed before final commit/);
      break;
    }
  }
  assert.ok(resumes > 20);
  const beforeRetry = structuredClone([...stats]);
  await assert.rejects(modules.projectExchangeActions.publish._handler(f.s.ctx, f.input), /lost final reply/);
  const receipt = await modules.projectExchangeActions.publish._handler(f.s.ctx, f.input);
  assert.equal(typeof receipt, 'string');
  assert.equal(f.s.tables.projectBackups.size, 1);
  assert.equal(f.s.tables.projectPublications.get(f.id).validated, true);
  const read = stats.get('projectPublicationStore:readBatch'),
    advance = stats.get('projectPublicationProgress:advance');
  assert.equal(read.calls, Math.ceil(f.pages.length / 16));
  assert.equal(read.pageReads, f.pages.length);
  assert.equal(read.pageBytes, Buffer.byteLength(f.pages.join('')));
  assert.equal(advance.objectReads, f.pins.length);
  assert.equal(advance.pageReads, resumes - 1, 'first invocation reuses its scanned bytes');
  assert.ok(advance.pageReads <= f.pages.length);
  assert.ok(advance.pageBytes <= read.pageBytes);
  for (const [name, value] of beforeRetry)
    if (name === 'projectPublicationStore:readBatch' || name === 'projectPublicationProgress:advance')
      assert.deepEqual(stats.get(name), value, 'final retries do not read metadata or pins');
  assert.equal(stats.get('projectPublicationStore:pins'), undefined);
  assert.equal(stats.get('projectPublicationStore:read'), undefined);
  assert.ok([...stats.values()].reduce((n, v) => n + v.pageReads, 0) <= 2 * f.pages.length);
  t.diagnostic(
    JSON.stringify({
      records: 10000,
      pages: f.pages.length,
      resumes,
      perFunction: Object.fromEntries(stats),
      totalPageReads: read.pageReads + advance.pageReads,
      totalPageBytes: read.pageBytes + advance.pageBytes,
    }),
  );
});

test('pin cursor commits atomically, reconciles lost replies and preserves current authority', async t => {
  const f = await staged(t, 400),
    run = f.s.ctx.runMutation;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  f.s.ctx.runMutation = async (ref, args) => {
    const result = await run(ref, args);
    if (getFunctionName(ref) === 'projectPublicationProgress:advance') now += LONG_ACTION_BUDGET_MS + 1;
    return result;
  };
  const initial = await modules.projectExchangeActions.publish._handler(f.s.ctx, f.input);
  assert.equal(initial.pending, true);
  const current = structuredClone(f.s.tables.projectPublications.get(f.id).validation);
  const stats = meter(f.s);
  const replay = await modules.projectPublicationProgress.advance._handler(f.s.ctx, {
    id: f.id,
    owner: 'owner',
    position: current.position - 1,
  });
  assert.deepEqual(replay, current);
  assert.equal(
    [...stats.values()].reduce((n, v) => n + v.pageReads, 0),
    0,
  );
  const missing = f.pins.at(-1),
    row = [...f.s.tables.projectObjects.values()].find(r => r.digest === missing.sha256);
  row.removed = true;
  while (true) {
    const before = structuredClone(f.s.tables.projectPublications.get(f.id).validation);
    try {
      await f.s.transaction(() =>
        modules.projectPublicationProgress.advance._handler(f.s.ctx, {
          id: f.id,
          owner: 'owner',
          position: before.position,
        }),
      );
    } catch (error) {
      assert.ok(code('PUBLISH_PIN_MISSING')(error));
      assert.deepEqual(f.s.tables.projectPublications.get(f.id).validation, before);
      break;
    }
  }
  const before = structuredClone(f.s.tables.projectPublications.get(f.id).validation);
  await assert.rejects(
    modules.projectPublicationProgress.advance._handler(f.s.ctx, {
      id: f.id,
      owner: 'stranger',
      position: before.position,
    }),
    code('PROJECT_UNAVAILABLE'),
  );
  f.s.tables.hostedProjects.get('project').r2Writes = false;
  await assert.rejects(
    modules.projectPublicationProgress.advance._handler(f.s.ctx, {
      id: f.id,
      owner: 'owner',
      position: before.position,
    }),
    code('PUBLICATION_CAPABILITY_CHANGED'),
  );
  assert.deepEqual(f.s.tables.projectPublications.get(f.id).validation, before);
  f.s.tables.hostedProjects.get('project').r2Writes = true;
  row.removed = false;
  const result = await modules.projectExchangeActions.publish._handler(f.s.ctx, f.input);
  assert.equal(result.pending, true);
  assert.equal(typeof (await modules.projectExchangeActions.publish._handler(f.s.ctx, f.input)), 'string');
});

test('a busy publication claim waits without reading metadata or advancing another worker cursor', async t => {
  const f = await staged(t, 1),
    stats = meter(f.s),
    run = f.s.ctx.runMutation;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  f.s.tables.projectPublicationAttempts.set('busy', {
    _id: 'busy',
    projectId: 'project',
    owner: 'owner',
    operationId: f.input.operationId,
    request: f.s.tables.projectPublications.get(f.id).request,
    attemptId: 'other-worker',
    expiresAt: now + 600000,
  });
  f.s.ctx.runMutation = async (ref, args) => {
    const result = await run(ref, args);
    if (getFunctionName(ref) === 'projectPublicationAttempt:claim') now += LONG_ACTION_BUDGET_MS + 1;
    return result;
  };
  const result = await modules.projectExchangeActions.publish._handler(f.s.ctx, f.input);
  assert.equal(result.pending, true);
  assert.equal(JSON.parse(result.progress).phase, 'publication-wait');
  for (const name of [
    'projectPublicationStore:read',
    'projectPublicationStore:readBatch',
    'projectPublicationStore:load',
    'projectPublicationProgress:advance',
    'projectPublicationAttempt:release',
  ])
    assert.equal(stats.get(name), undefined);
  assert.equal(f.s.tables.projectPublications.get(f.id).validation, undefined);
  assert.equal(f.s.tables.projectPublicationAttempts.get('busy').attemptId, 'other-worker');
});

test('pin windows preserve arbitrary page boundaries, escaped keys and last-key JSON semantics', () => {
  const pin = { sha256: 'a'.repeat(64), size: 12 };
  const text =
    '{"nested":{"pins":[]},"pins":[],"pi\\u006es" : [ \n' +
    JSON.stringify(pin, null, 2) +
    ', ' +
    JSON.stringify(pin) +
    ' ],"tail":"😀"}';
  for (const width of [1, 7, 33, 1000]) {
    const pages = Array.from({ length: Math.ceil(text.length / width) }, (_, i) =>
      text.slice(i * width, (i + 1) * width),
    );
    const range = publicationPinWindow(pages),
      actual = [];
    let tail = '';
    for (let position = range.position; position <= range.endPosition; position++) {
      const result = publicationPagePins(
        tail,
        pages[position].slice(
          position === range.position ? range.offset : 0,
          position === range.endPosition ? range.endOffset : undefined,
        ),
      );
      actual.push(...result.pins);
      tail = result.tail;
    }
    assert.deepEqual(actual, [pin, pin]);
    assert.equal(tail, '');
  }
});
