// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { privateJson } from './legacy-storage-journal.mjs';
import { sha, boundedPages } from './legacy-storage-cleanup.mjs';
import { benchPage } from './legacy-storage-bench-query.mjs';
import { benchIndexes } from './legacy-storage-bench-definition.mjs';
export async function prepareBench(audit, candidate, reader, root, out, progress = () => {}) {
  const projectId = candidate.project;
  if (
    candidate.totalRows !== 155012 ||
    candidate.jsonBytes !== 135715196 ||
    audit.projects.find(p => p.id === projectId)?.removal !== 'deleted' ||
    candidate.tables.length !== 58
  )
    throw Error('BENCH_APPROVAL_REQUIRED');
  const indexes = await benchIndexes(
    root,
    candidate.tables.map(t => t.table),
  );
  const startedAt = new Date().toISOString();
  const tables = await boundedPages(candidate.tables, async expected => {
    const original = audit.tables[expected.table]?.projects?.[projectId];
    if (!original || original.documents !== expected.documents || original.jsonBytes !== expected.jsonBytes)
      throw Error('BENCH_APPROVAL_CHANGED');
    const index = indexes[expected.table],
      rows = [];
    const metrics = { calls: 0, scannedDocuments: 0, scannedJsonBytes: 0 };
    let cursor = null;
    do {
      const page = await reader.page(
        `return await (${benchPage.toString()})(ctx,${JSON.stringify(expected.table)},${JSON.stringify(projectId)},${JSON.stringify(index)},${JSON.stringify(cursor)});`,
      );
      metrics.calls++;
      metrics.scannedDocuments += page.scannedDocuments;
      metrics.scannedJsonBytes += page.scannedJsonBytes;
      rows.push(...page.rows);
      if (page.isDone) break;
      if (!page.cursor || page.cursor === cursor) throw Error('BENCH_SCAN_STALLED');
      cursor = page.cursor;
    } while (true);
    if (
      rows.length !== expected.documents ||
      rows.reduce((n, r) => n + r.bytes, 0) !== expected.jsonBytes ||
      rows.some(r => r.ownerProjectId !== projectId) ||
      new Set(rows.map(r => r.id)).size !== rows.length
    )
      throw Error('BENCH_INVENTORY_CHANGED');
    const table = {
      table: expected.table,
      index,
      ownerField: expected.table === 'hostedProjects' ? '_id' : 'projectId',
      rows,
      jsonBytes: expected.jsonBytes,
      metrics,
    };
    await privateJson(out + '.' + expected.table + '.json', table);
    progress({ table: table.table, rows: rows.length, ...metrics });
    return table;
  });
  const manifest = {
    schema: 1,
    projectId,
    deployment: audit.deployment,
    startedAt,
    finishedAt: new Date().toISOString(),
    complete: true,
    totalRows: candidate.totalRows,
    jsonBytes: candidate.jsonBytes,
    tables,
    metrics: tables.reduce(
      (m, t) => {
        for (const k of Object.keys(m)) m[k] += t.metrics[k];
        return m;
      },
      { calls: 0, scannedDocuments: 0, scannedJsonBytes: 0 },
    ),
  };
  manifest.sha256 = sha(manifest);
  await privateJson(out, manifest);
  return manifest;
}
export async function readBench(path, deployment) {
  if (!path) return null;
  const m = JSON.parse(await readFile(path, 'utf8')),
    { sha256, ...body } = m;
  if (
    !m.complete ||
    m.schema !== 1 ||
    m.deployment !== deployment ||
    sha(body) !== sha256 ||
    m.totalRows !== 155012 ||
    m.jsonBytes !== 135715196 ||
    m.tables.length !== 58 ||
    new Set(m.tables.map(t => t.table)).size !== 58 ||
    new Set(m.tables.flatMap(t => t.rows.map(r => r.id))).size !== m.totalRows ||
    m.tables.reduce((n, t) => n + t.rows.length, 0) !== m.totalRows ||
    m.tables.reduce((n, t) => n + t.jsonBytes, 0) !== m.jsonBytes ||
    m.tables.some(
      t =>
        t.rows.reduce((n, r) => n + r.bytes, 0) !== t.jsonBytes ||
        t.rows.some(
          r =>
            r.ownerProjectId !== m.projectId ||
            !Number.isSafeInteger(r.bytes) ||
            r.bytes <= 0 ||
            !/^[a-f0-9]{64}$/.test(r.sha256),
        ),
    )
  )
    throw Error('CLEANUP_BENCH_PROOF_INVALID');
  return m;
}
export function recordPages(manifest) {
  const pages = [];
  for (const table of manifest.tables.filter(t => t.table !== 'hostedProjects')) {
    let pins = [],
      bytes = 0;
    for (const pin of table.rows) {
      if (pin.bytes > 2_000_000) throw Error('CLEANUP_BENCH_ROW_TOO_LARGE');
      if (pins.length && (pins.length === 1000 || bytes + pin.bytes > 2_000_000)) {
        pages.push({ table: table.table, pins });
        pins = [];
        bytes = 0;
      }
      pins.push(pin);
      bytes += pin.bytes;
    }
    if (pins.length) pages.push({ table: table.table, pins });
  }
  const root = manifest.tables.find(t => t.table === 'hostedProjects');
  if (root?.rows.length !== 1 || root.rows[0].id !== manifest.projectId)
    throw Error('CLEANUP_BENCH_ROOT_INVALID');
  return { pages, root: { table: 'hostedProjects', pins: root.rows } };
}
export async function purgeBench(manifest, command, io) {
  const { pages, root } = recordPages(manifest);
  let backup = await io.backup();
  const remove = async (page, index) => {
    if (Date.now() - Date.parse(backup.checkedAt) > 240000) backup = await io.backup();
    const args = {
      ...page,
      operationId: command.operationId,
      part: 'bench-' + index,
      projectId: manifest.projectId,
      manifestSha256: manifest.sha256,
      backup,
    };
    await privateJson(command.out + '/request-bench-' + index + '.json', args);
    const result = await io.call('projectLegacyStorageBenchCleanup:deletePage', args);
    await privateJson(command.out + '/result-bench-' + index + '.json', result);
    if (
      result.deleted !== page.pins.length ||
      result.jsonBytes !== page.pins.reduce((n, p) => n + p.bytes, 0)
    )
      throw Error('CLEANUP_BENCH_RESULT_INVALID');
    io.progress?.({ phase: 'bench-page', table: page.table, deleted: result.deleted });
    return { table: page.table, ...result };
  };
  const results = await boundedPages(pages, remove);
  results.push(await remove(root, pages.length)); // Parent remains deleted until every child page commits.
  const after = await boundedPages(manifest.tables, async table => {
    let cursor = null,
      rows = 0,
      bytes = 0;
    do {
      const page = await io.reader.page(
        `return await (${benchPage.toString()})(ctx,${JSON.stringify(table.table)},${JSON.stringify(manifest.projectId)},${JSON.stringify(table.index)},${JSON.stringify(cursor)});`,
      );
      rows += page.rows.length;
      bytes += page.rows.reduce((n, r) => n + r.bytes, 0);
      if (page.isDone) break;
      if (!page.cursor || page.cursor === cursor) throw Error('CLEANUP_BENCH_SCAN_STALLED');
      cursor = page.cursor;
    } while (true);
    return {
      table: table.table,
      beforeRows: table.rows.length,
      beforeJsonBytes: table.jsonBytes,
      afterRows: rows,
      afterJsonBytes: bytes,
    };
  });
  if (after.some(t => t.afterRows)) throw Error('CLEANUP_BENCH_REFERENCE_REMAINS');
  const result = {
    projectId: manifest.projectId,
    manifestSha256: manifest.sha256,
    deletedRows: results.reduce((n, r) => n + r.deleted, 0),
    deletedJsonBytes: results.reduce((n, r) => n + r.jsonBytes, 0),
    tables: after,
  };
  await privateJson(command.out + '/bench-deletion.json', result);
  return result;
}

/** Bind every known missing root and its referring rows to this exact approved
 * removal. Frozen all-table/body coverage is still rerun after removal. */
export function qualifyBenchReferences(manifest, scan, bodyProof) {
  const approved = new Set(manifest.tables.flatMap(t => t.rows.map(r => t.table + ':' + r.id)));
  const sources = [...scan.references, ...scan.durableReferences].filter(
    r => r.project === manifest.projectId,
  );
  if (sources.some(r => !approved.has(r.table + ':' + r.document)))
    throw Error('CLEANUP_BENCH_REFERENCES_UNAPPROVED');
  const refs = new Set(scan.durableReferences.filter(r => r.project === manifest.projectId).map(r => r.ref));
  if (
    !bodyProof.failures.length ||
    bodyProof.failures.some(
      f =>
        f.node.project !== manifest.projectId || !refs.has(f.node.ref) || f.code !== 'CLOSURE_BODY_MISSING',
    )
  )
    throw Error('CLEANUP_BENCH_REFERENCE_PROOF_INVALID');
  const { sha256, ...body } = manifest;
  const result = {
    ...body,
    sourceReferenceProof: {
      priorManifestSha256: sha256,
      scanSha256: scan.sha256,
      bodyCoverageSha256: bodyProof.sha256,
      referencedRows: new Set(sources.map(r => r.table + ':' + r.document)).size,
      missingRoots: bodyProof.failures.length,
      missingRootRefsAccounted: true,
    },
  };
  result.sha256 = sha(result);
  return result;
}
