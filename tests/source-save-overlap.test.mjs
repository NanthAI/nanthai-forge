// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSourceStep, runSourceStep } from '../dist/hosted-source-step.js';
import { buildSavePages, saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';

test('bounded save reads its exact baseline and first delta page together, without extra reads', async () => {
  const objects = new Map();
  const put = bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const json = value => put(Buffer.from(saveBytes(value)));
  const before = put(Buffer.from('before')),
    after = put(Buffer.from('after'));
  const baseline = json({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: [{ path: 'file.txt', mode: 'file', blob: before.sha256 }],
    message: 'base',
    at: '2026-01-01T00:00:00Z',
  });
  const pages = buildSavePages([
    {
      path: 'file.txt',
      before: { blob: before.sha256, mode: 'file' },
      after: { blob: after.sha256, mode: 'file', content: { object: after, recipe: null } },
    },
  ]);
  for (const page of pages.pages) json(page.value);
  const input = json({
    schema: 1,
    kind: 'forge-hosted-save-input',
    baseline: { object: baseline, recipe: null },
    pages: pages.root,
    pageCount: pages.pages.length,
    changeCount: 1,
    message: 'save',
    at: '2026-01-01T00:00:00Z',
  });
  const baselineStarted = Promise.withResolvers(),
    pageStarted = Promise.withResolvers(),
    reads = new Map();
  const io = {
    async read(pin) {
      reads.set(pin.sha256, (reads.get(pin.sha256) ?? 0) + 1);
      if (pin.sha256 === baseline.sha256) {
        baselineStarted.resolve();
        await pageStarted.promise;
      }
      if (pin.sha256 === pages.root.sha256) {
        pageStarted.resolve();
        await baselineStarted.promise;
      }
      return (async function* () {
        yield objects.get(pin.sha256);
      })();
    },
    async upload(pin, stream) {
      const parts = [];
      for await (const part of stream) parts.push(part);
      const bytes = Buffer.concat(parts);
      assert.equal(digest(bytes), pin.sha256);
      objects.set(pin.sha256, bytes);
    },
  };
  const result = await runSourceStep(initialSourceStep(input), io);
  assert.equal(result.cursor.phase, 'done');
  const output = JSON.parse(objects.get(result.cursor.output.sha256)),
    state = JSON.parse(objects.get(output.state.sha256));
  assert.equal(state.files[0].blob, after.sha256);
  assert.deepEqual(state.parents, [baseline.sha256]);
  assert.equal(reads.get(baseline.sha256), 1);
  assert.equal(reads.get(pages.root.sha256), 1);
});
