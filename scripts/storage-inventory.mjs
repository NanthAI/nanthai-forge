// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Readonly diagnostic query: returns sizes and field names, never payloads.
 * One bounded page per table; count() uses Convex's internal table metadata. */
export async function inventorySample(ctx, table, order, cursor = null) {
  const p = await ctx.db.query(table).order(order).paginate({
    cursor,
    numItems: 128,
    maximumRowsRead: 128,
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
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  if (child.status !== 0) throw new Error('STORAGE_INVENTORY_READ_FAILED');
  return JSON.parse(child.stdout);
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
    const result = run(`return await (${inventorySample.toString()})(ctx,${JSON.stringify(table)},"desc");`);
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
