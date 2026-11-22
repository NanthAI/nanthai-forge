// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getFunctionName } from 'convex/server';
import { ImportedPins, ListingPageWriter } from '../dist/github-listing-codec.js';
import { ImportRequestMeter } from '../dist/github-import-meter.js';
import { defaultR2Config } from './default-r2.mjs';

const [mode, count, directory, action] = process.argv.slice(2);
const files = Number(count);
const tree = 'a'.repeat(40),
  commit = 'b'.repeat(40),
  at = '2026-01-01T00:00:00.000Z';
const totalBytes = Math.round((files * 3_670_345_292) / 487_756);
const sizeOf = i => Math.floor(totalBytes / files) + Number(i < totalBytes % files);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = row => digest(String(row));
const pathOf = row => {
  const prefix = 'dir/' + String(row).padStart(8, '0') + '/';
  const detail = row % 211 === 0 ? '文' : 'abc';
  return prefix + detail + 'x'.repeat((row % 20 < 13 ? 78 : 77) - prefix.length - 3);
};
const metadataPath = join(directory, 'inputs.json');

if (mode === 'prepare') {
  const save = async bytes => {
    const sha256 = digest(bytes);
    writeFileSync(join(directory, sha256), bytes);
    return { sha256, size: bytes.length };
  };
  const writer = new ListingPageWriter(save);
  const pins = new ImportedPins(files);
  const expectedState = createHash('sha256');
  expectedState.update('{"schema":1,"kind":"forge-source-state","parents":[],"files":[');
  for (let row = 0; row < files; row++) {
    const path = pathOf(row),
      content = blob(row),
      size = sizeOf(row);
    const pending = writer.append({ path, sha: row.toString(16).padStart(40, '0'), size, mode: '100644' });
    if (pending) await pending;
    pins.set(row, content, size);
    if (row) expectedState.update(',');
    expectedState.update(JSON.stringify({ path, blob: content, mode: 'file' }));
  }
  expectedState.update(`],"message":"Imported GitHub commit ${commit}","at":"${at}"}`);
  const index = await writer.finish(tree, { files, totalBytes, submodules: 0 });
  const listing = await save(Buffer.from(JSON.stringify(index)));
  const progress = await save(pins.encode(tree, listing.sha256, Buffer.alloc(16)));
  writeFileSync(
    metadataPath,
    JSON.stringify({
      listing,
      progress,
      pages: index.pages.length,
      expectedState: expectedState.digest('hex'),
    }),
  );
} else {
  const { runArchiveImport } = await import(action);
  const { listing, progress, pages, expectedState } = JSON.parse(readFileSync(metadataPath));
  const job = {
    _id: 'fixture-import',
    owner: 'fixture-owner',
    projectId: 'fixture-project',
    operationId: '00000000-0000-4000-8000-000000000001',
    at,
    repository: 'fixture/large',
    visibility: 'public',
    commit,
    protocol: 3,
    step: 5,
    completed: files,
    total: files,
    totalKnown: true,
    bytes: totalBytes,
    totalBytes,
    listing,
    cursor: JSON.stringify({ schema: 3, tree, runs: 5, pins: progress, lfsLimitBytes: 0 }),
  };
  await publish(job, progress, pages, expectedState, runArchiveImport);
}

// The child owns only the production action's data. Files stand in for R2 reads
// and the RPC stubs generate or discard one wire page at a time.
async function publish(job, progress, pages, expectedState, runArchiveImport) {
  const config = defaultR2Config;
  Object.assign(process.env, {
    R2_ACCOUNT_ID: config.accountId,
    R2_BUCKET: config.bucket,
    R2_ACCESS_KEY_ID: config.accessKeyId,
    R2_SECRET_ACCESS_KEY: config.secretAccessKey,
  });
  const fetched = new Set();
  let projected = 0,
    finishes = 0,
    listingBytes;
  globalThis.fetch = async (input, request = {}) => {
    const url = new URL(input);
    if (url.hostname === 'api.github.com') {
      assert.equal(url.pathname, '/repos/fixture/large', 'complete pins need no GitHub source request');
      return Response.json({
        full_name: 'fixture/large',
        private: false,
        default_branch: 'main',
        html_url: 'https://github.com/fixture/large',
      });
    }
    assert.equal(url.hostname, config.accountId + '.r2.cloudflarestorage.com');
    if (request.method === 'PUT') {
      const body = Buffer.from(await new Response(request.body).arrayBuffer());
      assert.equal(
        createHash('sha256').update(body).digest('base64'),
        new Headers(request.headers).get('x-amz-checksum-sha256'),
      );
      return new Response(null, { status: 200 });
    }
    if (url.searchParams.has('list-type'))
      return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
    const key = url.pathname.split('/').at(-1);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!fetched.has(key), 'each R2 listing page is fetched once, despite repeated scans');
    fetched.add(key);
    return new Response(Readable.toWeb(createReadStream(join(directory, key))));
  };
  const log = console.log;
  console.log = value => {
    if (typeof value !== 'string' || !value.startsWith('FORGE_IMPORT_METRIC ')) return;
    if (JSON.parse(value.slice('FORGE_IMPORT_METRIC '.length)).phase === 'listing') {
      // Count live backing stores before the catalog/pins load. RSS alone mixes in
      // allocator retention, while a full listing must stay live at this point.
      global.gc();
      global.gc();
      listingBytes = process.memoryUsage().arrayBuffers - baseline;
    }
  };
  const ctx = {
    async runQuery(ref, { after }) {
      assert.equal(getFunctionName(ref), 'projectGithubImportCatalog:stored');
      const windows = [];
      for (let start = Number(after); start < files && windows.length < 2; start += 1000)
        windows.push(window(start));
      return JSON.parse(JSON.stringify(windows));
    },
    async runMutation(ref, args) {
      // Force the action to pay for the size of RPC serialization as in Convex.
      const request = JSON.parse(JSON.stringify(args));
      switch (getFunctionName(ref)) {
        case 'projectGithubImportPublication:begin':
          assert.equal(request.state.sha256, expectedState);
          break;
        case 'projectGithubImportPublication:stage':
          for (const entry of request.entries) {
            if (entry.collection !== 'sourceTreePaths') continue;
            assert.equal(entry.position, projected);
            for (const path of JSON.parse(entry.value).paths) assert.equal(path, pathOf(projected++));
          }
          break;
        case 'projectGithubImportPublication:finish':
          finishes++;
          break;
        default:
          assert.match(
            getFunctionName(ref),
            /^projectGithubImport(?:Store:archiveProgress|Catalog:publish)$/,
          );
      }
      return null;
    },
  };
  global.gc();
  const baseline = process.memoryUsage().arrayBuffers;
  await runArchiveImport(ctx, job, { id: job._id, actor: job.owner }, new ImportRequestMeter());
  assert.equal(finishes, 1);
  assert.equal(projected, files);
  assert.equal(fetched.size, pages + 2, 'R2 reads cover pages, the index and the pin checkpoint');
  assert.ok(fetched.has(progress.sha256));
  log(JSON.stringify({ files, pages, listingBytes, peakRssBytes: process.resourceUsage().maxRSS * 1024 }));
}

function window(start) {
  const end = Math.min(start + 1000, files);
  const pack = blob(files + start);
  const packSize = Math.max(sizeOf(start), sizeOf(end - 1)) * (end - start);
  const digests = [],
    sizes = [],
    packs = [];
  let offset = 0;
  for (let row = start; row < end; row++) {
    const size = sizeOf(row);
    digests.push(blob(row));
    sizes.push(size);
    packs.push({ index: row - start, digest: pack, size: packSize, offset });
    offset += size;
  }
  digests.push(pack);
  sizes.push(packSize);
  return {
    key: String(end),
    value: JSON.stringify({ digests: digests.join(''), sizes, packs, recipes: [] }),
  };
}
