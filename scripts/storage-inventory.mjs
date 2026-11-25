// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/** Readonly diagnostic query: returns sizes and field names, never payloads.
 * One bounded page per table; count() uses Convex's internal table metadata. */
export async function inventorySample(ctx, table, order, cursor = null, numItems = 128) {
  const p = await ctx.db.query(table).order(order).paginate({
    cursor,
    numItems,
    maximumRowsRead: numItems,
    maximumBytesRead: 262144,
  });
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return {
    table,
    order,
    cursor: p.continueCursor,
    isDone: p.isDone,
    rows: p.page.map(row => ({
      bytes: bytes(row),
      kind: row.collection ?? row.kind ?? row.type ?? row.phase ?? row.status ?? 'record',
      fields: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, bytes(v)])),
      valueFields:
        typeof row.value === 'string'
          ? (() => {
              try {
                const value = JSON.parse(row.value);
                return value && typeof value === 'object' && !Array.isArray(value)
                  ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bytes(v)]))
                  : {};
              } catch {
                return {};
              }
            })()
          : {},
    })),
  };
}

function run(source) {
  const child = spawnSync(
    process.execPath,
    [resolve('node_modules/convex/bin/main.js'), 'run', '--deployment', 'dev', '--inline-query', source],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (child.status !== 0) {
    // Name the real cause: a missing deployment, a buffer overflow or the query's own error.
    const reason = child.error?.code ?? (child.signal ? `signal ${child.signal}` : `exit ${child.status}`);
    const diagnostic = (child.stderr ?? '').trim().split('\n').slice(-6).join('\n').slice(0, 1500);
    throw Object.assign(
      new Error(`STORAGE_INVENTORY_READ_FAILED (${reason})${diagnostic ? `\n${diagnostic}` : ''}`),
      { code: 'STORAGE_INVENTORY_READ_FAILED' },
    );
  }
  return JSON.parse(child.stdout);
}

/** A table whose page is too big for one read (a row over the byte limit) is sampled with fewer rows;
 * a table that still fails is reported as unreadable instead of ending the whole inventory. */
function sample(table) {
  let failure;
  for (const numItems of [128, 16, 1]) {
    try {
      return run(
        `return await (${inventorySample.toString()})(ctx,${JSON.stringify(table)},"desc",null,${numItems});`,
      );
    } catch (error) {
      failure = error;
    }
  }
  return { table, unreadable: String(failure?.message ?? failure) };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [tablesFile, output] = process.argv.slice(2);
  if (!tablesFile || !output) throw new Error('Pass a table-name file and private output directory.');
  const tables = readFileSync(tablesFile, 'utf8').trim().split(/\s+/).filter(Boolean);
  if (!tables.every(t => /^[A-Za-z][A-Za-z0-9_]*$/.test(t))) throw new Error('Invalid table names.');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const counts = run(
    `return await Promise.all(${JSON.stringify(tables)}.map(async table=>({table,count:await ctx.db.query(table).count()})));`,
  );
  writeFileSync(resolve(output, 'counts.json'), JSON.stringify(counts), { mode: 0o600 });
  let bytes = 0;
  for (const { table, count } of counts) {
    if (!count) continue;
    rmSync(resolve(output, `${table}-desc.json`), { force: true }); // never leave an old sample beside new counts
    const result = sample(table);
    if (result.unreadable) {
      process.exitCode = 1; // incomplete inventory
      process.stdout.write(JSON.stringify({ table, count, unreadable: result.unreadable }) + '\n');
      continue;
    }
    bytes += result.rows.reduce((n, row) => n + row.bytes, 0);
    writeFileSync(resolve(output, `${table}-desc.json`), JSON.stringify(result), { mode: 0o600 });
    process.stdout.write(
      JSON.stringify({
        table,
        count,
        sampleRows: result.rows.length,
        sampleBytes: result.rows.reduce((n, row) => n + row.bytes, 0),
        totalSampleBytes: bytes,
      }) + '\n',
    );
  }
}
