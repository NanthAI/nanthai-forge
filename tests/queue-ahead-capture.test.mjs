// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { scanSourcePaths } from '../dist/source-paths.js';
import { hostedQueueAhead } from '../dist/queue-ahead-hosted.js';

function put(root, path, bytes = 'synthetic cache') {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

test('hosted finish observation then save captures zero paths at dogfood size', async t => {
  const f = agentFixture(t),
    transport = f.transport();
  await transport.dispatch('open', { laneId: f.lane.laneId });
  const source = new NativeSource(f.root),
    blob = source.put(Buffer.from('base\n')),
    files = Array.from({ length: 2538 }, (_, i) => ({
      path: `src/file-${String(i).padStart(4, '0')}.txt`,
      mode: 'file',
      blob,
    }));
  const state = (text, parents) =>
    source.writeState(
      [{ ...files[0], blob: source.put(Buffer.from(text)) }, ...files.slice(1)],
      parents,
      'Synthetic queue preview',
      '2026-01-01T00:00:00.000Z',
    );
  const main = state('base\n', []),
    mine = state('mine\n', [main]),
    ahead = state('ahead\n', [main]);
  const pages = buildComposePages([
    {
      laneId: randomUUID(),
      head: ahead,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: { sha256: ahead, size: source.object(ahead).length }, recipe: null },
    },
  ]);
  for (const id of readdirSync(source.directory)) f.objects.set(id, readFileSync(join(source.directory, id)));
  for (const page of pages.pages) f.objects.set(page.pin.sha256, Buffer.from(saveBytes(page.value)));
  for (let i = 0; i < 32000; i++) f.objects.set(`unrelated-${i}`, Buffer.alloc(0));
  const selection = {
    main,
    mine,
    ahead: [{ id: randomUUID(), head: ahead, inputs: pages.manifest.root, status: 'checking' }],
    more: false,
  };
  let statusCalls = 0,
    objectCalls = 0,
    objectPins = 0,
    downloads = 0;
  const objects = f.exchange.objects,
    downloadBatch = f.exchange.downloadBatch;
  f.exchange.objects = async ids => {
    objectCalls++;
    objectPins += ids.length;
    return objects(ids);
  };
  f.exchange.downloadBatch = async pins => {
    downloads += pins.length;
    return downloadBatch(pins);
  };
  const query = f.exchange.client.query;
  f.exchange.client.query = async (ref, args) => {
    if (['projectHostedLanding:status', 'projectHostedFinish:status'].includes(getFunctionName(ref))) {
      statusCalls++;
      return JSON.stringify({ queueAheadSelection: selection });
    }
    return query(ref, args);
  };
  const start = performance.now();
  const finished = await transport.dispatch('finish', {
    candidateId: f.candidate.id,
    composeOperationId: randomUUID(),
    message: 'Synthetic finish',
  });
  assert.equal(finished.result.queueAhead.cost.composeCalls, 2);
  const coldCalls = f.calls.length + statusCalls,
    coldObjectCalls = objectCalls,
    coldDownloads = downloads;
  const observed = await transport.dispatch('observe', { submissionId: finished.result.submission.id });
  assert.equal(observed.result.queueAhead.cost.cacheHits, 1);
  assert.equal(observed.result.queueAhead.cost.composeCalls, 0);
  assert.equal(
    f.calls.length + statusCalls - coldCalls,
    2,
    'warm observation reads capability and status only',
  );
  assert.equal(objectCalls, coldObjectCalls);
  assert.equal(downloads, coldDownloads);
  assert(!existsSync(join(f.root, 'queue-ahead-objects')));
  assert(existsSync(join(`${f.root}.forge-client`, 'queue-ahead-objects/objects')));
  assert(existsSync(join(`${f.root}.forge-client`, 'queue-ahead-verdicts')));
  // Reproduce the previous client's 84 stray files before the next actual save.
  for (let i = 0; i < 84; i++) put(f.root, `queue-ahead-objects/objects/${i}`);
  const operationId = randomUUID();
  await transport.dispatch('save', { operationId, message: 'Save after observation' });
  const capture = JSON.parse(
    readFileSync(join(`${f.root}.forge-client`, 'saves', operationId, 'capture.json')),
  );
  assert.deepEqual(capture.changes, []);
  assert.deepEqual(capture.files, []);
  const request = JSON.parse(
    f.calls.findLast(call => call.name === 'projectHostedSaves:prepare').args.request,
  );
  assert.equal(request.changeCount, 0);
  const visited = [];
  assert.deepEqual(scanSourcePaths(f.root, { visitDirectory: path => visited.push(path) }), []);
  assert.deepEqual(visited, [''], 'capture never traverses old caches or Forge metadata');
  assert(objectCalls <= 10, `bounded selected object reads: ${objectCalls}`);
  assert(process.resourceUsage().maxRSS < 512 * 1024);
  t.diagnostic(
    JSON.stringify({
      sourceFiles: files.length,
      unrelatedObjects: 32000,
      legacyFiles: 84,
      objectCalls,
      functionCalls: f.calls.length + statusCalls + objectCalls,
      objectPins,
      downloads,
      capturedPaths: capture.changes.length,
      peakRssKiB: process.resourceUsage().maxRSS,
      wallMs: Math.round(performance.now() - start),
    }),
  );
});

test('legacy saved cache entries ignore edits and removal without source deletions', async t => {
  const f = agentFixture(t);
  await f.transport().dispatch('open', { laneId: f.lane.laneId });
  const source = new NativeSource(f.root),
    paths = [
      'queue-ahead-objects/objects/old',
      'nested/client.forge-client/agent/old.json',
      'nested/client.forge-metrics.jsonl',
    ],
    files = paths.map(path => ({ path, blob: source.put(Buffer.from('saved cache')), mode: 'file' })),
    head = source.writeState(files, [], 'Legacy cache baseline', '2026-01-01T00:00:00.000Z'),
    markerPath = join(f.root, '.forge/hosted-lane.json'),
    marker = JSON.parse(readFileSync(markerPath));
  Object.assign(marker, { state: source.state(head), materialized: paths, scope: null });
  marker.selection.head = head;
  writeFileSync(markerPath, JSON.stringify(marker));
  for (const path of paths) put(f.root, path, 'changed local cache');
  put(f.root, '.forgeignore', '!queue-ahead-objects/\n!*.forge-client/\n');
  for (const removed of [false, true]) {
    if (removed) for (const path of paths) rmSync(join(f.root, path));
    const capture = await captureHostedSave(f.root, join(`${f.root}.forge-client`, `migration-${removed}`));
    assert.deepEqual(
      capture.changes.map(change => change.path),
      ['.forgeignore'],
    );
    assert.deepEqual(
      source.capture(f.root, false, head).filter(file => paths.includes(file.path)),
      source.state(head).files,
    );
  }
  assert.deepEqual(
    source.capture(f.root).map(file => file.path),
    ['.forgeignore'],
  );
});

test('redirected client metadata cannot put advisory caches back inside source', async t => {
  const f = agentFixture(t);
  mkdirSync(f.root, { recursive: true });
  symlinkSync(f.root, `${f.root}.forge-client`);
  await assert.rejects(
    hostedQueueAhead(f.transport(), { main: f.lane.head, mine: f.lane.head, ahead: [], more: false }),
    error => error.code === 'UNSAFE_PATH',
  );
  assert.deepEqual(readdirSync(f.root), []);
});
