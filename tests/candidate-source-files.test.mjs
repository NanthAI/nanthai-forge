// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapInterval } from '../scripts/bootstrap-interval.mjs';
import { performance } from 'node:perf_hooks';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { parseNativeState } from '../dist/state/format.js';
import { reviewPaths } from '../dist/source-review-format.js';
import { saveBytes } from '../dist/hosted-save.js';
import { candidateFileListSchema } from '../dist/hosted-compose.js';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
import { runSmallSourceCompose } from '../dist/hosted-source-small-compose.js';
import { initialSourceStep, runSourceStep } from '../dist/hosted-source-step.js';
const views = await import(moduleUrl('../convex/projectViewReads.ts'));
const { canonicalViewFiles } = await import(moduleUrl('../web/src/views/canonical-source.ts'));
const compose = await import(moduleUrl('../convex/projectHostedCompose.ts'));
for (const count of [4000, 29000]) {
  test(`canonical ${count}-file Candidate is readable without legacy projections, while forged bytes and foreign access refuse`, async () => {
    const c = await composeFixture({
      baselineFiles: Array.from({ length: count - 2 }, (_, i) => [
        `src/${String(i).padStart(6, '0')}.ts`,
        'same\n',
      ]),
    });
    const aBytes = c.objects.get(c.baseline.sha256);
    const files = parseNativeState(aBytes).files;
    const changed = c.file(files[2].path, 'changed\n');
    const head = c.state(
      files.map((f, i) => (i === 2 ? changed : f)),
      [c.baseline.sha256],
    );
    const lane = await c.lane(head);
    const selected = c.selection([lane]);
    await c.prepare(selected);
    await c.stage(selected);
    await c.submit(selected);
    const published = await c.publish(await c.work(selected));
    const candidate = published.outcome.result;
    assert.equal(candidate.result.status, 'clean');
    const canonical = await c.call('candidateRead', compose.candidate, {
      projectId: c.projectId,
      candidateId: candidate.id,
    });
    assert.equal(JSON.parse(canonical).id, candidate.id);
    const canonicalComposeDataRows = c.tables.projectWorkDataRecords.size;
    assert.equal(canonicalComposeDataRows, 0);
    const capable = await c.transaction('canonicalWebRead', views.read, {
      projectId: c.projectId,
      action: 'view',
      viewId: candidate.id,
      features: ['candidate-source-files'],
      paginationOpts: { cursor: null, numItems: 30 },
    });
    const model = JSON.parse(capable);
    const result = await canonicalViewFiles(
      model,
      { paginationOpts: { cursor: null, numItems: 30 } },
      async pins => pins.map(pin => c.objects.get(pin.sha256)),
    );
    assert.equal(result.files.total, 1);
    assert.equal(result.files.items[0].path, changed.path);
    assert.equal(result.files.items[0].status, 'modified');
    assert.equal(result.inputs[0].laneId, lane.laneId);
    // A trusted source-only listing replaces whole-State reads after writer rollout.
    const listing = candidateFileListSchema.parse({
      schema: 1,
      kind: 'forge-candidate-files',
      inputs: result.inputs.map(({ laneId, head }) => ({ laneId, head })),
      dependencies: result.dependencies.map(({ viewId: candidateId, head }) => ({ candidateId, head })),
      base: candidate.base.head,
      head: candidate.result.head,
      files: reviewPaths(files, parseNativeState(c.objects.get(candidate.result.head)).files).filter(
        f => f.status !== 'unchanged',
      ),
    });
    const listingPin = c.put(saveBytes(listing));
    const record = [...c.tables.projectHostedRecords.values()].find(
      r => r.kind === 'candidate' && r.key === candidate.id,
    );
    c.patch('projectHostedRecords', record._id, { candidateFiles: listingPin });
    const compactModel = JSON.parse(
      await c.transaction('canonicalCompactRead', views.read, {
        projectId: c.projectId,
        action: 'view',
        viewId: candidate.id,
        features: ['candidate-source-files'],
        paginationOpts: { cursor: null, numItems: 30 },
      }),
    );
    let listingReadBytes = 0;
    const compact = await canonicalViewFiles(
      compactModel,
      { paginationOpts: { cursor: null, numItems: 30 } },
      async pins => {
        assert(
          pins.every(pin => pin.sha256 !== candidate.base.head && pin.sha256 !== candidate.result.head),
          'file-list path never reads full States',
        );
        listingReadBytes += pins.reduce((n, p) => n + p.size, 0);
        return pins.map(pin => c.objects.get(pin.sha256));
      },
    );
    assert.deepEqual(compact, result);
    assert(
      listingReadBytes < 2048,
      'one changed file plus exact input metadata stays under 2 KiB at either repository size',
    );
    await assert.rejects(
      canonicalViewFiles(
        compactModel,
        {
          paginationOpts: {
            cursor:
              'candidate-files-v1:' +
              JSON.stringify({
                viewId: candidate.id,
                base: '0'.repeat(64),
                head: candidate.result.head,
                offset: 0,
              }),
            numItems: 30,
          },
        },
        async pins => pins.map(pin => c.objects.get(pin.sha256)),
      ),
      e => e.code === 'BAD_ARGUMENT',
    );

    await assert.rejects(
      c.transaction(
        'deniedCanonicalRead',
        views.read,
        {
          projectId: c.projectId,
          action: 'view',
          viewId: candidate.id,
          features: ['candidate-source-files'],
          paginationOpts: { cursor: null, numItems: 30 },
        },
        'stranger',
      ),
      e => e.data?.code === 'PROJECT_UNAVAILABLE',
    );
    await assert.rejects(
      canonicalViewFiles(model, { paginationOpts: { cursor: null, numItems: 30 } }, async pins =>
        pins.map(pin => Buffer.alloc(pin.size)),
      ),
      e => e.code === 'SOURCE_HASH_MISMATCH',
    );
    const query = () =>
      c.transaction('webCandidateRead', views.read, {
        projectId: c.projectId,
        action: 'view',
        viewId: candidate.id,
        paginationOpts: { cursor: null, numItems: 30 },
      });
    let withoutGeneration;
    try {
      await query();
      assert.fail('expected missing legacy generation');
    } catch (e) {
      withoutGeneration = e.data?.code ?? e.code;
    }
    assert.equal(withoutGeneration, 'CLI_UPGRADE_REQUIRED');
    const backupId = c.insert('projectBackups', {
      projectId: c.projectId,
      operationId: 'synthetic-backup',
      request: 'synthetic',
      nonce: 'synthetic',
      previous: null,
      digest: c.baseline.sha256,
      size: aBytes.length,
      status: 'stored',
      transport: 'objects',
      preview: {
        format: 'native',
        head: c.baseline.sha256,
        manifestDigest: c.baseline.sha256,
        revision: 0,
        intents: 1,
        lanes: 1,
        views: 1,
        runs: 0,
        files: count,
        unavailable: 0,
        channels: [{ name: 'main', head: c.baseline.sha256 }],
      },
    });
    const generationId = c.insert('projectWorkGenerations', {
      projectId: c.projectId,
      backupId,
      revision: 0,
      initialRevision: 0,
      format: HOSTED_WORK_INDEX_FORMAT,
      status: 'ready',
      nextBatch: 0,
      metadata: JSON.stringify({ counts: {} }),
    });
    c.patch('hostedProjects', c.projectId, {
      work: { backupId, generationId, revision: 0, initialRevision: 0, operationId: 'synthetic-operation' },
    });
    let withGeneration;
    try {
      await query();
      assert.fail('expected absent legacy view projection');
    } catch (e) {
      withGeneration = e.data?.code ?? e.code;
    }
    assert.equal(withGeneration, 'CLI_UPGRADE_REQUIRED');
    const seed = (collection, key, parent, value) =>
      c.insert(
        collection === 'viewFiles' || collection.startsWith('source')
          ? 'projectWorkDataRecords'
          : 'projectWorkRecords',
        {
          projectId: c.projectId,
          generationId,
          collection,
          key,
          parent,
          position: 0,
          value: JSON.stringify(value),
        },
      );
    const { canonicalSource: _source, ...legacyModel } = model;
    const legacyId = 'legacy-' + candidate.id;
    seed('viewDetails', legacyId, candidate.intentId, {
      ...legacyModel,
      viewId: legacyId,
      inputs: result.inputs,
      fileCount: 1,
      provenanceAvailable: true,
    });
    seed('viewFiles', legacyId + ':' + changed.path, legacyId, {
      ...listing.files[0],
      contributors: [],
      historyComplete: false,
    });
    seed('intents', candidate.intentId, '', { id: candidate.intentId, outcome: model.why.outcome });
    for (const file of [listing.files[0].before, listing.files[0].after])
      if (file)
        seed('sourceBlobs', file.blob, '', { sha256: file.blob, size: c.objects.get(file.blob).length });
    // Diagnostic only: in-process query + codec, excluding descriptor RPCs and network latency.
    const legacySamples = [],
      compactSamples = [];
    for (let i = 0; i < 13; i++) {
      let start = performance.now();
      const legacy = JSON.parse(
        await c.transaction('legacyBaseline', views.read, {
          projectId: c.projectId,
          action: 'view',
          viewId: legacyId,
          paginationOpts: { cursor: null, numItems: 30 },
        }),
      );
      assert.equal(legacy.files.items[0].path, changed.path);
      if (i > 1) legacySamples.push(performance.now() - start);
      start = performance.now();
      const current = JSON.parse(
        await c.transaction('timedCanonicalRead', views.read, {
          projectId: c.projectId,
          action: 'view',
          viewId: candidate.id,
          features: ['candidate-source-files'],
          paginationOpts: { cursor: null, numItems: 30 },
        }),
      );
      await canonicalViewFiles(current, { paginationOpts: { cursor: null, numItems: 30 } }, async pins =>
        pins.map(pin => c.objects.get(pin.sha256)),
      );
      if (i > 1) compactSamples.push(performance.now() - start);
    }
    const pairs = legacySamples.map((a, index) => [a, compactSamples[index]]);
    const interval = bootstrapInterval(pairs);
    legacySamples.sort((a, b) => a - b);
    compactSamples.sort((a, b) => a - b);

    const bBytes = c.objects.get(candidate.result.head);
    const samples = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const changes = reviewPaths(parseNativeState(aBytes).files, parseNativeState(bBytes).files).filter(
        f => f.status !== 'unchanged',
      );
      assert.equal(changes.length, 1);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        count,
        changed: 1,
        baseBytes: aBytes.length,
        headBytes: bBytes.length,
        manifestBytes: aBytes.length + bBytes.length,
        canonicalCandidate: candidate.id,
        canonicalReadable: true,
        canonicalComposeDataRows,
        webWithoutGeneration: withoutGeneration,
        webWithGeneration: withGeneration,
        manifestDiffMedianMs: samples[3],
        listingReadBytes,
        legacyQueryMedianMs: legacySamples[5],
        compactProjectionAndDecodeMedianMs: compactSamples[5],
        queryCodecTiming: { pairs, ...interval },
        rssKiB: process.memoryUsage().rss / 1024,
        maxRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  });
}

test('Candidate file bytes refuse access revoked during IO and on an immutable cache hit', async () => {
  const { ObjectDownloadReader } = await import('../dist/blob-download.js');
  const { digest } = await import('../dist/hash.js');
  const { ForgeError } = await import('../dist/errors.js');
  const { randomUUID } = await import('node:crypto');
  const base = '0'.repeat(64),
    head = '1'.repeat(64);
  const value = {
    schema: 1,
    kind: 'forge-candidate-files',
    base,
    head,
    inputs: [],
    dependencies: [],
    files: [
      { path: 'a.ts', status: 'added', before: null, after: { path: 'a.ts', blob: head, mode: 'file' } },
    ],
  };
  const bytes = saveBytes(value),
    pin = { sha256: digest(bytes), size: bytes.length };
  const id = randomUUID(),
    intentId = randomUUID();
  const candidate = {
    kind: 'candidate',
    id,
    intentId,
    version: 0,
    at: '2026-01-01T00:00:00.000Z',
    base: { head: base, receiptId: 'main-0' },
    inputs: pin,
    dependencies: pin,
    algorithm: 'synthetic',
    result: { status: 'clean', head },
  };
  const model = {
    viewId: id,
    why: { intentId, outcome: 'Synthetic' },
    files: { items: [], total: 0, nextCursor: null },
    canonicalSource: { protocol: 1, candidate, pins: [], files: pin },
  };
  let allowed = true,
    revoke = true,
    gets = 0;
  const reader = new ObjectDownloadReader({
    describe: async ids => {
      if (!allowed) throw new ForgeError('PROJECT_UNAVAILABLE', 'Project unavailable');
      return ids.map(digest => ({
        digest,
        size: pin.size,
        location: 'r2',
        url: 'https://fixture.invalid/list',
      }));
    },
    sign: async () => [],
    fetch: async () => {
      gets++;
      if (revoke) allowed = false;
      return new Response(bytes);
    },
  });
  const read = () =>
    canonicalViewFiles(model, { paginationOpts: { cursor: null, numItems: 30 } }, pins => reader.read(pins));
  await assert.rejects(read(), e => e.code === 'PROJECT_UNAVAILABLE');
  allowed = true;
  revoke = false;
  assert.equal((await read()).files.total, 1);
  const warmGets = gets;
  allowed = false;
  await assert.rejects(read(), e => e.code === 'PROJECT_UNAVAILABLE');
  assert.equal(gets, warmGets, 'a cached object does not bypass current authority');
});

for (const count of [4000, 29000]) {
  test(`source-built ${count}-file Candidate pins one listing, survives stepped execution, and changes no client call count`, async t => {
    const c = await composeFixture({
      baselineFiles: Array.from({ length: count - 2 }, (_, i) => [
        `src/${String(i).padStart(6, '0')}.ts`,
        'same\n',
      ]),
    });
    const before = parseNativeState(c.objects.get(c.baseline.sha256)).files;
    const changed = c.file(before[2].path, 'changed\n');
    const head = c.state(
      before.map((f, i) => (i === 2 ? changed : f)),
      [c.baseline.sha256],
    );
    const lane = await c.lane(head);
    const measurements = [];
    for (const enabled of [false, true]) {
      const selected = c.selection([lane]);
      const prior = process.env.FORGE_CANDIDATE_FILES;
      if (enabled) process.env.FORGE_CANDIDATE_FILES = '1';
      else delete process.env.FORGE_CANDIDATE_FILES;
      const start = c.counts.length;
      try {
        await c.prepare(selected);
      } finally {
        if (prior === undefined) delete process.env.FORGE_CANDIDATE_FILES;
        else process.env.FORGE_CANDIDATE_FILES = prior;
      }
      await c.stage(selected);
      const plan = (await c.progress(selected)).input;
      assert.equal(plan.candidateFiles, enabled ? true : undefined, 'flag is captured before retries');
      await c.submit(selected);
      const objectStart = new Set(c.objects.keys());
      const work = await c.work(selected);
      const published = await c.publish(work);
      const calls = c.counts.slice(start).map(row => row.name);
      const candidate = published.outcome.result;
      const row = [...c.tables.projectHostedRecords.values()].find(
        row => row.key === candidate.id && row.kind === 'candidate',
      );
      assert.equal(Boolean(row.candidateFiles), enabled);
      assert.equal(c.tables.projectWorkDataRecords.size, 0);
      assert.deepEqual(await c.publish(work), published, 'publication replay keeps the original pointer');
      const created = [...c.objects].filter(([id]) => !objectStart.has(id));
      const listings = created.filter(([, bytes]) => {
        try {
          return JSON.parse(bytes).kind === 'forge-candidate-files';
        } catch {
          return false;
        }
      });
      assert.equal(listings.length, enabled ? 1 : 0, 'only one extra source listing is written');
      measurements.push({ enabled, calls, objects: created.length });
      if (!enabled) continue;
      const listing = candidateFileListSchema.parse(JSON.parse(c.objects.get(row.candidateFiles.sha256)));
      assert.deepEqual(
        listing.files,
        reviewPaths(before, parseNativeState(c.objects.get(head.sha256)).files).filter(
          f => f.status !== 'unchanged',
        ),
      );
      assert.deepEqual(listing.inputs, [{ laneId: lane.laneId, head: head.sha256 }]);
      assert.deepEqual(listing.dependencies, []);
      const model = JSON.parse(
        await c.transaction('pinnedView', views.read, {
          projectId: c.projectId,
          action: 'view',
          viewId: candidate.id,
          features: ['candidate-source-files'],
          paginationOpts: { cursor: null, numItems: 30 },
        }),
      );
      let readBytes = 0;
      const page = await canonicalViewFiles(
        model,
        { paginationOpts: { cursor: null, numItems: 30 } },
        async pins => {
          assert(pins.every(pin => pin.sha256 === row.candidateFiles.sha256));
          readBytes += pins.reduce((sum, pin) => sum + pin.size, 0);
          return pins.map(pin => c.objects.get(pin.sha256));
        },
      );
      assert.equal(page.files.total, 1);
      assert(readBytes < 2048, 'page bytes depend on changed files, not repository file count');
      // The Convex provider uses durable cursors rather than the fixed worker. Read only
      // committed objects and round-trip every continuation through its schema.
      const { parseSourceCursor } = await import('../dist/hosted-source-cursor-schema.js');
      const input = c.put(saveBytes(plan));
      let cursor = initialSourceStep(input),
        steps = 0;
      const uploaded = new Map();
      const io = {
        async describeBatch(ids) {
          return ids.map(id => ({ object: { sha256: id, size: c.objects.get(id).length }, recipe: null }));
        },
        async read(pin) {
          return [c.objects.get(pin.sha256)];
        },
        async upload(pin, stream) {
          const parts = [];
          for await (const part of stream) parts.push(part);
          const bytes = Buffer.concat(parts);
          assert.deepEqual(c.put(bytes), pin);
          uploaded.set(pin.sha256, bytes);
        },
      };
      while (cursor.phase !== 'done') {
        assert(++steps < 50, 'bounded source continuations');
        cursor = parseSourceCursor(JSON.parse(JSON.stringify((await runSourceStep(cursor, io)).cursor)));
      }
      const stepped = JSON.parse(c.objects.get(cursor.output.sha256));
      assert.deepEqual(
        stepped.result.candidateFiles,
        row.candidateFiles,
        'fast-forward and fixed worker derive the same bytes',
      );
      assert.equal(
        [...uploaded.values()].filter(bytes => {
          try {
            return JSON.parse(bytes).kind === 'forge-candidate-files';
          } catch {
            return false;
          }
        }).length,
        1,
      );
      const small = await runSmallSourceCompose(input, io);
      if (count === 4000) {
        assert(small, '4k fast path stays eligible');
        assert.deepEqual(JSON.parse(c.objects.get(small.sha256)).result.candidateFiles, row.candidateFiles);
      } else assert.equal(small, null, '29k retains the stepped provider');
      t.diagnostic(
        JSON.stringify({
          count,
          listingReadBytes: readBytes,
          steppedSourceActions: steps,
          canonicalDataRows: c.tables.projectWorkDataRecords.size,
        }),
      );
    }
    assert.deepEqual(
      measurements[1].calls,
      measurements[0].calls,
      'same registered control calls with the setting on',
    );
    assert.equal(measurements[1].objects, measurements[0].objects + 1, 'exactly one additional R2 object');
  });
}

test('an unchanged Lane publishes an exact empty listing in both source execution paths', async () => {
  const c = await composeFixture();
  const selected = c.selection([await c.lane(c.baseline)]);
  const prior = process.env.FORGE_CANDIDATE_FILES;
  process.env.FORGE_CANDIDATE_FILES = '1';
  try {
    await c.prepare(selected);
  } finally {
    if (prior === undefined) delete process.env.FORGE_CANDIDATE_FILES;
    else process.env.FORGE_CANDIDATE_FILES = prior;
  }
  await c.stage(selected);
  await c.submit(selected);
  const work = await c.work(selected);
  const raw = JSON.parse(work.manifest);
  const plan = (await c.progress(selected)).input;
  const input = c.put(saveBytes(plan));
  let cursor = initialSourceStep(input),
    steps = 0;
  while (cursor.phase !== 'done') {
    assert(++steps < 20);
    cursor = (
      await runSourceStep(cursor, {
        async describeBatch(ids) {
          return ids.map(id => ({ object: { sha256: id, size: c.objects.get(id).length }, recipe: null }));
        },
        async read(pin) {
          return [c.objects.get(pin.sha256)];
        },
        async upload(pin, stream) {
          const parts = [];
          for await (const part of stream) parts.push(part);
          assert.deepEqual(c.put(Buffer.concat(parts)), pin);
        },
      })
    ).cursor;
  }
  const stepped = JSON.parse(c.objects.get(cursor.output.sha256));
  assert.deepEqual(stepped.result.candidateFiles, raw.result.candidateFiles);
  const listing = JSON.parse(c.objects.get(stepped.result.candidateFiles.sha256));
  assert.equal(listing.base, listing.head);
  assert.deepEqual(listing.files, []);
});
