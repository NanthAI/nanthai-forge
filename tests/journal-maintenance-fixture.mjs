// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { JOURNAL_TABLES } from '../dist/journal-segment.js';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const run = await import(moduleUrl('../convex/projectJournalRun.ts'));
const modules = Object.fromEntries(
  await Promise.all(
    ['projectJournalCapture', 'projectJournalPublish'].map(async name => [
      name,
      await import(moduleUrl(`../convex/${name}.ts`)),
    ]),
  ),
);
export async function journalMaintenanceFixture(t, { f: provided, advance = true } = {}) {
  const settings = { ...synthetic, FORGE_JOURNAL_SEGMENTS: '1' },
    prior = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  // Build the baseline with ordinary production defaults. The one operator run must move existing rows.
  delete process.env.FORGE_JOURNAL_SEGMENTS;
  Object.assign(process.env, synthetic);
  const f = provided ?? (await finishFixture(t));
  if (!provided) {
    const state = await f.enqueue(f.request());
    await f.drain();
    await f.passChecks();
    await f.drain();
    assert.equal((await f.current(state.id)).submission.phase, 'landed');
  }
  // The older controller fixture uses serial creation positions for non-operation
  // tables. Journal age/frontier tests require the provider's wall-clock model.
  const wallCreation = (table, id) => {
    const row = f.tables[table].get(id);
    if (JOURNAL_TABLES.includes(table) && row._creationTime < 1e12)
      f.tables[table].set(id, { ...row, _creationTime: Date.now() + row._creationTime / 1000 });
  };
  for (const table of JOURNAL_TABLES) for (const id of f.tables[table].keys()) wallCreation(table, id);
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  if (advance) f.advanceClock(31 * 86_400_000);
  const objects = new Map(),
    requests = [],
    calls = [],
    transcript = [],
    io = [],
    queue = [];
  let corrupt = false,
    losePublish = false,
    losePut = false;
  const previous = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    if (!path.includes('/journal-segments/')) return previous(url, init);
    const key = path.split('/').at(-1),
      method = init?.method ?? 'GET';
    requests.push(method);
    if (method === 'PUT') {
      assert(!objects.has(key), 'replay reconciles the object before another PUT');
      objects.set(key, Buffer.from(init.body));
      if (losePut) {
        losePut = false;
        throw new TypeError('Synthetic lost archive PUT response');
      }
      return new Response(null, { status: 200 });
    }
    if (!objects.has(key)) return new Response(null, { status: 404 });
    const bytes = Buffer.from(objects.get(key));
    if (corrupt) bytes[bytes.length - 1] ^= 1;
    return new Response(bytes);
  });
  const ctx = {
    runMutation: async (ref, args) => {
      const name = getFunctionName(ref),
        [file, method] = name.split(':');
      calls.push(name);
      const value = await f.c.transaction('journalWriterPage', modules[file][method], args);
      const meter = f.c.counts.at(-1);
      io.push({
        name,
        documents: meter.documents,
        reads: meter.ranges,
        readBytes: meter.readBytes,
        writes: meter.writes,
        writeBytes: meter.writeBytes,
      });
      transcript.push({ name, args: structuredClone(args), value });
      if (losePublish && file === 'projectJournalPublish') {
        losePublish = false;
        throw new Error('Synthetic lost published response');
      }
      return value;
    },
    scheduler: {
      runAfter: async (_delay, ref, input) => {
        assert.equal(getFunctionName(ref), 'projectJournalRun:pack');
        queue.push(input);
      },
    },
  };
  const input = { projectId: f.projectId, operationId: randomUUID(), existing: true };
  const pack = async (request = input) => JSON.parse(await run.pack._handler(ctx, request));
  const drain = async (request = input) => {
    const results = [await pack(request)];
    for (let n = 0; queue.length; n++) {
      assert(n < 1000, 'finite fixture frontier drains');
      results.push(await pack(queue.shift()));
    }
    return results;
  };
  return {
    f,
    mutate: fn => f.c.transaction('journalEdit', { _handler: fn }, {}),
    insert: async (table, value) => {
      const id = await f.c.transaction('journalSeed', { _handler: ctx => ctx.db.insert(table, value) }, {});
      wallCreation(table, id);
      return id;
    },
    ctx,
    input,
    pack,
    drain,
    queue,
    objects,
    requests,
    calls,
    transcript,
    io,
    corrupt: () => {
      corrupt = true;
    },
    losePut: () => {
      losePut = true;
    },
    losePublish: () => {
      losePublish = true;
    },
    release: () => f.advanceClock(11 * 60_000),
  };
}
