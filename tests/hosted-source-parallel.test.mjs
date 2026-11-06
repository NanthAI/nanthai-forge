// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSourceStep, runSourceStep } from '../dist/hosted-source-step.js';
import { runSmallSourceSave } from '../dist/hosted-source-small-save.js';
import { mapSourceOrdered, sourceIoConcurrency } from '../dist/hosted-source-parallel.js';
import { saveBytes, buildSavePages } from '../dist/hosted-save.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { digest } from '../dist/hash.js';

const at = '2026-01-01T00:00:00.000Z';
/** Every source read/upload is a network round trip in production. This transport
 * releases all requests waiting at the same moment as one "round", so `rounds`
 * is the serial chain a step's wall time (and billed memory-time) follows. */
function fixture({ serial = false } = {}) {
  const objects = new Map();
  let waiting = [],
    timer = null,
    rounds = 0,
    inFlight = 0,
    maxInFlight = 0,
    chain = Promise.resolve();
  const flush = () => {
    timer = null;
    rounds++;
    const ready = waiting;
    waiting = [];
    for (const release of ready) release();
  };
  const gate = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => {
      waiting.push(resolve);
      timer ??= setTimeout(flush, 2);
    });
    inFlight--;
  };
  // The one-at-a-time reference: each request waits for the previous one.
  const ordered = run => {
    if (!serial) return gate().then(run);
    const next = chain.then(() => gate().then(run));
    chain = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const put = value => {
    const bytes = Buffer.from(value),
      pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const json = value => put(saveBytes(value));
  const io = {
    async describeBatch(ids) {
      return ids.map(id => ({ object: { sha256: id, size: objects.get(id).length }, recipe: null }));
    },
    read: pin =>
      ordered(async () => {
        const bytes = objects.get(pin.sha256);
        assert(bytes, 'fixture object');
        return (async function* () {
          yield bytes;
        })();
      }),
    upload: (pin, stream) =>
      ordered(async () => {
        const parts = [];
        for await (const part of stream) parts.push(part);
        assert.deepEqual(put(Buffer.concat(parts)), pin);
      }),
  };
  return { objects, put, json, io, rounds: () => rounds, maxInFlight: () => maxInFlight };
}
/** 3,000-file State, a 20-file Lane change and one other landing on main. */
function scenario(x) {
  const blob = (i, v = 0) => x.put(`// ${i} v${v}\n` + 'export const x = 1;\n'.repeat(20 + (i % 40)));
  const files = Array.from({ length: 3000 }, (_, i) => ({
    path: `src/d${String(i % 64).padStart(2, '0')}/f-${String(i).padStart(4, '0')}.ts`,
    mode: 'file',
    blob: blob(i).sha256,
  })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const state = (list, parents) =>
    x.json({ schema: 1, kind: 'forge-source-state', parents, files: list, message: 'm', at });
  const root = state(files, []),
    base = state(files, [root.sha256]);
  const edit = (indices, v) =>
    files.map((file, k) => (indices.includes(k) ? { ...file, blob: blob(k, v).sha256 } : file));
  const lane = Array.from({ length: 20 }, (_, k) => k * 7),
    main = state(
      edit(
        lane.map(k => k + 3),
        2,
      ),
      [base.sha256],
    );
  const after = edit(lane, 1);
  const changes = lane
    .map(k => ({
      path: after[k].path,
      before: { blob: files[k].blob, mode: 'file' },
      after: {
        blob: after[k].blob,
        mode: 'file',
        content: {
          object: { sha256: after[k].blob, size: x.objects.get(after[k].blob).length },
          recipe: null,
        },
      },
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const pages = buildSavePages(changes);
  for (const page of pages.pages) x.json(page.value);
  const save = x.json({
    schema: 1,
    kind: 'forge-hosted-save-input',
    baseline: { object: base, recipe: null },
    pages: pages.root,
    pageCount: pages.pages.length,
    changeCount: changes.length,
    message: 's',
    at,
  });
  return { save, main };
}
async function drain(x, input) {
  let cursor = initialSourceStep(input);
  while (cursor.phase !== 'done')
    cursor = JSON.parse(JSON.stringify((await runSourceStep(cursor, x.io)).cursor));
  return cursor;
}

test('ordered source I/O keeps input order, bounds concurrency and reports the first failure by position', async () => {
  let active = 0,
    peak = 0;
  const values = await mapSourceOrdered(
    Array.from({ length: 30 }, (_, i) => i),
    async i => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, (30 - i) % 7));
      active--;
      return i * 2;
    },
  );
  assert.deepEqual(
    values,
    Array.from({ length: 30 }, (_, i) => i * 2),
  );
  assert.equal(peak, sourceIoConcurrency);
  await assert.rejects(
    mapSourceOrdered([0, 1, 2], async i => {
      // The later item fails first in time; the earlier one is still reported.
      await new Promise(resolve => setTimeout(resolve, i === 0 ? 20 : 1));
      throw Object.assign(new Error(`item ${i}`), { code: `E${i}` });
    }),
    { code: 'E0' },
  );
});

test('a 20-file save on a 3,000-file State overlaps its reads in both runtimes with identical output', async t => {
  const fast = fixture(),
    slow = fixture({ serial: true });
  const a = scenario(fast),
    b = scenario(slow);
  // Node step engine.
  const parallel = await drain(fast, a.save),
    parallelRounds = fast.rounds(),
    serial = await drain(slow, b.save),
    serialRounds = slow.rounds();
  assert.deepEqual(parallel.output, serial.output, 'same worker result');
  assert.equal(parallel.head, serial.head, 'same State');
  assert(serialRounds >= 25, `reference is one round trip per object: ${serialRounds}`);
  // input, save page, baseline, three verify rounds of <=8 objects, state, result.
  assert(parallelRounds <= 9, `Node save serial round trips: ${parallelRounds} (was ${serialRounds})`);
  assert(fast.maxInFlight() <= sourceIoConcurrency + 1);
  // V8 small save.
  const before = fast.rounds(),
    small = await runSmallSourceSave(a.save, fast.io),
    smallRounds = fast.rounds() - before,
    slowBefore = slow.rounds(),
    smallSerial = await runSmallSourceSave(b.save, slow.io),
    smallSerialRounds = slow.rounds() - slowBefore;
  assert.deepEqual(small, smallSerial, 'same small-save result');
  assert.deepEqual(small, parallel.output, 'V8 and Node results agree');
  assert(smallSerialRounds >= 23, `reference small save: ${smallSerialRounds}`);
  t.diagnostic(JSON.stringify({ parallelRounds, serialRounds, smallRounds, smallSerialRounds }));
  assert(smallRounds <= 7, `V8 small save serial round trips: ${smallRounds} (was ${smallSerialRounds})`);
});

test('compose reads both tips in one round trip and matches the one-at-a-time result', async t => {
  const results = [];
  for (const serial of [false, true]) {
    const x = fixture({ serial }),
      { save, main } = scenario(x),
      saved = await drain(x, save),
      head = JSON.parse(x.objects.get(saved.output.sha256)).state;
    const inputs = buildComposePages([
        {
          laneId: '00000000-0000-4000-8000-000000000001',
          head: head.sha256,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: { object: head, recipe: null },
        },
      ]),
      dependencies = buildComposePages([]);
    for (const page of [...inputs.pages, ...dependencies.pages]) x.json(page.value);
    const input = x.json({
      schema: 1,
      kind: 'forge-hosted-compose-input',
      base: { head: main.sha256, receiptId: 'main' },
      main: { object: main, recipe: null },
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
      algorithm: 'forge-native-compose-v1',
      message: 'merge',
      at,
    });
    const start = x.rounds(),
      composed = await drain(x, input);
    results.push({ output: composed.output, head: composed.head, rounds: x.rounds() - start });
  }
  const [parallel, serial] = results;
  t.diagnostic(JSON.stringify({ compose: parallel.rounds, serial: serial.rounds }));
  assert.deepEqual(parallel.output, serial.output);
  assert.equal(parallel.head, serial.head);
  assert(parallel.rounds < serial.rounds, `compose rounds ${parallel.rounds} vs ${serial.rounds}`);
});

test('the per-step source log line carries bounded counts and names only', async t => {
  const { logSourceStep } = await import('../dist/hosted-source-io-error.js');
  const lines = [];
  t.mock.method(console, 'warn', line => lines.push(JSON.parse(line)));
  logSourceStep(
    { jobId: 'job', step: 2 },
    {
      runtime: 'node',
      kind: 'compose',
      from: 'input',
      to: 'https://example.invalid/?X-Amz-Signature=secret',
      objects: 8,
      bytes: 1.5,
      outputs: 2,
      started: performance.now(),
    },
  );
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.deepEqual(Object.keys(line).sort(), [
    'bytes',
    'elapsedMs',
    'event',
    'from',
    'job',
    'kind',
    'objects',
    'outputs',
    'runtime',
    'step',
    'to',
  ]);
  assert.equal(line.event, 'forge-source-step');
  assert.equal(line.kind, 'compose');
  assert.equal(line.to, null, 'free text never enters the log');
  assert.equal(line.bytes, null);
  assert.equal(line.objects, 8);
});
