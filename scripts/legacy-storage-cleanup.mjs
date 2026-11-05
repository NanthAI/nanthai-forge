// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCleanup } from './lib/legacy-storage-cleanup-args.mjs';
export { parseCleanup };
import { createHash } from 'node:crypto';
import { privateJson } from './lib/legacy-storage-journal.mjs';
import { operatorIo } from './lib/legacy-storage-operator.mjs';
import { maintenanceWindow, resumeWrites } from './lib/legacy-storage-window.mjs';
export { maintenanceWindow } from './lib/legacy-storage-window.mjs';
import {
  readBodyProof,
  requirePreparedBodies,
  withBodyCoverage,
} from './lib/legacy-storage-reference-proof.mjs';
import { readBench, purgeBench } from './lib/legacy-storage-bench.mjs';
import { migrateVerifiedCursors } from './lib/legacy-storage-cursors.mjs';
import { catalogDigest } from './lib/legacy-storage-closure.mjs';
import { storageClass, verificationIo } from './lib/legacy-storage-verify.mjs';
import {
  deletionPlan,
  frozenScan,
  boundedPages,
  deletionSummary,
  storageTotals,
  preflightHeads,
  excludeHeadFailures,
} from './lib/legacy-storage-cleanup.mjs';
export async function cleanup(command, io = operatorIo(command)) {
  if (command.mode === 'resume-writes') {
    let old = {};
    try {
      old = JSON.parse(await readFile(command.out + '/window.json'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const result = await resumeWrites(io, command.operationId ?? old.operationId);
    await privateJson(command.out + '/window.json', {
      ...old,
      ...result,
      endedAt: Date.now(),
      status: 'ended',
      operatorRecovery: true,
    });
    return result;
  }
  const raw = await readFile(command.audit),
    audit = JSON.parse(raw),
    verification = JSON.parse(await readFile(command.verification));
  if (
    verification.auditSha256 !== createHash('sha256').update(raw).digest('hex') ||
    audit.deployment !== command.deployment
  )
    throw new Error('CLEANUP_SCOPE_CHANGED');
  const bodyProof = await readBodyProof(command.bodyCoverage, audit);
  const bench = await readBench(command.benchManifest, command.deployment);
  const planned = deletionPlan(audit, verification, {
    references: [...audit.files.flatMap(f => f.references), ...bodyProof.references],
  });
  if (command.mode === 'dry-run') {
    const headMetrics = { r2Gets: 0, r2Bytes: 0, convexGets: 0, convexBytes: 0, r2Heads: 0 };
    const heads = await preflightHeads(
      audit,
      verification,
      verificationIo(await io.reader.r2Config(), headMetrics),
      io.progress,
    );
    excludeHeadFailures(planned, heads.excluded);
    const result = {
      dryRun: true,
      bodyCoverageComplete: bodyProof.complete,
      benchRemoval: bench
        ? {
            rows: bench.totalRows,
            jsonBytes: bench.jsonBytes,
            tables: bench.tables.length,
            sha256: bench.sha256,
          }
        : null,
      bodyCoverageSha256: bodyProof.sha256,
      bodyCoverageFailures: bodyProof.failures.length,
      deleted: 0,
      heads,
      headMetrics,
      cursorsToMigrate: planned.excluded.filter(r => r.class === 2 && r.code === 'CURSOR_MIGRATION_REQUIRED')
        .length,
      counts: planned.counts,
      scopeSha256: planned.scopeSha256,
      excluded: planned.excluded,
    };
    await privateJson(command.out + '/dry-run.json', result);
    return result;
  }
  requirePreparedBodies(bodyProof, bench); // Fail before provider calls or arming the single pause.
  const dry = JSON.parse(await readFile(command.out + '/dry-run.json'));
  if (
    dry.scopeSha256 !== planned.scopeSha256 ||
    !dry.dryRun ||
    (!dry.bodyCoverageComplete && !dry.benchRemoval) ||
    dry.benchRemoval?.sha256 !== bench?.sha256 ||
    dry.bodyCoverageSha256 !== bodyProof.sha256
  )
    throw new Error('CLEANUP_DRY_RUN_REQUIRED');
  const retained = audit.files.filter(f => storageClass(f) === 4);
  await io.backup(); // Qualify provider access before the single pause is armed.
  const before = await storageTotals(io.reader, retained);
  if (before.catalogDigest !== catalogDigest(audit.files)) throw new Error('CLEANUP_CATALOG_CHANGED');
  await privateJson(command.out + '/before.json', before);
  if (bench) {
    const definitions = await io.call('projectLegacyStorageBenchCleanup:describe', {});
    if (
      definitions.length !== bench.tables.length ||
      bench.tables.some(t => {
        const d = definitions.find(d => d.table === t.table);
        return !d || d.rows !== t.rows.length || d.ownerField !== t.ownerField || d.index !== t.index;
      })
    )
      throw new Error('CLEANUP_BENCH_SCHEMA_CHANGED');
  }
  const status = await io.call('projectLegacyStorageCleanup:status', {});
  if (status.version !== 2 || status.paused || status.sourceActive) throw new Error('CLEANUP_NOT_QUIET');
  const completed = await maintenanceWindow(
    command,
    async () => {
      const paused = await io.call('projectLegacyStorageCleanup:status', {
        operationId: command.operationId,
      });
      if (!paused.paused || !paused.pauseMatches || paused.sourceActive)
        throw new Error('CLEANUP_PAUSE_UNCONFIRMED');
      const benchDeletion = bench ? await purgeBench(bench, command, io) : null;
      await migrateVerifiedCursors(audit, verification, dry, command, io);
      let scan = await frozenScan(
        io.reader,
        command.operationId,
        command.out,
        [...new Set(audit.files.map(f => f.storageId.length))],
        io.progress,
      );
      const frozenStorage = await storageTotals(io.reader, retained);
      if (frozenStorage.catalogDigest !== bodyProof.catalogDigest) throw new Error('CLEANUP_CATALOG_CHANGED');
      scan = await withBodyCoverage(
        audit,
        scan,
        io.reader,
        await io.reader.r2Config(),
        command.bodyCoverage,
        io.progress,
      );
      await privateJson(command.out + '/covered-scan.json', scan);
      const plan = excludeHeadFailures(deletionPlan(audit, verification, scan), dry.heads.excluded),
        pages = [];
      for (let offset = 0; offset < plan.pins.length; offset += 100)
        pages.push(plan.pins.slice(offset, offset + 100));
      const headMetrics = { r2Gets: 0, r2Bytes: 0, convexGets: 0, convexBytes: 0, r2Heads: 0 };
      const heads = verificationIo(await io.reader.r2Config(), headMetrics);
      let backup = await io.backup();
      const results = await boundedPages(pages, async (pins, index) => {
        await boundedPages(
          pins,
          async pin => {
            try {
              for (const key of pin.keys) await heads.headR2(key, pin.size, pin.digest);
            } catch (error) {
              await privateJson(command.out + `/excluded-head-${index}-${pin.storageId}.json`, {
                storageId: pin.storageId,
                class: pin.class,
                code: /^VERIFY_HEAD_[A-Z_]+$/.test(error.message ?? '')
                  ? error.message
                  : 'VERIFY_HEAD_UNAVAILABLE',
              });
              throw error;
            }
            pin.recheckedAt = new Date().toISOString();
          },
          32,
        );
        if (Date.now() - Date.parse(backup.checkedAt) > 240_000) backup = await io.backup();
        const args = {
          operationId: command.operationId,
          part: `delete-${index}`,
          scopeSha256: plan.scopeSha256,
          scan: {
            pauseOperationId: scan.pauseOperationId,
            startedAt: scan.startedAt,
            finishedAt: scan.finishedAt,
            fullyPaged: true,
            tables: scan.tables,
            sha256: scan.sha256,
            bodyCoverage: scan.bodyCoverage,
          },
          backup,
          pins,
        };
        // Durable original request precedes the mutation, so an unknown outcome can be replayed exactly.
        await privateJson(`${command.out}/request-${index}.json`, args);
        const result = await io.call('projectLegacyStorageCleanup:deletePage', args);
        await privateJson(`${command.out}/result-${index}.json`, result);
        io.progress?.({
          phase: 'delete-page',
          page: index,
          deleted: result.deleted,
          bytes: result.bytes,
          excluded: result.excluded.length,
        });
        if (result.excluded.length) throw new Error('CLEANUP_FILE_EXCLUDED');
        return result;
      });
      const result = {
        operationId: command.operationId,
        benchDeletion,
        summary: deletionSummary(plan, pages, results),
        counts: plan.counts,
        excluded: plan.excluded,
        results,
        scanMetrics: scan.metrics,
        headMetrics,
      };
      await privateJson(command.out + '/deletion.json', result);
      return result;
    },
    io,
  );
  const retainedIds = new Set(completed.excluded.map(r => r.storageId));
  const after = await storageTotals(
    io.reader,
    audit.files.filter(f => storageClass(f) === 4 || retainedIds.has(f.storageId)),
  );
  await privateJson(command.out + '/after.json', after);
  return { ...completed, before, after };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = parseCleanup(process.argv.slice(2));
    const result = await cleanup(command);
    console.log(
      JSON.stringify({
        operation: command.mode,
        dryRun: result.dryRun ?? false,
        summary: result.summary,
        before: result.before,
        after: result.after,
        cursorsToMigrate: result.cursorsToMigrate,
        ...(result.flagsAbsent ? { flagsAbsent: true, flagNames: result.flagNames } : {}),
        counts: result.counts,
        bodyCoverageComplete: result.bodyCoverageComplete,
        bodyCoverageFailures: result.bodyCoverageFailures,
        scopeSha256: result.scopeSha256,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code: /^CLEANUP_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'CLEANUP_FAILED',
          message:
            'Cleanup stopped. Check private receipts and name-only flag absence before investigation; replay original page requests for unknown outcomes.',
        },
      }),
    );
    process.exitCode = 1;
  }
}
