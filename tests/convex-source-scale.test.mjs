// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
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
  item.name.startsWith('projectConvexSource:') ||
  item.name.startsWith('projectConvexSourceNode:') ||
  item.name.startsWith('projectConvexSourceTask:');
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
        mode === 'step'
          ? item => item.name === 'projectConvexSourceNode:step' && item.args.step > 0
          : lastChild,
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

test('4k-file multi-quantum composition shares one Node action and resolves each object window once', async t => {
  const s = await scaleFixture();
  try {
    const blob = await s.putSpec(Buffer.from('original\n'));
    const files = Array.from({ length: 4000 }, (_, i) => ({
      path: `src/${'nested/'.repeat(24)}${String(i).padStart(6, '0')}.txt`,
      mode: 'file',
      blob: blob.sha256,
    }));
    const state = (files, parents = []) =>
      s.json({ schema: 1, kind: 'forge-source-state', parents, files, message: 'seed', at });
    const base = await state(files);
    const a = await s.putSpec(Buffer.from('left\n')),
      b = await s.putSpec(Buffer.from('right\n'));
    const leftFiles = files.map((f, i) => (i === 0 ? { ...f, blob: a.sha256 } : f)),
      rightFiles = files.map((f, i) => (i === 1 ? { ...f, blob: b.sha256 } : f));
    const left = await state(leftFiles, [base.sha256]),
      right = await state(rightFiles, [base.sha256]);
    const inputs = buildComposePages([
        {
          laneId: randomUUID(),
          head: right.sha256,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: { object: right, recipe: null },
        },
      ]),
      dependencies = buildComposePages([]);
    for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
    const input = await s.json({
      schema: 1,
      kind: 'forge-hosted-compose-input',
      base: { head: left.sha256, receiptId: 'main' },
      main: { object: left, recipe: null },
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
      algorithm: 'forge-native-compose-v1',
      message: 'merge',
      at,
    });
    const beforeObjects = new Set(s.objects.keys()),
      beforeCounts = s.counts.length;
    const jobId = await s.enqueue(input),
      report = await s.drain(),
      job = await s.job(jobId);
    assert.equal(job.status, 'completed');
    const result = JSON.parse(await s.bytes(job.output)),
      merged = JSON.parse(await s.bytes(result.result.state));
    assert.deepEqual(
      merged.files,
      files.map((f, i) => (i === 0 ? leftFiles[i] : i === 1 ? rightFiles[i] : f)),
    );
    assert.deepEqual(merged.parents, [left.sha256, right.sha256]);
    assert.deepEqual(result.result.paths, [files[1].path]);
    const nodes = s.calls.filter(name => name === 'projectConvexSourceNode:step').length;
    t.diagnostic(
      JSON.stringify({
        multiQuantum4k: report,
        dbReadBytes: s.counts.slice(beforeCounts).reduce((n, c) => n + c.readBytes, 0),
        dbWriteBytes: s.counts.slice(beforeCounts).reduce((n, c) => n + c.writeBytes, 0),
        r2BytesPut: [...s.objects]
          .filter(([id]) => !beforeObjects.has(id))
          .reduce((n, [, bytes]) => n + (Buffer.isBuffer(bytes) ? bytes.length : bytes.size), 0),
        nodes,
        resolves: s.calls.filter(n => n === 'projectConvexSourceObjects:resolve').length,
      }),
    );
    assert.equal(nodes, 1, 'the >2 MiB graph-to-compute boundary needs a fresh heap, not a fresh action');
    const resolutions = s.events
      .filter(e => e.call === 'projectConvexSourceObjects:resolve' && !e.args.ancestry && !e.args.probe)
      .flatMap(e => e.args.digests);
    assert.equal(
      resolutions.length,
      new Set(resolutions).size,
      'no repeated descriptor resolution across quanta',
    );
    assert.equal(s.readCounts.get(left.sha256), 1, 'verified left manifest is reused across quanta');
    assert.equal(s.readCounts.get(right.sha256), 1, 'verified right manifest is reused across quanta');
  } finally {
    s.restore();
  }
});

for (const count of [12000, 29000])
  test(`cost 298f9675: ${count} files, ten sequential small saves expose source egress and preserve exact file changes`, async t => {
    const s = await scaleFixture();
    try {
      const original = await s.putSpec(Buffer.from('baseline\n'));
      const files = Array.from({ length: count }, (_, i) => ({
        path: `src/${String(i).padStart(6, '0')}.txt`,
        blob: original.sha256,
        mode: 'file',
      }));
      let baseline = await s.putSpec(
        Buffer.from(
          JSON.stringify({
            schema: 1,
            kind: 'forge-source-state',
            files,
            parents: [],
            message: 'base',
            at,
          }),
        ),
        undefined,
        1,
        { parents: [] },
      );
      const samples = [];
      for (let landing = 0; landing < 10; landing++) {
        const changed = await s.putSpec(Buffer.from(`landing-${landing}\n`));
        const pages = buildSavePages([
          {
            path: files[landing].path,
            before: { blob: files[landing].blob, mode: 'file' },
            after: { blob: changed.sha256, mode: 'file', content: { object: changed, recipe: null } },
          },
        ]);
        for (const page of pages.pages) await s.json(page.value);
        const input = await s.json({
          schema: 1,
          kind: 'forge-hosted-save-input',
          baseline: {
            object: baseline,
            recipe: (() => {
              const recipe = [...s.tables.projectObjects.values()].find(
                row => row.digest === baseline.sha256,
              )?.recipe;
              return recipe ? { sha256: recipe.digest, size: recipe.size } : null;
            })(),
          },
          pages: pages.root,
          pageCount: pages.pages.length,
          changeCount: 1,
          message: `landing-${landing}`,
          at,
        });
        const offset = s.events.length;
        const id = await s.enqueue(input),
          report = await s.drain();
        const job = await s.job(id);
        assert.equal(job.status, 'completed');
        const result = JSON.parse(await s.bytes(job.output));
        const state = JSON.parse(await s.bytes(result.state));
        files[landing] = { ...files[landing], blob: changed.sha256 };
        assert.deepEqual(state.files, files);
        assert.deepEqual(state.parents, [baseline.sha256]);
        assert.equal(digest(await s.bytes(result.state)), result.state.sha256);
        const stored = [...s.tables.projectObjects.values()].find(row => row.digest === result.state.sha256);
        assert.equal(stored.stateGeneration, landing + 2);
        assert.deepEqual(stored.stateParents, [baseline.sha256]);
        assert(
          stored.recipeClosure?.some(leaf => leaf.pack),
          'unchanged files reuse committed R2 ranges',
        );
        baseline = result.state;
        samples.push({
          ...report,
          egress: s.events.slice(offset).reduce((n, e) => n + (e.put ?? 0), 0),
          refusedBytes: s.events.slice(offset).reduce((n, e) => n + (e.existed ? e.put : 0), 0),
        });
      }
      // CPU covers the handler; diagnostics separately retain cold module-import CPU.
      // Comparing the first cold fork with later forks flaked on the Linux runner.
      t.diagnostic(JSON.stringify({ sequentialSourceCost: samples }));
      assert(
        samples.every(sample => sample.calls <= 6),
        'sequential save Convex-call ratchet',
      );
      assert(
        samples.every(sample => sample.egress <= (count === 12000 ? 750000 : 750500)),
        'sequential save body-byte ratchet',
      );
      assert(
        samples.every(sample => sample.workCpuMicros > 0 && sample.workCpuMicros <= 1400000),
        'each sequential save stays within the source handler CPU-work budget',
      );
      assert(
        samples.every(sample => sample.maxRssBytes <= (count === 12000 ? 185 : 256) * 1024 * 1024),
        'sequential save memory ratchet',
      );
      assert.equal(s.ready.length, 0, 'finished sequential saves create no idle work');
    } finally {
      s.restore();
    }
  });

test('cost 298f9675: 29k-file compose and sync consume projected States with exact ancestry and bounded work', async t => {
  const s = await scaleFixture();
  try {
    const blob = await s.putSpec(Buffer.from('base\n'));
    const files = Array.from({ length: 29000 }, (_, i) => ({
      path: `src/${String(i).padStart(6, '0')}.txt`,
      blob: blob.sha256,
      mode: 'file',
    }));
    const state = (files, parents, generation) =>
      s.putSpec(
        Buffer.from(
          JSON.stringify({ schema: 1, kind: 'forge-source-state', parents, files, message: 'branch', at }),
        ),
        undefined,
        generation,
        { parents },
      );
    const ref = pin => {
      const recipe = [...s.tables.projectObjects.values()].find(row => row.digest === pin.sha256)?.recipe;
      return { object: pin, recipe: recipe ? { sha256: recipe.digest, size: recipe.size } : null };
    };
    const base = await state(files, [], 1),
      l = await s.putSpec(Buffer.from('left\n')),
      r = await s.putSpec(Buffer.from('right\n'));
    const expected = files.map((file, i) => (i === 0 ? { ...file, blob: l.sha256 } : file));
    let left = await state(expected, [base.sha256], 2),
      rightFiles = files.map((file, i) => (i === 1 ? { ...file, blob: r.sha256 } : file)),
      right = await state(rightFiles, [base.sha256], 2);
    expected[1] = rightFiles[1];
    for (const kind of ['compose', 'sync']) {
      const inputs = buildComposePages([
          {
            laneId: randomUUID(),
            head: right.sha256,
            version: 0,
            sourceVersion: 0,
            lifecycleVersion: 0,
            state: ref(right),
          },
        ]),
        dependencies = buildComposePages([]);
      for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
      const value =
        kind === 'compose'
          ? {
              schema: 1,
              kind: 'forge-hosted-compose-input',
              base: { head: left.sha256, receiptId: 'main' },
              main: ref(left),
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
              work: { mode: 'sync', left: ref(left), right: ref(right) },
              message: 'merge',
              at,
            };
      const input = await s.json(value),
        offset = s.events.length,
        id = await s.enqueue(input),
        report = await s.drain(),
        job = await s.job(id);
      assert.equal(job.status, 'completed');
      const result = JSON.parse(await s.bytes(job.output)),
        pin = result.result.state,
        bytes = await s.bytes(pin),
        merged = JSON.parse(bytes),
        stored = [...s.tables.projectObjects.values()].find(row => row.digest === pin.sha256),
        egress = s.events.slice(offset).reduce((n, event) => n + (event.put ?? 0), 0);
      assert.equal(digest(bytes), pin.sha256);
      assert.deepEqual(merged.files, expected);
      assert.deepEqual(merged.parents, [left.sha256, right.sha256]);
      assert.deepEqual(stored.stateParents, merged.parents);
      assert.equal(stored.stateGeneration, kind === 'compose' ? 3 : 4);
      assert(stored.recipeClosure?.some(leaf => leaf.pack));
      t.diagnostic(JSON.stringify({ projectedMergeCost: { kind, egress, ...report } }));
      assert(egress <= 751000, 'merge State uploads contain changed chunks and bounded metadata');
      assert(
        report.calls <= (kind === 'compose' ? 8 : 6),
        'source metadata stays batched across bounded quanta',
      );
      assert(report.maxRssBytes <= 400 * 1024 * 1024);
      if (kind === 'compose') {
        left = pin;
        const next = await s.putSpec(Buffer.from('next\n'));
        rightFiles = rightFiles.map((file, i) => (i === 2 ? { ...file, blob: next.sha256 } : file));
        right = await state(rightFiles, [right.sha256], 3);
        expected[2] = rightFiles[2];
        assert(ref(left).recipe, 'sync reads the recipe the compose worker actually published');
      }
    }
    assert.equal(s.ready.length, 0);
  } finally {
    s.restore();
  }
});
