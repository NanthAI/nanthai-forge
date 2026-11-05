// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { privateJson } from '../legacy-storage-audit.mjs';
import { auditPage } from './legacy-storage-query.mjs';
import { catalogDigest } from './legacy-storage-closure.mjs';
import { storageClass, digestHex, liveReferences } from './legacy-storage-verify.mjs';
import { headPins, MAX_SKIPPED_PAGES } from './legacy-storage-heads.mjs';
import { errorEvidence } from './legacy-storage-window.mjs';
export const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Class 4 (no R2 copy) is deleted only from an explicit owner-approved,
 * audit-pinned manifest, and only when current coverage finds no reference. */
export function deletionPlan(audit, verification, scan, approval = null) {
  if (!verification.complete || verification.deployment !== audit.deployment || !audit.coverage?.fullyPaged)
    throw new Error('CLEANUP_VERIFICATION_REQUIRED');
  const verified = new Map(verification.results.map(r => [r.storageId, r]));
  const refs = new Map();
  for (const ref of liveReferences(scan?.references ?? audit.files.flatMap(f => f.references))) {
    const list = refs.get(ref.storageId) ?? [];
    list.push(ref);
    refs.set(ref.storageId, list);
  }
  const pins = [],
    excluded = [],
    counts = {},
    class4 = new Map((approval?.files ?? []).map(f => [f.storageId, f]));
  for (const file of audit.files) {
    const cls = storageClass(file);
    if (cls === 4 && class4.has(file.storageId)) {
      const approved = class4.get(file.storageId),
        current = refs.get(file.storageId) ?? [];
      let code =
        approved.bytes !== file.bytes || digestHex(approved.sha256) !== digestHex(file.sha256)
          ? 'CLASS4_APPROVAL_CHANGED'
          : null;
      if (current.length) code = 'REFERENCE_REMAINS';
      if (scan?.bodyCoverage?.complete !== true) code = 'BODY_COVERAGE_REQUIRED';
      const c = (counts[4] ??= { files: 0, bytes: 0, eligible: 0, excluded: 0 });
      c.files++;
      c.bytes += file.bytes;
      if (code) {
        excluded.push({ storageId: file.storageId, class: 4, code });
        c.excluded++;
        continue;
      }
      pins.push({
        storageId: file.storageId,
        class: 4,
        digest: digestHex(file.sha256),
        size: file.bytes,
        verifiedAt: approval.checkedAt,
        fullDigest: true,
        keys: [],
        owners: [],
      });
      c.eligible++;
      continue;
    }
    if (![1, 2, 3].includes(cls)) continue;
    const v = verified.get(file.storageId),
      current = refs.get(file.storageId) ?? [];
    let code =
      !v?.fullDigest || v.sha256 !== digestHex(file.sha256) || v.bytes !== file.bytes
        ? 'FULL_DIGEST_REQUIRED'
        : null;
    if (current.some(r => !['projectObjects', 'projectBackups'].includes(r.table) || r.field !== 'storageId'))
      code = 'REFERENCE_REMAINS';
    if (cls !== 1 && current.length) code = cls === 2 ? 'CURSOR_MIGRATION_REQUIRED' : 'REFERENCE_REMAINS';
    if (
      cls === 1 &&
      !code &&
      current.some(
        r =>
          r.location !== 'r2' ||
          !r.committed ||
          r.digest !== v?.sha256 ||
          r.size !== file.bytes ||
          !v?.keys.includes(r.key ?? r.r2Key),
      )
    )
      code = 'OWNER_CHANGED';
    // Owner narrowed this phase: unknown bench bodies can reference unattributed files.
    if (cls === 3 && scan?.bodyCoverage?.complete !== true) code = 'MISSING_BENCH_CURSOR_BODIES';
    const c = (counts[cls] ??= { files: 0, bytes: 0, eligible: 0, excluded: 0 });
    c.files++;
    c.bytes += file.bytes;
    if (code) {
      excluded.push({ storageId: file.storageId, class: cls, code });
      c.excluded++;
      continue;
    }
    pins.push({
      storageId: file.storageId,
      class: cls,
      digest: v.sha256,
      size: file.bytes,
      verifiedAt: v.verifiedAt,
      fullDigest: true,
      keys: v.keys,
      owners: current.map(r => ({ table: r.table, id: r.document })),
    });
    c.eligible++;
  }
  return {
    pins,
    excluded,
    counts,
    scopeSha256: approval
      ? sha([sha(audit.files.filter(f => [1, 2, 3].includes(storageClass(f)))), approval.sha256])
      : sha(audit.files.filter(f => [1, 2, 3].includes(storageClass(f)))),
  };
}
/** Four table streams, serial pages within each table. Complete table discovery
 * is compared at both ends. The paused mutation boundary makes this stable. */
export async function frozenScan(reader, operationId, directory, idLengths, progress = () => {}) {
  const tables = (await reader.tables()).sort(),
    results = new Array(tables.length);
  let next = 0,
    failed = false;
  const startedAt = new Date().toISOString();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 4 }, async () => {
      try {
        for (;;) {
          const index = next++;
          if (failed || index >= tables.length) break;
          const table = tables[index],
            state = {
              table,
              cursor: null,
              references: [],
              durableReferences: [],
              metrics: { calls: 0, documents: 0, jsonBytes: 0 },
              complete: false,
            };
          do {
            if (failed) throw new Error('CLEANUP_SCAN_CANCELLED');
            const page = await reader.page(
              `return await (${auditPage.toString()})(ctx,${JSON.stringify(table)},${JSON.stringify(state.cursor)},1024,${JSON.stringify(idLengths)});`,
            );
            state.metrics.calls++;
            state.metrics.documents += page.documents;
            state.metrics.jsonBytes += page.jsonBytes;
            state.references.push(...page.references);
            state.durableReferences.push(...(page.durableReferences ?? []));
            if (!page.isDone && (!page.cursor || page.cursor === state.cursor))
              throw new Error('CLEANUP_SCAN_STALLED');
            state.cursor = page.cursor;
            state.complete = page.isDone;
            await privateJson(`${directory}/scan-${table}.json`, state);
          } while (!state.complete);
          results[index] = state;
          progress({ phase: 'scan-table-complete', table, ...state.metrics });
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    }),
  );
  if (outcomes.some(o => o.status === 'rejected')) throw new Error('CLEANUP_SCAN_FAILED');
  if (JSON.stringify(tables) !== JSON.stringify((await reader.tables()).sort()))
    throw new Error('CLEANUP_TABLES_CHANGED');
  const scan = {
    pauseOperationId: operationId,
    startedAt,
    finishedAt: new Date().toISOString(),
    fullyPaged: true,
    tables,
    references: results.flatMap(r => r.references),
    durableReferences: results.flatMap(r => r.durableReferences),
    metrics: results.reduce(
      (a, r) => ({
        calls: a.calls + r.metrics.calls,
        documents: a.documents + r.metrics.documents,
        jsonBytes: a.jsonBytes + r.metrics.jsonBytes,
      }),
      { calls: 0, documents: 0, jsonBytes: 0 },
    ),
  };
  scan.sha256 = sha(scan);
  await privateJson(`${directory}/scan.json`, scan);
  return scan;
}
/** All in-flight disjoint pages settle before the caller resumes writes, even
 * on failure. The first failure prevents additional page dispatch. */
export async function boundedPages(pages, apply, concurrency = 4) {
  let next = 0,
    failed = false,
    first = null;
  const results = [];
  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= pages.length) break;
        try {
          results[index] = await apply(pages[index], index);
        } catch (e) {
          failed = true;
          first ??= { page: index, error: e };
          throw e;
        }
      }
    }),
  );
  // Keep the first page's own code (e.g. CLEANUP_EXCLUSION_LIMIT) in window.json evidence.
  if (settled.some(s => s.status === 'rejected'))
    throw Object.assign(new Error('CLEANUP_PAGE_FAILED'), {
      pageFailure: errorEvidence(first?.error),
      page: first?.page,
    });
  return results;
}

export function deletionSummary(plan, pages, results) {
  const classes = {
    1: { deleted: 0, excluded: 0, bytesFreed: 0 },
    2: { deleted: 0, excluded: 0, bytesFreed: 0 },
    3: { deleted: 0, excluded: 0, bytesFreed: 0 },
    4: { deleted: 0, excluded: 0, bytesFreed: 0 },
  };
  for (const row of plan.excluded) classes[row.class].excluded++;
  for (let i = 0; i < pages.length; i++) {
    const excluded = new Set(results[i].excluded.map(r => r.storageId));
    let deleted = 0,
      bytes = 0;
    for (const pin of pages[i]) {
      const c = classes[pin.class];
      if (excluded.has(pin.storageId)) c.excluded++;
      else {
        c.deleted++;
        c.bytesFreed += pin.size;
        deleted++;
        bytes += pin.size;
      }
    }
    if (deleted !== results[i].deleted || bytes !== results[i].bytes)
      throw new Error('CLEANUP_RESULT_INVALID');
  }
  return { classes, changedRows: results.reduce((n, r) => n + r.changedRows, 0) };
}
export async function storageTotals(reader, retained) {
  const expected = new Map(retained.map(f => [f.storageId, f])),
    seen = new Set(),
    catalog = [];
  let cursor = null,
    files = 0,
    bytes = 0,
    calls = 0,
    retainedClass4Verified = 0;
  do {
    const page = await reader.page(
      `const p=await ctx.db.system.query('_storage').order('asc').paginate({cursor:${JSON.stringify(cursor)},numItems:1024,maximumBytesRead:4000000});return {rows:p.page,cursor:p.continueCursor,isDone:p.isDone};`,
    );
    calls++;
    files += page.rows.length;
    for (const row of page.rows) {
      bytes += row.size;
      catalog.push({ _id: row._id, sha256: row.sha256, size: row.size });
      const pin = expected.get(row._id);
      if (pin) {
        if (pin.bytes !== row.size || digestHex(pin.sha256) !== digestHex(row.sha256))
          throw new Error('CLEANUP_RETAINED_FILE_CHANGED');
        seen.add(row._id);
        if (storageClass(pin) === 4) retainedClass4Verified++;
      }
    }
    if (page.isDone) break;
    if (!page.cursor || page.cursor === cursor) throw new Error('CLEANUP_SCAN_STALLED');
    cursor = page.cursor;
  } while (true);
  if (seen.size !== expected.size) throw new Error('CLEANUP_RETAINED_FILE_MISSING');
  return {
    files,
    bytes,
    calls,
    retainedFilesVerified: seen.size,
    retainedClass4Verified,
    catalogDigest: catalogDigest(catalog),
    observedAt: new Date().toISOString(),
    basis: 'physical _storage metadata; billed dashboard storage may lag',
  };
}

/** Preserve the old purge's current-checksum precondition during preparation,
 * so a known missing checksum does not consume the single approved pause.
 * Transient provider failures get the same bounded retry as the pause. */
export async function preflightHeads(audit, verification, io, progress = () => {}, retry = {}) {
  const originals = new Map(
    audit.files.filter(f => [1, 2, 3].includes(storageClass(f))).map(f => [f.storageId, f]),
  );
  const files = verification.results
    .filter(v => v.fullDigest && originals.has(v.storageId))
    .map(v => ({
      storageId: v.storageId,
      class: storageClass(originals.get(v.storageId)),
      keys: v.keys,
      size: v.bytes,
      digest: v.sha256,
    }));
  const checked = await headPins(files, io, retry);
  progress({ phase: 'dry-run-heads', checked: files.length, excluded: checked.failures.length });
  return {
    checked: files.length,
    attempts: checked.attempts,
    history: checked.history,
    excluded: checked.failures,
  };
}
const pageBytes = pins => pins.reduce((n, p) => n + p.size, 0);
function pageClasses(pins) {
  const classes = {};
  for (const pin of pins) {
    const c = (classes[pin.class] ??= { files: 0, bytes: 0 });
    c.files++;
    c.bytes += pin.size;
  }
  return classes;
}
/** Each 100-file page is HEAD-rechecked with page-scoped bounded retry. An
 * exhausted page is skipped and reported (no mutation); other approved pages
 * continue within the original window, deadline and page bounds. More than
 * maxSkippedPages skipped pages stop further dispatch. A file the backend
 * refuses is kept, reported in excluded-page-N.json, and dispatch continues;
 * more than maxExcludedFiles refusals (one page) stop it, since that many
 * means the dry run no longer describes the deployment. */
export async function applyFilePages({
  pages,
  heads,
  io,
  out,
  request,
  backup,
  retry = {},
  maxSkippedPages = MAX_SKIPPED_PAGES,
  maxExcludedFiles = MAX_EXCLUDED_FILES,
}) {
  const skipped = [],
    refused = [];
  let refusedFiles = 0;
  let current = backup;
  const results = await boundedPages(pages, async (pins, index) => {
    const headed = pins.some(p => p.keys.length)
      ? await headPins(
          pins.filter(p => p.keys.length),
          heads,
          retry,
        )
      : null;
    for (const pin of pins) if (!pin.keys.length) pin.recheckedAt = new Date().toISOString();
    if (headed && !headed.ok) {
      const report = {
        page: index,
        files: pins.length,
        bytes: pageBytes(pins),
        classes: pageClasses(pins),
        attempts: headed.attempts,
        history: headed.history,
        failures: headed.failures,
        skippedAt: new Date().toISOString(),
      };
      await privateJson(`${out}/skipped-page-${index}.json`, report);
      skipped.push(report);
      io.progress?.({
        phase: 'delete-page-skipped',
        page: index,
        files: pins.length,
        attempts: headed.attempts,
      });
      if (skipped.length > maxSkippedPages) throw new Error('CLEANUP_HEAD_SKIP_LIMIT');
      const codes = new Map(headed.failures.map(f => [f.storageId, f.code]));
      return {
        skipped: true,
        deleted: 0,
        bytes: 0,
        changedRows: 0,
        excluded: pins.map(p => ({ storageId: p.storageId, code: codes.get(p.storageId) ?? 'PAGE_SKIPPED' })),
      };
    }
    if (Date.now() - Date.parse(current.checkedAt) > 240_000) current = await io.backup();
    const args = { ...request(index), backup: current, pins };
    // Durable original request precedes the mutation, so an unknown outcome can be replayed exactly.
    await privateJson(`${out}/request-${index}.json`, args);
    const result = await io.call('projectLegacyStorageCleanup:deletePage', args);
    await privateJson(`${out}/result-${index}.json`, result);
    io.progress?.({
      phase: 'delete-page',
      page: index,
      deleted: result.deleted,
      bytes: result.bytes,
      excluded: result.excluded.length,
    });
    if (result.excluded.length) {
      // A refused file keeps its bytes; report it and let the other approved pages continue.
      const report = { page: index, excluded: result.excluded, reportedAt: new Date().toISOString() };
      await privateJson(`${out}/excluded-page-${index}.json`, report);
      refused.push(report);
      refusedFiles += result.excluded.length;
      io.progress?.({ phase: 'delete-page-excluded', page: index, files: result.excluded.length });
      if (refusedFiles > maxExcludedFiles) throw new Error('CLEANUP_EXCLUSION_LIMIT');
    }
    return result;
  });
  return { results, skipped, excluded: refused };
}
export const MAX_EXCLUDED_FILES = 100;
/** Dry run only: the backend's own per-file delete guard (planPage), read-only,
 * one query per 100-pin page. Its exclusions join the plan exactly as apply
 * would see them, so the plan and the delete cannot disagree. */
export async function guardPlan(plan, io, progress = () => {}) {
  const excluded = [];
  let calls = 0;
  for (let offset = 0; offset < plan.pins.length; offset += 100) {
    // Every pin here passed its HEAD recheck in this dry run.
    const at = new Date().toISOString();
    const pins = plan.pins.slice(offset, offset + 100).map(p => ({ ...p, recheckedAt: at }));
    const byId = new Map(pins.map(p => [p.storageId, p]));
    calls++;
    for (const row of await io.call('projectLegacyStorageCleanup:planPage', { pins }))
      excluded.push({ storageId: row.storageId, class: byId.get(row.storageId).class, code: row.code });
  }
  progress({ phase: 'dry-run-guards', checked: plan.pins.length, excluded: excluded.length, calls });
  return { complete: true, checked: plan.pins.length, calls, excluded };
}
export function excludeHeadFailures(plan, failures) {
  const failed = new Map(failures.map(r => [r.storageId, r]));
  const kept = [];
  for (const pin of plan.pins) {
    const f = failed.get(pin.storageId);
    if (f) {
      plan.excluded.push(f);
      plan.counts[pin.class].eligible--;
      plan.counts[pin.class].excluded++;
    } else kept.push(pin);
  }
  plan.pins = kept;
  plan.excluded = plan.excluded.map(r => failed.get(r.storageId) ?? r);
  return plan;
}
