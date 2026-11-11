// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { parseNativeState } from '../dist/state/format.js';
import { reviewPaths } from '../dist/source-review-format.js';
import { saveBytes } from '../dist/hosted-save.js';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const views = await import(moduleUrl('../convex/projectViewReads.ts'));
const downloads = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
const { canonicalViewFiles } = await import(moduleUrl('../web/src/views/canonical-source.ts'));

async function seed(count) {
  const c = await composeFixture({
    baselineFiles: Array.from({ length: count - 2 }, (_, i) => [
      `src/${String(i).padStart(6, '0')}.ts`,
      'same\n',
    ]),
  });
  const before = parseNativeState(c.objects.get(c.baseline.sha256));
  const changed = c.file(before.files[2].path, 'changed\n');
  const after = c.state(
    before.files.map((f, i) => (i === 2 ? changed : f)),
    [c.baseline.sha256],
  );
  const lane = await c.lane(after);
  const selected = c.selection([lane]);
  await c.prepare(selected);
  await c.stage(selected);
  await c.submit(selected);
  const candidate = (await c.publish(await c.work(selected))).outcome.result;
  const listing = c.put(
    saveBytes({
      schema: 1,
      kind: 'forge-candidate-files',
      inputs: [{ laneId: lane.laneId, head: lane.head }],
      dependencies: [],
      base: candidate.base.head,
      head: candidate.result.head,
      files: reviewPaths(before.files, parseNativeState(c.objects.get(candidate.result.head)).files).filter(
        f => f.status !== 'unchanged',
      ),
    }),
  );
  const row = [...c.tables.projectHostedRecords.values()].find(
    r => r.kind === 'candidate' && r.key === candidate.id,
  );
  c.patch('projectHostedRecords', row._id, { candidateFiles: listing });
  const model = JSON.parse(
    await c.transaction('fixtureCanonicalRead', views.read, {
      projectId: c.projectId,
      action: 'view',
      viewId: candidate.id,
      features: ['candidate-source-files'],
      paginationOpts: { cursor: null, numItems: 30 },
    }),
  );
  const hydrated = await canonicalViewFiles(
    model,
    { paginationOpts: { cursor: null, numItems: 30 } },
    async pins => pins.map(pin => c.objects.get(pin.sha256)),
  );
  const backupId = c.insert('projectBackups', {
    projectId: c.projectId,
    operationId: 'synthetic-backup',
    request: 'synthetic',
    nonce: 'synthetic',
    previous: null,
    digest: c.baseline.sha256,
    size: c.baseline.size,
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
    work: { backupId, generationId, revision: 0, initialRevision: 0, operationId: 'synthetic' },
  });
  const legacyId = `legacy-${candidate.id}`;
  const put = (collection, key, parent, value) =>
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
  put('viewDetails', legacyId, candidate.intentId, {
    ...hydrated,
    viewId: legacyId,
    fileCount: 1,
    provenanceAvailable: true,
  });
  put('viewFiles', `${legacyId}:${changed.path}`, legacyId, hydrated.files.items[0]);
  put('intents', candidate.intentId, '', { id: candidate.intentId, outcome: hydrated.why.outcome });
  // Today's best legacy path already has saved diffstats; do not inflate its
  // baseline with optional computation that does not block file visibility.
  put('diffstats', `${candidate.base.head}:${candidate.result.head}`, '', {
    files: 1,
    add: 1,
    del: 1,
    exact: true,
    provenance: 'server-computed',
  });
  for (const file of [hydrated.files.items[0].before, hydrated.files.items[0].after])
    if (file) put('sourceBlobs', file.blob, '', { sha256: file.blob, size: c.objects.get(file.blob).length });
  return { ...c, candidateId: candidate.id, legacyId, path: changed.path, listingBytes: listing.size };
}

/** Real HTTP transport, actual metadata/descriptor handlers, synthetic object
 * store and authority. No provider calls, credentials, artificial latency or sleeps. */
export async function candidatePageServer() {
  const fixtures = new Map();
  const output = await mkdtemp(join(tmpdir(), 'forge-candidate-page-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    envDir: false,
    build: {
      outDir: output,
      emptyOutDir: true,
      minify: true,
      rollupOptions: {
        input: resolve(root, 'tests/candidate-page-browser.tsx'),
        output: { entryFileNames: 'entry.js', assetFileNames: '[name][extname]' },
      },
    },
  });
  const counts = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/rpc') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { count, name, args } = JSON.parse(Buffer.concat(chunks));
        const c = fixtures.get(count);
        const fn = {
          'projectViewReads:read': views.read,
          'projectObjectDownloads:describe': downloads.describe,
          'projectObjectDownloads:signDownloads': downloads.signDownloads,
        }[name];
        if (!fn) throw new Error(`Unexpected RPC ${name}`);
        const value = await c.transaction(name, fn, args);
        counts.push({ count, name, ...c.counts.at(-1) });
        response.setHeader('content-type', 'application/json');
        return response.end(JSON.stringify(value));
      }
      if (url.pathname === '/fixture') {
        const c = fixtures.get(Number(url.searchParams.get('count')));
        response.setHeader('content-type', 'application/json');
        return response.end(
          JSON.stringify({
            projectId: c.projectId,
            candidateId: c.candidateId,
            legacyId: c.legacyId,
            path: c.path,
            listingBytes: c.listingBytes,
          }),
        );
      }
      if (url.pathname.startsWith('/synthetic/v1/p/')) {
        const digest = url.pathname.split('/').at(-1);
        const bytes = [...fixtures.values()].map(c => c.objects.get(digest)).find(Boolean);
        if (!bytes || !url.searchParams.has('X-Amz-Signature')) throw new Error('Unknown synthetic object');
        response.setHeader('content-type', 'application/octet-stream');
        response.setHeader('content-length', bytes.length);
        return response.end(bytes);
      }
      if (url.pathname === '/') {
        response.setHeader('content-type', 'text/html');
        return response.end(
          '<!doctype html><html><head><title>Candidate page fixture</title>' +
            '<link rel="stylesheet" href="/candidate-page-browser.css"></head><body>' +
            '<button id="measure">Measure 11 pairs</button><output id="measurement"></output>' +
            '<div class="fx" id="root"></div><script type="module" src="/entry.js"></script></body></html>',
        );
      }
      const path = url.pathname.slice(1);
      if (!/^(?:assets\/)?[\w.-]+$/.test(path)) throw new Error('Unknown asset');
      response.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(await readFile(join(output, path)));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const settings = {
    R2_ENDPOINT: origin,
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  };
  const previous = new Map(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const close = async () => {
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(output, { recursive: true, force: true });
  };
  try {
    for (const count of [4000, 29000]) fixtures.set(count, await seed(count));
  } catch (error) {
    await close();
    throw error;
  }
  return { origin, fixtures, counts, close };
}
