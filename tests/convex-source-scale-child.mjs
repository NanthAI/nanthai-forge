// SPDX-License-Identifier: Apache-2.0
import { createReadStream } from 'node:fs';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import { convexStoreBlob } from './convex-storage-fake.mjs';
let sequence = 0;
const waiting = new Map();
const rpc = (kind, args) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, { resolve, reject });
    process.send({ id, kind, args });
  });
function bytes(spec) {
  if (Buffer.isBuffer(spec)) return spec;
  const b = Buffer.alloc(spec.size, spec.fill ?? 65);
  if (spec.index !== undefined) b.writeBigUInt64LE(BigInt(spec.index));
  return b;
}
process.on('message', async message => {
  if (message.reply) {
    const w = waiting.get(message.reply);
    waiting.delete(message.reply);
    if (message.error)
      w.reject(
        message.error.data === undefined ? Error(message.error.message) : new ConvexError(message.error.data),
      );
    else w.resolve(message.value);
    return;
  }
  if (!message.run) return;
  try {
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === 'PUT') {
        const existed = await rpc('r2-put', { url: String(url), bytes: Buffer.from(init.body) });
        return new Response(null, { status: existed ? 412 : 200 });
      }
      if (init.method === 'HEAD') {
        const metadata = await rpc('r2-head', { url: String(url) });
        return new Response(null, { status: metadata ? 200 : 404, headers: metadata ?? {} });
      }
      const spec = await rpc('fetch', { url: String(url) });
      if (spec.delay) await new Promise(resolve => setTimeout(resolve, spec.delay));
      if (spec.path) return new Response(createReadStream(spec.path, { highWaterMark: 65536 }));
      return new Response(
        new ReadableStream({
          start(controller) {
            const b = bytes(spec);
            for (let i = 0; i < b.length; i += 65536) controller.enqueue(b.subarray(i, i + 65536));
            controller.close();
          },
        }),
      );
    };
    const storage = {
      get: async id => {
        const spec = await rpc('get', { id });
        return spec ? new Blob([bytes(spec)]) : null;
      },
      store: async (blob, options) => {
        if (process.env.FORGE_BLOBS === 'r2')
          throw Error('Hot source worker called Convex storage.store in R2 mode');
        return rpc('store', { bytes: await convexStoreBlob(blob, options) });
      },
    };
    const ctx = {
      storage,
      runMutation: (ref, args) => rpc('mutation', { name: getFunctionName(ref), args }),
    };
    if (message.guardRss) {
      const { MemorySourceReader } = await import('../dist/hosted-source-memory.js'),
        original = MemorySourceReader.prototype.bytes;
      MemorySourceReader.prototype.bytes = async function (...args) {
        const value = await original.apply(this, args);
        if (process.resourceUsage().maxRSS * 1024 > 400 * 1024 * 1024)
          throw Error('S55 measurement stopped after observing >400 MiB');
        return value;
      };
    }
    const started = performance.now(),
      module = await import(message.url);
    await module[message.method]._handler(ctx, message.args);
    process.send({
      done: true,
      metrics: { elapsedMs: performance.now() - started, maxRssBytes: process.resourceUsage().maxRSS * 1024 },
    });
  } catch (error) {
    process.send({ done: true, error: { message: error.message, code: error.code, stack: error.stack } });
  }
});
