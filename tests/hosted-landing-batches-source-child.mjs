// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { runSourceStep } from '../dist/hosted-source-step.js';
import { digest } from '../dist/hash.js';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { cursor, entries } = JSON.parse(input),
  objects = new Map(entries.map(([id, b]) => [id, Buffer.from(b, 'base64')]));
const committed = new Set(objects.keys()),
  uploads = [];
let windows = 0,
  documents = 0;
const result = await runSourceStep(cursor, {
  async prepareRead(pins) {
    assert(pins.length <= 100);
    assert(
      pins.every(p => committed.has(p.sha256)),
      'never resolve uncommitted generated States',
    );
    if (pins.length) {
      windows++;
      documents += pins.length;
    }
  },
  async describeBatch(ids) {
    assert(ids.length <= 100);
    windows++;
    documents += ids.length;
    return ids.map(id => {
      assert(committed.has(id));
      return { object: { sha256: id, size: objects.get(id).length }, recipe: null };
    });
  },
  async read(pin) {
    return [objects.get(pin.sha256)];
  },
  async upload(pin, stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.equal(digest(bytes), pin.sha256);
    objects.set(pin.sha256, bytes);
    uploads.push([pin.sha256, bytes.toString('base64')]);
  },
});
process.stdout.write(JSON.stringify({ result, uploads, windows, documents }));
