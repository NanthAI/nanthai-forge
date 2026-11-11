// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { parseNativeState } from '../dist/state/format.js';
import { reviewPaths } from '../dist/source-review-format.js';
import { saveBytes } from '../dist/hosted-save.js';
import { candidateFileListSchema } from '../dist/hosted-compose.js';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
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
    assert.equal(withoutGeneration, 'WORK_STALE');
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
    assert.equal(withGeneration, 'NOT_FOUND');
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
    seed('viewDetails', candidate.id, candidate.intentId, {
      ...legacyModel,
      inputs: result.inputs,
      fileCount: 1,
      provenanceAvailable: true,
    });
    seed('viewFiles', candidate.id + ':' + changed.path, candidate.id, {
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
    for (let i = 0; i < 9; i++) {
      let start = performance.now();
      const legacy = JSON.parse(await query());
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
        legacyQueryMedianMs: legacySamples[3],
        compactProjectionAndDecodeMedianMs: compactSamples[3],
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
