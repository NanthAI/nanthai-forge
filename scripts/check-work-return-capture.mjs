// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { moduleUrl } from '../tests/convex-module.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalog } from './check-work-exchange-capture.mjs';
import { preparedMetadata } from '../dist/native-exchange-prepared.js';
import { prepareRecordReturn, preservesParsedWorkBytes } from '../dist/work-return-context.js';
import { sourceManifestSchema } from '../dist/work-archive-metadata.js';
import { digest } from '../dist/hash.js';
import { buildByteTree, readByteTree } from '../dist/native-exchange-tree.js';
import { recordIdentity, recordMap } from '../dist/work-exchange-records.js';
import {
  validateWorkDelta,
  channelMetadataChanges,
  supportsWorkDelta,
  WORK_DELTA_BYTES,
} from '../dist/work-exchange-delta.js';
import { workDeltaSelection } from '../dist/work-exchange-context.js';
export async function checkWorkReturnCapture(
  base,
  capture,
  { model = false, requireRegression = false } = {},
) {
  const scratch = mkdtempSync(join(tmpdir(), 'forge-return-check-'));
  try {
    const prepared = preparedMetadata(capture, readFileSync(join(capture, 'manifest.json')));
    const root = JSON.parse(prepared.bytes);
    const read = async pin => prepared.read(pin.sha256) ?? readFileSync(join(scratch, pin.sha256));
    const after = JSON.parse(await readByteTree(root.records, pins => Promise.all(pins.map(read))));
    const before = await catalog(base, scratch, { has: () => true });
    assert(root.delta && root.delta.size <= WORK_DELTA_BYTES);
    const raw = JSON.parse(await read(root.delta));
    assert.equal(digest(JSON.stringify(before)), raw.base.root, 'Base catalog differs from retained delta');
    assert(preservesParsedWorkBytes(before) && preservesParsedWorkBytes(after), 'Parsed Work order differs');
    assert(supportsWorkDelta(before, after), 'Return layout is unsupported');
    const pinnedManifest = await readByteTree(root.manifest, pins => Promise.all(pins.map(read)));
    assert(
      pinnedManifest.equals(readFileSync(join(capture, 'manifest.json'))),
      'Candidate manifest differs from its pin',
    );
    const delta = validateWorkDelta(before, after, raw, { root: raw.base.root });
    const events = [];
    for (const { collection, record } of recordMap(after).values())
      if (collection === 'hostedEvents') {
        const event = JSON.parse(await read(record));
        if (event.previousRevision >= before.revision && event.previousRevision < raw.base.journalRevision)
          events.push(event);
      }
    const extras = { intents: [], anchors: [], hostedChannelMoves: [] };
    for (const { command } of events) {
      if ('intentId' in command) extras.intents.push(recordIdentity('intents', command.intentId));
      if (command.anchor) extras.anchors.push(recordIdentity('views', command.anchor.viewId));
      if (command.action === 'accept-hosted-channel')
        for (const { collection, record } of recordMap(before).values())
          if (collection === 'hostedChannelMoves')
            extras.hostedChannelMoves.push(recordIdentity(collection, record.key));
    }
    const metadataCalls = {};
    const countTree = async (name, tree, load) => {
      let pages = 0,
        pins = 0;
      await readByteTree(
        tree,
        async selected => {
          pages++;
          pins += selected.length;
          return Promise.all(selected.map(load));
        },
        { batchSize: 1000 },
      );
      metadataCalls[name] = { pages, pins };
    };
    await countTree('candidateRecords', root.records, read);
    await countTree('candidateManifest', root.manifest, read);
    const oldMetadata = new Map();
    const oldRecordTree = buildByteTree(Buffer.from(JSON.stringify(before)), oldMetadata);
    const oldManifestTree = buildByteTree(readFileSync(join(base, 'manifest.json')), oldMetadata);
    await countTree('previousRecords', oldRecordTree, pin => oldMetadata.get(pin.sha256));
    await countTree('previousManifest', oldManifestTree, pin => oldMetadata.get(pin.sha256));
    const metadataOnly = await channelMetadataChanges(before, after, delta.changes, read);
    const stats = extra => {
      const plan = workDeltaSelection(before, after, delta, extra, metadataOnly);
      const fields = {};
      for (const map of [plan.old, plan.next])
        for (const id of plan.selected) {
          const item = map.get(id);
          if (!item) continue;
          const entry = (fields[item.collection] ??= { records: 0, bytes: 0 });
          entry.records++;
          entry.bytes += item.record.size;
        }
      return { records: plan.selected.size, bytes: plan.bytes, fields };
    };
    let actionModel;
    if (model) {
      writeFileSync(join(scratch, 'before.json'), JSON.stringify(before));
      writeFileSync(join(scratch, 'after.json'), JSON.stringify(after));
      writeFileSync(join(scratch, 'events.json'), JSON.stringify(events));
      writeFileSync(join(scratch, 'manifest.json'), readFileSync(join(base, 'manifest.json')));
      const args = [
        '--expose-gc',
        '--max-old-space-size=128',
        '--max-semi-space-size=4',
        new URL('./check-work-return-action.mjs', import.meta.url).pathname,
        scratch,
        capture,
        moduleUrl('../convex/projectSourceReturnProgress.ts'),
        moduleUrl('../convex/projectSourceReturnDelta.ts'),
      ];
      const baselineWorker = spawnSync(
        process.execPath,
        [...args.filter(arg => !arg.startsWith('--max-old-space-size')), 'baseline'],
        { encoding: 'utf8' },
      );
      assert.equal(baselineWorker.status, 0, baselineWorker.stderr);
      const worker = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(worker.status, 0, worker.stderr);
      actionModel = JSON.parse(worker.stdout.trim().split('\n').at(-1));
      assert(actionModel.peakRssMiB < 256, 'Action model exceeded 256 MiB');
      assert(actionModel.elapsedMs < 30000, 'Action model exceeded 30 seconds');
    }
    const original = stats(Object.values(extras).flat());
    if (requireRegression)
      assert(original.bytes > WORK_DELTA_BYTES, 'Capture did not reproduce the old byte budget');
    const cache = new Map();
    let pages = 0,
      bodyPages = 0,
      reads = 0,
      cacheBytes = 0;
    const readCached = async pin => {
      if (!cache.has(pin.sha256)) {
        reads++;
        const bytes = await read(pin);
        cache.set(pin.sha256, bytes);
        cacheBytes += bytes.length;
      }
      const bytes = cache.get(pin.sha256);
      assert.equal(bytes.length, pin.size);
      assert.equal(digest(bytes), pin.sha256);
      return bytes;
    };
    const manifest = sourceManifestSchema.parse(JSON.parse(readFileSync(join(capture, 'manifest.json'))));
    const started = performance.now();
    const result = await prepareRecordReturn(
      before,
      after,
      delta,
      events,
      manifest,
      raw.base.journalRevision,
      'a'.repeat(64),
      readCached,
      async pins => {
        pages++;
        if (pins.some(pin => !cache.has(pin.sha256))) bodyPages++;
        assert(pins.length <= 100);
        return Promise.all(pins.map(readCached));
      },
    );
    assert(result, 'Return context remains over budget');
    const modeledCalls = actionModel
      ? Object.values(actionModel.calls).reduce((sum, count) => sum + count, 0) -
        1 +
        2 *
          (Object.values(metadataCalls).reduce((sum, entry) => sum + entry.pages, 0) +
            bodyPages +
            3 +
            1 +
            Math.ceil(Math.ceil(statSync(join(capture, 'owner-derived.json')).size / 131072) / 16)) +
        13
      : undefined;
    if (requireRegression && actionModel)
      assert(
        modeledCalls +
          50 +
          Math.ceil((1900 * 32768) / 6000000) +
          Math.ceil(actionModel.metadataBytes / 6000000) <=
          300,
        'Capture exceeded 300 predicted calls with the stated retained-copy assumption',
      );
    return {
      status: 'PASS',
      baseRevision: before.revision,
      journalRevision: raw.base.journalRevision,
      revision: after.revision,
      events: events.length,
      extra: Object.fromEntries(Object.entries(extras).map(([key, value]) => [key, new Set(value).size])),
      metadataOnly: metadataOnly.size,
      oldLimit: WORK_DELTA_BYTES,
      oldSkipReason: original.bytes > WORK_DELTA_BYTES ? 'context-over-budget' : null,
      oldOverBudgetBytes: Math.max(0, original.bytes - WORK_DELTA_BYTES),
      selectedRecords: original.records,
      contextBytes: original.bytes,
      contextPages: pages,
      bodyPages,
      metadataCalls,
      bodiesRead: reads,
      cacheBytes,
      fields: original.fields,
      recordsValidated: result.validated.validated,
      convexCalls: 0,
      documentsRead: 0,
      documentsWritten: 0,
      ...(actionModel
        ? {
            actionModel,
            predictedCalls: {
              // The capture has source/Work, not the hosted disposable index. State
              // the copy assumption instead of claiming an observed hosted row count.
              foregroundExcludingRetainedCopy: modeledCalls,
              foregroundWithAssumedCopy: modeledCalls + 50,
              includingCleanup:
                modeledCalls +
                50 +
                Math.ceil((1900 * 32768) / 6000000) +
                Math.ceil(actionModel.metadataBytes / 6000000),
              retainedCopy: {
                rowsPerCall: 2000,
                bytesPerCall: 2000000,
                assumption: '100000 retained index rows, with byte packing fitting 50 copy calls',
                calls: 50,
              },
              cleanup: {
                abandonedPages: 1900,
                pagesPerCall: 200,
                bytesPerCall: 6000000,
                calls: Math.ceil((1900 * 32768) / 6000000) + Math.ceil(actionModel.metadataBytes / 6000000),
              },
            },
          }
        : {}),
      peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024),
      validationMs: Math.round(performance.now() - started),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [base, capture] = process.argv.slice(2);
  assert(
    base && capture,
    'Usage: node scripts/check-work-return-capture.mjs BASE_DIRECTORY CAPTURE_DIRECTORY',
  );
  try {
    console.log(
      JSON.stringify(await checkWorkReturnCapture(base, capture, { model: true, requireRegression: true })),
    );
  } catch (error) {
    console.error(`FAIL ${error.code ?? error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}
