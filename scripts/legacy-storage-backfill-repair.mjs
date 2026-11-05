// SPDX-License-Identifier: Apache-2.0
// Bounded owner-scoped repair of r2BackfilledAt for R2-native class 1 objects the
// cleanup dry run reported as OWNER_BACKFILL_UNSET. `plan` writes nothing. `apply`
// re-hashes every R2 copy first, then patches only rows whose full digest matched.
// Usage: node scripts/legacy-storage-backfill-repair.mjs plan|apply --deployment dev:NAME
//   --dry-run DRY_RUN_JSON --project PROJECT_ID --actor OWNER_SUBJECT --out PRIVATE_JSON
//   [--operation-id UUID]   (apply only)
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { privateJson } from './lib/legacy-storage-journal.mjs';
import { verificationIo } from './lib/legacy-storage-verify.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const MAX_REPAIR_ROWS = 100;
export function parseRepair(args) {
  const { values: v, positionals: p } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      deployment: { type: 'string' },
      'dry-run': { type: 'string' },
      project: { type: 'string' },
      actor: { type: 'string' },
      out: { type: 'string' },
      'operation-id': { type: 'string' },
    },
  });
  if (
    p.length !== 1 ||
    !['plan', 'apply'].includes(p[0]) ||
    !v.deployment?.startsWith('dev:') ||
    !v['dry-run'] ||
    !v.project ||
    !v.actor ||
    !v.out ||
    (p[0] === 'apply' && !uuid.test(v['operation-id'] ?? ''))
  )
    throw new Error('REPAIR_ARGUMENT_INVALID');
  const out = resolve(v.out);
  if (out === root || out.startsWith(root + '/')) throw new Error('REPAIR_PRIVATE_OUTPUT_REQUIRED');
  return {
    mode: p[0],
    deployment: v.deployment,
    dryRun: resolve(v['dry-run']),
    projectId: v.project,
    actor: v.actor,
    out,
    operationId: v['operation-id'] ?? null,
  };
}
/** One inline read for all candidate rows (indexed by storage id, at most 3 owners each). */
const rowsSource = ids => `const out=[];for(const s of ${JSON.stringify(ids)}){
  const objects=await ctx.db.query('projectObjects').withIndex('by_storage',q=>q.eq('storageId',s)).take(3);
  const backups=await ctx.db.query('projectBackups').withIndex('by_storage',q=>q.eq('storageId',s)).take(3);
  out.push({storageId:s,backups:backups.length,objects:objects.map(r=>({id:r._id,projectId:r.projectId,digest:r.digest,size:r.size,r2Key:r.r2Key??null,unset:r.r2BackfilledAt===undefined}))});
}return out;`;
export async function repairBackfill(command, io) {
  const dry = JSON.parse(await readFile(command.dryRun));
  const candidates = (dry.guards?.excluded ?? []).filter(r => r.code === 'OWNER_BACKFILL_UNSET');
  if (!dry.dryRun || dry.guards?.complete !== true) throw new Error('REPAIR_DRY_RUN_REQUIRED');
  if (!candidates.length) throw new Error('REPAIR_NOTHING_TO_DO');
  if (candidates.length > MAX_REPAIR_ROWS) throw new Error('REPAIR_SCOPE_TOO_LARGE');
  const metrics = { convexCalls: 1, r2Gets: 0, r2Bytes: 0, convexGets: 0, convexBytes: 0 };
  const found = await io.reader.page(rowsSource(candidates.map(c => c.storageId)));
  const rows = [],
    skipped = [];
  for (const file of found) {
    const own = file.objects.filter(r => r.projectId === command.projectId && r.unset);
    // Owner scope: exactly one unset projectObjects owner in this project and no backup owner.
    if (file.backups || own.length !== 1 || file.objects.length !== own.length)
      skipped.push({ storageId: file.storageId, code: file.backups ? 'BACKUP_OWNER' : 'OUT_OF_SCOPE' });
    else rows.push({ ...own[0], storageId: file.storageId });
  }
  const r2 = verificationIo(await io.reader.r2Config(), metrics);
  const pins = [];
  for (const row of rows) {
    // Full R2 GET + SHA-256 against the row digest; bytes never enter evidence.
    try {
      if (row.r2Key !== `v1/p/${command.projectId}/o/${row.digest}`) throw new Error('VERIFY_R2_PIN_INVALID');
      if ((await r2.hashR2(row.r2Key, row.size)) !== row.digest) throw new Error('VERIFY_DIGEST_MISMATCH');
      pins.push({
        id: row.id,
        storageId: row.storageId,
        digest: row.digest,
        size: row.size,
        r2VerifiedAt: new Date().toISOString(),
      });
    } catch (error) {
      skipped.push({
        storageId: row.storageId,
        code: /^VERIFY_[A-Z_]+$/.test(error.message) ? error.message : 'VERIFY_FAILED',
      });
    }
  }
  const scope = { projectId: command.projectId, actor: command.actor, rows: pins };
  const result = {
    mode: command.mode,
    candidates: candidates.length,
    verified: pins.length,
    skipped,
    metrics,
  };
  if (pins.length) {
    metrics.convexCalls++;
    result.plan = await io.call('projectLegacyStorageRepair:plan', scope);
    if (command.mode === 'apply') {
      const ready = pins.filter((_, i) => result.plan[i].code === null);
      if (ready.length) {
        metrics.convexCalls += 2;
        result.applied = await io.call('projectLegacyStorageRepair:apply', {
          ...scope,
          rows: ready,
          operationId: command.operationId,
        });
        result.confirmed = await io.call('projectLegacyStorageRepair:plan', { ...scope, rows: ready });
      }
    }
  }
  await privateJson(command.out, result);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = parseRepair(process.argv.slice(2));
    const { operatorIo } = await import('./lib/legacy-storage-operator.mjs');
    const result = await repairBackfill(command, operatorIo(command));
    const count = (list, code) => list?.filter(r => r.code === code).length ?? 0;
    console.log(
      JSON.stringify({
        mode: result.mode,
        candidates: result.candidates,
        verified: result.verified,
        skipped: result.skipped.length,
        planReady: count(result.plan, null),
        applied: count(result.applied, null),
        confirmedAlreadySet: count(result.confirmed, 'ALREADY_SET'),
        metrics: result.metrics,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        error: /^REPAIR_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'REPAIR_FAILED',
      }),
    );
    process.exitCode = 1;
  }
}
