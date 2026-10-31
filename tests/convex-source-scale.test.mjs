// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { buildComposePages } from '../dist/hosted-compose.js';
import { buildSavePages, saveBytes } from '../dist/hosted-save.js';
import { scaleFixture, at, saveInput as save } from './convex-source-scale-fixture.mjs';
test('bounded source children join without polling or idle work', async t => {
  const s = await scaleFixture();
  try {
    assert.equal(s.ready.length, 0);
    const input = await save(s, 200),
      id = await s.enqueue(input),
      report = await s.drain();
    const job = await s.job(id);
    assert.equal(job.status, 'completed');
    assert.equal(s.ready.length, 0);
    assert(report.peakActive <= 4);
    assert(report.peakActive > 1);
    t.diagnostic(JSON.stringify(report));
  } finally {
    s.restore();
  }
});
test('many small files plus three 128 MiB recipe files stream through durable children', async t => {
  const s = await scaleFixture();
  try {
    const baseline = await s.json({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [],
        message: 'empty',
        at,
      }),
      changes = [];
    for (let i = 0; i < 400; i++) {
      const pin = await s.putSpec({ size: 1024, index: i });
      changes.push({
        path: `small/${i}`,
        before: null,
        after: { blob: pin.sha256, mode: 'file', content: { object: pin, recipe: null } },
      });
    }
    const { createHash } = await import('node:crypto');
    for (let i = 0; i < 3; i++) {
      const chunk = Buffer.alloc(1024 * 1024, 65 + i),
        leaf = await s.putSpec(chunk),
        hash = createHash('sha256');
      for (let j = 0; j < 128; j++) hash.update(chunk);
      const object = { sha256: hash.digest('hex'), size: 128 * 1024 * 1024 },
        page = await s.json({
          kind: 'forge-byte-tree',
          schema: 1,
          children: Array.from({ length: 128 }, () => ({ ...leaf, height: 0, length: leaf.size })),
        });
      const recipe = await s.json({
        kind: 'forge-object-recipe',
        schema: 1,
        object,
        tree: { ...page, height: 1, length: object.size },
      });
      await s.ctx.db.insert('projectObjects', {
        projectId: s.projectId,
        digest: object.sha256,
        size: object.size,
        nonce: 'synthetic',
        removed: false,
        recipe: { digest: recipe.sha256, size: recipe.size },
      });
      changes.push({
        path: `large/${i}.dat`,
        before: null,
        after: { blob: object.sha256, mode: 'file', content: { object, recipe } },
      });
    }
    const pages = buildSavePages(changes);
    for (const p of pages.pages) await s.json(p.value);
    const input = await s.json({
      schema: 1,
      kind: 'forge-hosted-save-input',
      baseline: { object: baseline, recipe: null },
      pages: pages.root,
      pageCount: pages.pages.length,
      changeCount: changes.length,
      message: 'mixed',
      at,
    });
    const id = await s.enqueue(input),
      report = await s.drain();
    assert.equal((await s.job(id)).status, 'completed');
    const result = JSON.parse(await s.bytes((await s.job(id)).output));
    assert.equal(JSON.parse(await s.bytes(result.state)).files.length, 403);
    t.diagnostic(JSON.stringify({ mixedRecipes: report }));
  } finally {
    s.restore();
  }
});
test('replayed fork and child replies retain one execution and one join; epoch changes fence queued children', async () => {
  for (const fenced of [false, true]) {
    const s = await scaleFixture();
    try {
      const id = await s.enqueue(await save(s, 200));
      await s.execute(s.ready.shift());
      const parent = s.ready.shift();
      await s.execute(parent);
      const tasks = s.tables.projectSourceTasks.size,
        step = [...s.tables.projectSourceSteps.values()][0];
      await s.execute(parent);
      assert.equal(s.tables.projectSourceTasks.size, tasks);
      assert.equal([...s.tables.projectSourceSteps.values()][0].step, step.step);
      if (fenced) await s.ctx.db.patch(s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
      else {
        const child = s.ready.shift();
        await s.execute(child);
        const done = [...s.tables.projectSourceBatches.values()][0].completed;
        await s.execute(child);
        assert.equal([...s.tables.projectSourceBatches.values()][0].completed, done);
      }
      await s.drain();
      const job = await s.job(id);
      assert.equal(s.tables.projectSourceSteps.size, 1);
      assert.equal(s.ready.length, 0);
      if (fenced) assert.notEqual(job.status, 'completed');
      else assert.equal(job.status, 'completed');
    } finally {
      s.restore();
    }
  }
});
test('overlapping compose and sync calculate independent file windows concurrently and retain native text results', async t => {
  const s = await scaleFixture();
  try {
    const middle = 'unchanged '.repeat(6000) + '\n',
      baseText = 'start\n' + middle + 'end\n',
      basePin = await s.putSpec(Buffer.from(baseText)),
      original = [],
      left = [],
      right = [],
      expected = [];
    for (let i = 0; i < 200; i++) {
      const path = `dir/${String(i).padStart(4, '0')}.txt`,
        l = await s.putSpec(Buffer.from(`left ${i}\n` + middle + 'end\n')),
        r = await s.putSpec(Buffer.from('start\n' + middle + `right ${i}\n`)),
        merged = {
          sha256: createHash('sha256')
            .update(`left ${i}\n` + middle + `right ${i}\n`)
            .digest('hex'),
        };
      original.push({ path, mode: 'file', blob: basePin.sha256 });
      left.push({ path, mode: 'file', blob: l.sha256 });
      right.push({ path, mode: 'file', blob: r.sha256 });
      expected.push({ path, mode: 'file', blob: merged.sha256 });
    }
    const state = (files, parents = []) =>
      s.json({ schema: 1, kind: 'forge-source-state', files, parents, message: 'seed', at });
    const base = await state(original),
      l = await state(left, [base.sha256]),
      r = await state(right, [base.sha256]);
    const inputs = buildComposePages([
        {
          laneId: randomUUID(),
          head: r.sha256,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: { object: r, recipe: null },
        },
      ]),
      dependencies = buildComposePages([]);
    for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
    for (const kind of ['compose', 'sync']) {
      const value =
        kind === 'compose'
          ? {
              schema: 1,
              kind: 'forge-hosted-compose-input',
              base: { head: l.sha256, receiptId: 'main' },
              main: { object: l, recipe: null },
              inputs: inputs.manifest,
              dependencies: dependencies.manifest,
              algorithm: 'forge-native-compose-v1',
              message: 'merge',
              at,
            }
          : {
              schema: 1,
              kind: 'forge-hosted-sync-input',
              algorithm: 'forge-native-sync-v1',
              work: { mode: 'sync', left: { object: l, recipe: null }, right: { object: r, recipe: null } },
              message: 'merge',
              at,
            };
      const id = await s.enqueue(await s.json(value)),
        report = await s.drain(),
        job = await s.job(id);
      assert.equal(job.status, 'completed');
      const result = JSON.parse(await s.bytes(job.output)),
        pin = kind === 'compose' ? result.result.state : result.result.state;
      assert.deepEqual(JSON.parse(await s.bytes(pin)).files, expected);
      assert(report.peakWork > 1);
      t.diagnostic(JSON.stringify({ kind, report }));
    }
  } finally {
    s.restore();
  }
});
test('step count grows linearly with changed bytes rather than retained history', async t => {
  const reports = [];
  for (const count of [1000, 2000]) {
    const s = await scaleFixture();
    try {
      const id = await s.enqueue(await save(s, count)),
        report = await s.drain();
      assert.equal((await s.job(id)).status, 'completed');
      reports.push({ count, ...report });
    } finally {
      s.restore();
    }
  }
  assert(reports[1].steps >= reports[0].steps * 1.5);
  assert(reports[1].steps <= reports[0].steps * 2.4);
  t.diagnostic(JSON.stringify({ linear: reports }));
});
test('a text file edited on both sides merges at the byte and line limits and conflicts one past them', async t => {
  const {
    SOURCE_TEXT_MERGE_MAX_BYTES: maxBytes,
    SOURCE_TEXT_MERGE_MAX_LINES: maxLines,
    SOURCE_TEXT_MERGE_TOO_LARGE,
  } = await import('../dist/hosted-source-merge-journal.js');
  // Same-length edits keep base, left and right the same size, so each case is
  // exactly at or one byte/line past the limit on every side.
  const cases = [
    { name: 'bytes', size: maxBytes, middle: n => Buffer.alloc(n - 13, 120) },
    { name: 'bytes+1', size: maxBytes + 1, middle: n => Buffer.alloc(n - 13, 120) },
    { name: 'lines', size: maxLines, middle: n => Buffer.alloc((n - 2) * 2, 'x\n') },
    { name: 'lines+1', size: maxLines + 1, middle: n => Buffer.alloc((n - 2) * 2, 'x\n') },
  ];
  for (const c of cases) {
    const s = await scaleFixture({ guardRss: true });
    try {
      const middle = c.middle(c.size),
        body = (first, last) =>
          c.name.startsWith('bytes')
            ? Buffer.concat([Buffer.from(`${first}\n`), middle, Buffer.from(`\n${last}\n`)])
            : Buffer.concat([Buffer.from(`${first}\n`), middle, Buffer.from(`${last}\n`)]),
        files = [body('start', 'ended'), body('lefts', 'ended'), body('start', 'right')],
        pins = [];
      for (const b of files) {
        if (c.name.startsWith('bytes')) assert.equal(b.length, c.size);
        else assert.equal(b.toString().split('\n').length - 1, c.size);
        pins.push(await s.putSpec(b));
      }
      const state = (pin, parents = []) =>
        s.json({
          schema: 1,
          kind: 'forge-source-state',
          parents,
          files: [{ path: 'large.txt', mode: 'file', blob: pin.sha256 }],
          message: 'seed',
          at,
        });
      const base = await state(pins[0]),
        left = await state(pins[1], [base.sha256]),
        right = await state(pins[2], [base.sha256]);
      const input = await s.json({
        schema: 1,
        kind: 'forge-hosted-sync-input',
        algorithm: 'forge-native-sync-v1',
        work: { mode: 'sync', left: { object: left, recipe: null }, right: { object: right, recipe: null } },
        message: 'merge',
        at,
      });
      const id = await s.enqueue(input),
        report = await s.drain(),
        job = await s.job(id);
      assert.equal(job.status, 'completed');
      const { result } = JSON.parse(await s.bytes(job.output));
      if (c.name.endsWith('+1')) {
        assert.equal(result.status, 'conflict', c.name);
        const page = JSON.parse(await s.bytes(result.conflicts));
        assert.deepEqual(
          page.paths.map(p => [p.path, p.reason]),
          [['large.txt', SOURCE_TEXT_MERGE_TOO_LARGE]],
        );
      } else {
        const expected = createHash('sha256').update(body('lefts', 'right')).digest('hex');
        assert.equal(JSON.parse(await s.bytes(result.state)).files[0].blob, expected, c.name);
      }
      t.diagnostic(
        JSON.stringify({
          case: c.name,
          status: result.status ?? 'merged',
          maxRssMiB: Math.round(report.maxRssBytes / 1048576),
          steps: report.steps,
          calls: report.calls,
        }),
      );
    } finally {
      s.restore();
    }
  }
});

function simulatedClock() {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  return {
    advance: ms => (offset += ms),
    offset: () => offset,
    restore: () => (Date.now = real),
  };
}
const isAction = item =>
  item.name.startsWith('projectConvexSource:') || item.name.startsWith('projectConvexSourceTask:');
test('a job running far longer than the 60 s lease completes: every step and child completion renews it, with no extra calls', async () => {
  const plain = await scaleFixture({ parallelism: 1 });
  let expected;
  try {
    const id = await plain.enqueue(await save(plain, 200));
    expected = await plain.drain();
    assert.equal((await plain.job(id)).status, 'completed');
  } finally {
    plain.restore();
  }
  const clock = simulatedClock(),
    s = await scaleFixture({ parallelism: 1, afterAction: item => isAction(item) && clock.advance(40000) });
  try {
    const id = await s.enqueue(await save(s, 200)),
      report = await s.drain();
    assert.equal((await s.job(id)).status, 'completed');
    assert(report.steps > 3 && clock.offset() > 120000, `simulated ${clock.offset()} ms`);
    assert.equal(report.calls, expected.calls, 'lease renewal rides on existing progress mutations');
  } finally {
    clock.restore();
    s.restore();
  }
});
test('after a failed step or child and an expired lease, one explicit trigger recovers the same execution once', async t => {
  for (const mode of ['step', 'child', 'fenced']) {
    const clock = simulatedClock(),
      s = await scaleFixture({ parallelism: mode === 'step' ? 4 : 1 });
    try {
      const id = await s.enqueue(await save(s, 200));
      const lastChild = item => {
        if (item.name !== 'projectConvexSourceTask:run' || item.args.generation !== 0) return false;
        const batch = [...s.tables.projectSourceBatches.values()].at(-1);
        return item.args.index === batch.total - 1;
      };
      s.failOnce.push(
        mode === 'step' ? item => item.name === 'projectConvexSource:step' && item.args.step > 0 : lastChild,
      );
      await s.drain({ idle: false });
      let job = await s.job(id);
      assert.equal(job.status, 'running', mode);
      assert.equal(s.failOnce.length, 0, 'the failure was injected');
      // A duplicate reply from an already completed child never extends the lease.
      const finished = [...s.scheduled.values()].find(
        i => i.name === 'projectConvexSourceTask:run' && i.state.kind === 'success',
      );
      await s.execute(finished);
      assert.equal((await s.job(id)).version, job.version, 'stale completion changed nothing');
      clock.advance(61000);
      const row = [...s.tables.projectSourceSteps.values()][0];
      await assert.rejects(
        s.invoke('projectConvexSourceStore:begin', { projectId: s.projectId, jobId: id, step: row.step }),
        e => e.data?.code === 'SOURCE_JOB_FENCED',
        'the dead execution expired',
      );
      if (mode === 'fenced') {
        // Another project's completion drains the pool after expiry.
        await s.invoke('projectConvexSourceFanout:drain', {});
        assert.equal([...s.tables.projectSourceBatches.values()].at(-1).status, 'fenced');
      }
      const trigger = () =>
        s.invoke('projectConvexSourceStore:dispatch', { projectId: s.projectId, jobId: id });
      await trigger();
      const renewed = await s.job(id);
      assert(renewed.control.workerUntil > Date.now(), `${mode}: lease renewed`);
      assert.equal(renewed.executionId, job.executionId);
      const pending = s.ready.length;
      assert(pending >= 1, `${mode}: work resumed`);
      await trigger();
      assert.equal(s.ready.length, pending, `${mode}: a second trigger schedules nothing`);
      const report = await s.drain();
      job = await s.job(id);
      assert.equal(job.status, 'completed', mode);
      assert.equal(job.executionId, renewed.executionId);
      assert.equal(s.tables.projectSourceSteps.size, 1);
      t.diagnostic(JSON.stringify({ mode, calls: report.calls }));
    } finally {
      clock.restore();
      s.restore();
    }
  }
});
