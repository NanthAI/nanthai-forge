// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { moduleUrl } from '../tests/convex-module.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
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
  {
    model = false,
    requireRegression = false,
    hostedRows,
    hostedGenerations,
    hostedBackups,
    hostedRoots,
  } = {},
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
      assert(
        hostedRows && hostedGenerations,
        'Full action model requires the read-only hosted index export and generations JSON; no partial PASS',
      );
      assert(hostedBackups, 'Full action model requires the read-only backups JSON');
      const backups = JSON.parse(readFileSync(hostedBackups));
      const generations = JSON.parse(readFileSync(hostedGenerations));
      const generation = generations.find(row => row.status === 'ready' && row.revision === before.revision);
      assert(generation, 'Hosted base generation is missing');
      const objects = new Map();
      const oldRoot = {
        kind: 'forge-native-exchange',
        schema: 2,
        work: before.work,
        records: buildByteTree(Buffer.from(JSON.stringify(before)), objects),
        manifest: buildByteTree(readFileSync(join(base, 'manifest.json')), objects),
      };
      const oldBytes = Buffer.from(JSON.stringify(oldRoot));
      objects.set(digest(oldBytes), oldBytes);
      const { ownerDerivedPages } = await import('../dist/owner-derived-pages.js');
      const oldDisplay = ownerDerivedPages(readFileSync(join(capture, 'owner-derived.json')));
      for (const [hash, bytes] of oldDisplay.objects) objects.set(hash, bytes);
      objects.set(digest(oldDisplay.root), oldDisplay.root);
      for (const [hash, bytes] of objects) writeFileSync(join(scratch, hash), bytes, { mode: 0o600 });
      objects.clear();
      oldDisplay.objects.clear();
      global.gc?.();
      const names = [
        'projectSourceReturn',
        'projectMain',
        'projectBackups',
        'projectWork',
        'projectObjects',
        'projectWorkIndexStore',
        'projectReturnIndexStage',
        'projectReturnCommit',
        'projectReturnMetadataStore',
      ];
      const modules = Object.fromEntries(names.map(name => [name, moduleUrl(`../convex/${name}.ts`)]));
      const activeStage = generations.find(
        row =>
          row.returnOperationId &&
          row.initialRevision === after.revision &&
          row.projectId === generation.projectId,
      );
      assert(activeStage, 'Unmodeled offline step: target return stage is absent from generations export');
      const backupId = activeStage.backupId;
      const projectId = generation.projectId;
      const priorBackup = backups.find(backup => backup._id === generation.backupId);
      const candidateBackup = backups.find(backup => backup._id === backupId);
      assert(priorBackup && candidateBackup, 'Unmodeled offline step: selected backup rows are missing');
      const exactRoot = (backup, fallback) => {
        assert(
          hostedRoots || digest(fallback) === backup.digest,
          'Unmodeled offline step: supply exact hosted root envelopes',
        );
        const body =
          digest(fallback) === backup.digest ? fallback : readFileSync(join(hostedRoots, backup.digest));
        assert.equal(body.length, backup.size, 'Hosted root size differs');
        assert.equal(digest(body), backup.digest, 'Hosted root digest differs');
        writeFileSync(join(scratch, backup.digest), body, { mode: 0o600 });
        return JSON.parse(body);
      };
      const exactPrevious = exactRoot(priorBackup, oldBytes);
      const exactCandidate = exactRoot(candidateBackup, prepared.bytes);
      assert.equal(
        exactPrevious.records.sha256,
        digest(JSON.stringify(before)),
        'Hosted base catalog differs',
      );
      assert.equal(exactCandidate.records.sha256, root.records.sha256, 'Hosted candidate catalog differs');
      assert.equal(exactCandidate.manifest.sha256, root.manifest.sha256, 'Hosted candidate manifest differs');
      assert.deepEqual(
        candidateBackup.ownerDerived,
        { sha256: digest(oldDisplay.root), size: oldDisplay.root.length },
        'Capture display pin differs from hosted backup',
      );
      const config = {
        generation,
        modules,
        action: modules.projectSourceReturn,
        input: {
          projectId,
          backupId,
          expectedBackupId: generation.backupId,
          revision: raw.base.journalRevision,
          operationId: activeStage.returnOperationId,
          continuation: true,
        },
        seed: {
          projectWorkGenerations: generations.filter(
            row => row.projectId === projectId && row._id !== generation._id,
          ),
          hostedProjects: [
            {
              _id: projectId,
              _creationTime: 1,
              owner: 'owner',
              key: '00000000-0000-4000-8000-000000000001',
              name: 'Offline capture',
              currentBackup: backupId,
              revision: 1,
              work: {
                backupId: generation.backupId,
                revision: raw.base.journalRevision,
                initialRevision: before.revision,
                generationId: generation._id,
              },
            },
          ],
          projectBackups: [{ ...priorBackup }, { ...candidateBackup }],
        },
      };
      const configFile = join(scratch, 'offline-config.json');
      const seedObjects = () => {
        const pins = new Map(prepared.pins.map(pin => [pin.sha256, pin.size]));
        pins.set(digest(prepared.bytes), prepared.bytes.length);
        for (const hash of readdirSync(scratch).filter(name => /^[a-f0-9]{64}$/.test(name)))
          pins.set(hash, statSync(join(scratch, hash)).size);
        config.seed.projectObjects = [...pins].map(([hash, size]) => ({
          _id: `object-${hash}`,
          projectId,
          digest: hash,
          size,
          storageId: hash,
          status: 'stored',
        }));
        writeFileSync(configFile, JSON.stringify(config));
      };
      seedObjects();
      const args = [
        new URL('./check-work-return-action.mjs', import.meta.url).pathname,
        scratch,
        capture,
        hostedRows,
        hostedGenerations,
        configFile,
      ];
      const run = mode =>
        spawnSync(
          process.execPath,
          [
            '--expose-gc',
            `--max-old-space-size=${mode === 'prepare-display' ? 256 : 224}`,
            '--max-semi-space-size=4',
            ...args,
            ...(mode ? [mode] : []),
          ],
          { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        );
      const baseline = run();
      const baselineResult = JSON.parse(baseline.stdout.trim().split('\n').at(-1));
      assert.equal(baseline.status, 1, 'Original capture must reproduce INVALID_OWNER_DATA');
      assert.equal(baselineResult.code, 'INVALID_OWNER_DATA', baseline.stderr || baseline.stdout);
      assert.match(baselineResult.reason, /stats-missing-or-unpaired:/, baseline.stdout + baseline.stderr);
      const fresh = run('prepare-display');
      assert.equal(fresh.status, 0, fresh.stderr);
      config.seed.projectBackups[1].ownerDerived = JSON.parse(
        readFileSync(join(scratch, 'fresh-display.json')),
      );
      delete config.seed.projectBackups[1].ownerDerived.comparisons;
      seedObjects();
      const worker = run();
      assert.equal(worker.status, 0, worker.stderr || worker.stdout);
      actionModel = {
        regression: baselineResult,
        freshDisplay: JSON.parse(fresh.stdout.trim().split('\n').at(-1)),
        ...JSON.parse(worker.stdout.trim().split('\n').at(-1)),
      };
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
      ...(actionModel ? { actionModel } : {}),
      peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024),
      validationMs: Math.round(performance.now() - started),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [base, capture, hostedRows, hostedGenerations, hostedBackups, hostedRoots] = process.argv.slice(2);
  assert(
    base && capture,
    'Usage: node scripts/check-work-return-capture.mjs BASE_DIRECTORY CAPTURE_DIRECTORY',
  );
  try {
    console.log(
      JSON.stringify(
        await checkWorkReturnCapture(base, capture, {
          model: true,
          requireRegression: true,
          hostedRows,
          hostedGenerations,
          hostedBackups,
          hostedRoots,
        }),
      ),
    );
  } catch (error) {
    console.error(`FAIL ${error.code ?? error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}
