// SPDX-License-Identifier: Apache-2.0
import { saveSourceProgress, loadSourceProgress } from '../dist/hosted-source-step-progress.js';
import { runSourceStep } from '../dist/hosted-source-step.js';
const parts = [];
for await (const part of process.stdin) parts.push(part);
const input = JSON.parse(Buffer.concat(parts).toString()),
  objects = new Map(input.objects.map(([id, b]) => [id, Buffer.from(b, 'base64')])),
  reads = [],
  uploads = [];
const io = {
  async describeBatch(ids) {
    return ids.map(id => ({ object: { sha256: id, size: objects.get(id).length }, recipe: null }));
  },
  async read(pin) {
    reads.push(pin);
    const bytes = objects.get(pin.sha256);
    if (!bytes) throw Error('fixture object absent');
    return (async function* () {
      for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536);
    })();
  },
  async upload(pin, stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const bytes = Buffer.concat(chunks);
    objects.set(pin.sha256, bytes);
    uploads.push([pin.sha256, bytes.toString('base64')]);
  },
};
try {
  const started = performance.now(),
    result = await runSourceStep(input.cursor, io);
  if (result.cursor.phase !== 'done') {
    const progress = new Map();
    let serial = 0;
    const saved = await saveSourceProgress(result.cursor, null, async bytes => {
      const id = String(++serial);
      progress.set(id, bytes);
      return id;
    });
    await loadSourceProgress(progress.get(saved.id), async id => progress.get(id));
  }
  result.metrics.elapsedMs = performance.now() - started;
  result.metrics.maxRssBytes = process.resourceUsage().maxRSS * 1024;
  process.stdout.write(JSON.stringify({ result, reads, uploads }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code, message: error.message } }));
}
