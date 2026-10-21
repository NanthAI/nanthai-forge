// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../dist/hash.js';
import { getFunctionName } from 'convex/server';
import { fixture, checkpoint, preparedCheckpoint, modules, upload } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { retainExchangeBaseline } from '../dist/native-exchange-baseline.js';
import { land } from './source-landings-fixture.mjs';
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
for (const mode of ['supplied'])
  for (const landings of ['malformed', 'oversized'].includes(mode) ? [1] : [1, 20])
    test(
      `${mode}: incremental hosted return after ${landings} landings with 1000 historical States`,
      { timeout: 300000 },
      async t => {
        const s = fixture(),
          first = await checkpoint(t, s);
        land(first.store, 25, 40);
        const seed = await preparedCheckpoint(s, first.store);
        const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, seed.input);
        await modules.projectWorkActions.initialize._handler(s.ctx, {
          projectId: 'project',
          backupId,
          operationId: randomUUID(),
        });
        const generationId = await index.ensure._handler(s.ctx, { projectId: 'project' });
        if (landings === 1) {
          for (const [id, row] of s.tables.projectWorkRecords)
            if (row.collection.startsWith('sourceStateParent')) s.tables.projectWorkRecords.delete(id);
          const generation = s.tables.projectWorkGenerations.get(generationId),
            metadata = JSON.parse(generation.metadata);
          delete metadata.counts.sourceStateParents;
          delete metadata.counts.sourceStateParentChunks;
          generation.metadata = JSON.stringify(metadata);
          for (const head of s.tables.projectWorkHeads.values())
            if (head.backupId === backupId) head.metadata = generation.metadata;
        }
        const previousRows = new Map(
          [...s.tables.projectWorkRecords.values()]
            .filter(r =>
              ['viewFiles', 'viewDetails', 'sourceStateParents', 'diffstats'].includes(r.collection),
            )
            .map(r => [`${r.collection}:${r.key}`, r._id]),
        );
        const baselineKey = 'synthetic/previous';
        retainExchangeBaseline(
          first.store,
          baselineKey,
          seed.manifest,
          first.store.load(),
          [],
          JSON.parse(
            readFileSync(
              join(first.store.directory, `exchange-${seed.input.operationId}`, 'states.json'),
              'utf8',
            ),
          ),
        );
        const revision = first.store.load().revision;
        land(first.store, landings);
        const pushStarted = performance.now();
        const next = await preparedCheckpoint(s, first.store, 0, baselineKey);
        const bytes = readFileSync(
          join(first.store.directory, `exchange-${next.input.operationId}`, 'owner-derived.json'),
        );
        const sidecar = JSON.parse(bytes);
        for (const collection of ['parents', 'ancestry', 'views', 'stats'])
          assert.equal(sidecar[collection].length, landings, `${collection} contains only delta rows`);
        assert.ok(bytes.length < 4 * 1024 * 1024);
        console.log(
          'INCREMENTAL_SIDECAR_BYTES',
          JSON.stringify({ mode, landings, history: 1000, bytes: bytes.length }),
        );
        const ownerDerived =
          mode === 'supplied'
            ? await upload(s, bytes)
            : mode === 'oversized'
              ? { sha256: '0'.repeat(64), size: 4 * 1024 * 1024 + 1 }
              : mode === 'malformed'
                ? await upload(s, Buffer.from('{"schema":1}'))
                : undefined;
        next.input.previous = backupId;
        const candidateId = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
        const input = {
          projectId: 'project',
          backupId: candidateId,
          expectedBackupId: backupId,
          revision,
          operationId: randomUUID(),
          continuation: true,
          ...(ownerDerived ? { ownerDerived } : {}),
        };
        let steps = 0,
          actions = 0,
          smallObjectReads = 0;
        const phases = [];
        let diffstatItems = 0,
          ancestryItems = 0,
          viewItems = 0;
        const runAction = s.ctx.runAction;
        s.ctx.runAction = (ref, args) => {
          if (getFunctionName(ref) === 'projectDiffstats:compare') diffstatItems++;
          return runAction(ref, args);
        };
        const run = s.ctx.runMutation,
          get = s.ctx.storage.get;
        s.ctx.runMutation = async (ref, args) => {
          if (getFunctionName(ref) === 'projectReturnIndexStage:batch') {
            steps++;
            if (args.progress) phases.push(JSON.parse(args.progress).phase);
            if (args.cursor) {
              const cursor = JSON.parse(
                gunzipSync(Buffer.from(await (await get(args.cursor)).arrayBuffer())).toString('utf8'),
              );
              ancestryItems = Math.max(ancestryItems, Math.min(cursor.head, cursor.heads.length));
              viewItems = Math.max(viewItems, cursor.view);
            }
          }
          return run(ref, args);
        };
        const smallObjectStorage = new Set(
          [...s.tables.projectObjects.values()]
            .filter(r => next.manifest.files.some(p => p.sha256 === r.digest && p.size < 1000))
            .map(r => r.storageId),
        );
        s.ctx.storage.get = async key => {
          if (smallObjectStorage.has(key)) smallObjectReads++;
          return get(key);
        };
        const started = performance.now();
        let result;
        do {
          actions++;
          result = await modules.projectSourceReturn.returnSource._handler(s.ctx, input);
        } while (result.pending);
        const elapsedMs = Math.round(performance.now() - started);
        console.log(
          'RETURN_BENCHMARK',
          JSON.stringify({
            mode,
            landings,
            steps,
            actions,
            smallObjectReads,
            diffstatItems,
            ancestryItems,
            viewItems,
            elapsedMs,
            pushMs: Math.round(performance.now() - pushStarted),
          }),
        );
        if (mode === 'supplied')
          assert.ok(
            phases.every(p => p === 'done'),
            `owner rows skipped item phases: ${phases}`,
          );
        else assert.ok(diffstatItems > 0, 'fallback computes diffstat items');
        if (mode === 'supplied') {
          assert.equal(diffstatItems, 0);
          assert.equal(ancestryItems, 0);
          assert.equal(viewItems, 0);
        }
        assert.equal(result.revision, first.store.load().revision + 1);
        assert.equal(s.tables.projectWorkGenerations.get(generationId).backupId, candidateId);
        for (const row of s.tables.projectWorkRecords.values()) {
          const prior = previousRows.get(`${row.collection}:${row.key}`);
          if (prior) assert.equal(row._id, prior, 'unchanged derived records retain their physical identity');
        }
        const rows = [...s.tables.projectWorkRecords.values()].filter(
          r =>
            r.generationId ===
            (s.tables.projectWorkGenerations.get(generationId).recordsGenerationId ?? generationId),
        );
        for (const view of first.store.load().views.slice(-landings)) {
          const detail = JSON.parse(
            rows.find(r => r.collection === 'viewDetails' && r.key === view.id).value,
          );
          assert.equal(detail.fileCount, 1);
          assert.equal(detail.provenanceAvailable, true);
          assert.equal(
            JSON.parse(rows.find(r => r.collection === 'viewFiles' && r.key === `${view.id}:a.ts`).value)
              .historyComplete,
            true,
          );
          const changes = JSON.parse(
            rows.find(r => r.collection === 'diffstats' && r.key === `${view.base}:${view.head}`).value,
          );
          assert.deepEqual(changes, { files: 1, add: 1, del: 1 });
        }
        const generation = s.tables.projectWorkGenerations.get(generationId);
        const counts = JSON.parse(generation.metadata).counts;
        for (const collection of [
          'lanes',
          'views',
          'viewDetails',
          'viewFiles',
          'laneViews',
          'viewAcceptances',
          'sourceStateParents',
          'diffstats',
        ])
          assert.equal(
            counts[collection],
            rows.filter(r => r.collection === collection).length,
            `${collection} metadata counts match retained rows`,
          );
        // Only the completing call reports per-push accounting.
        assert.ok(result.accounting.invocations >= 1);
        delete result.accounting;
        assert.deepEqual(await modules.projectSourceReturn.returnSource._handler(s.ctx, input), result);
      },
    );
