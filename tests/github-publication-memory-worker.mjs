// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { ImportedPins, ListingPageWriter } from '../dist/github-listing-codec.js';
import { ImportRequestMeter } from '../dist/github-import-meter.js';
import { defaultR2Config } from './default-r2.mjs';
import {
  blob,
  byteCount,
  digest,
  fileSize,
  pathOf,
  servePublication,
} from './github-publication-memory-service.mjs';

const [mode, count, directory, action, origin, compatibility] = process.argv.slice(2);
const files = Number(count);
const tree = 'a'.repeat(40),
  commit = 'b'.repeat(40),
  at = '2026-01-01T00:00:00.000Z';
const totalBytes = byteCount(files);
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
      size = fileSize(files, row);
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
} else if (mode === 'fixture') {
  await servePublication(files, directory);
} else {
  const { runArchiveImport } = await import(action);
  const response = await fetch(`${origin}/job?mode=${mode}`);
  assert.ok(response.ok);
  const { listing, progress, pages, expectedState, state } = await response.json();
  if (mode !== 'publish') assert.ok(state, 'initial publication pinned the State');
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
    cursor: JSON.stringify({
      schema: 3,
      tree,
      runs: 5,
      ...(mode === 'retry-state' ? {} : { pins: progress }),
      lfsLimitBytes: 0,
    }),
    ...(mode === 'publish' ? {} : { stateObject: state }),
  };
  await publish(job, pages, expectedState, runArchiveImport);
}

// The fixture process owns all remote data. The measured child pays the same
// bounded request/response serialization and byte transfer as a hosted action.
async function publish(job, pages, expectedState, runArchiveImport) {
  const config = defaultR2Config;
  Object.assign(process.env, {
    R2_ACCOUNT_ID: config.accountId,
    R2_BUCKET: config.bucket,
    R2_ACCESS_KEY_ID: config.accessKeyId,
    R2_SECRET_ACCESS_KEY: config.secretAccessKey,
  });
  const fetchRemote = globalThis.fetch;
  globalThis.fetch = async (input, request = {}) => {
    const url = new URL(input);
    assert.ok(['api.github.com', config.accountId + '.r2.cloudflarestorage.com'].includes(url.hostname));
    const path = url.hostname === 'api.github.com' ? '/github' + url.pathname : url.pathname;
    return fetchRemote(origin + path + url.search, request);
  };
  const log = console.log;
  const phases = {};
  const retained = {};
  console.log = value => {
    if (typeof value !== 'string' || !value.startsWith('FORGE_IMPORT_METRIC ')) return;
    const record = JSON.parse(value.slice('FORGE_IMPORT_METRIC '.length));
    const { phase, rssBytes, peakRssBytes, heapUsed, external, arrayBuffers, memoryLimitBytes, source } =
      record;
    phases[phase] = { rssBytes, peakRssBytes, heapUsed, external, arrayBuffers, memoryLimitBytes, source };
    // Observe live data separately from the hard-limit replay, which does not force GC.
    if (global.gc && phase !== 'upload') {
      global.gc();
      global.gc();
      const { heapUsed, arrayBuffers } = process.memoryUsage();
      retained[phase] = { heapUsed, arrayBuffers };
    }
  };
  const rpc = async (ref, args) => {
    const name = getFunctionName(ref);
    const response = await fetchRemote(`${origin}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ name, args }),
    });
    assert.ok(response.ok, name);
    return response.json();
  };
  global.gc?.();
  global.gc?.();
  const baseline = process.memoryUsage().arrayBuffers;
  await runArchiveImport(
    { runQuery: rpc, runMutation: rpc },
    job,
    { id: job._id, actor: job.owner },
    new ImportRequestMeter(),
  );
  const response = await fetchRemote(`${origin}/result`);
  assert.ok(response.ok);
  const result = await response.json();
  assert.equal(result.state.sha256, expectedState);
  assert.equal(result.ready, true);
  if (mode !== 'publish' && compatibility !== 'control')
    assert.equal(phases.resume?.source, mode === 'retry-state' ? 'state' : 'pins');
  const cgroup =
    process.constrainedMemory() === 435 * 1024 * 1024
      ? {
          limit: Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8')),
          swap: Number(readFileSync('/sys/fs/cgroup/memory.swap.max', 'utf8')),
          peak: Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8')),
        }
      : undefined;
  log(
    JSON.stringify({
      cgroup,
      ...result,
      files,
      pages,
      mode,
      phases,
      retained,
      listingBytes: retained.listing?.arrayBuffers - baseline,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
}
