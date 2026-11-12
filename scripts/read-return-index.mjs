// SPDX-License-Identifier: Apache-2.0
// Explicit read-only dev export. No deployment code or data is written.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [deployment, generation, output] = process.argv.slice(2);
assert(
  deployment && generation && output,
  'Usage: node scripts/read-return-index.mjs DEV_DEPLOYMENT GENERATION OUTPUT.jsonl',
);
assert(deployment !== 'prod', 'Select the named dev deployment');
writeFileSync(output, '', { mode: 0o600 });
let cursor = null,
  tableIndex = 0,
  rows = 0,
  bytes = 0;
const tables = ['projectWorkRecords', 'projectPlanningRecords', 'projectWorkDataRecords'];
for (let pages = 1; pages <= 200; pages++) {
  const query = `JSON.stringify(await ctx.db.query(${JSON.stringify(tables[tableIndex])}).withIndex("by_generation_and_collection_and_key", q => q.eq("generationId", ${JSON.stringify(generation)})).paginate({cursor:${JSON.stringify(cursor)},numItems:4000,maximumRowsRead:4000,maximumBytesRead:4000000}))`;
  const result = spawnSync(
    process.execPath,
    [resolve('node_modules/convex/bin/main.js'), 'run', '--deployment', deployment, '--inline-query', query],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, 'The explicit Work index read failed.');
  const page = JSON.parse(JSON.parse(result.stdout));
  for (const row of page.page) {
    const line = JSON.stringify(row) + '\n';
    appendFileSync(output, line);
    rows++;
    bytes += Buffer.byteLength(line);
  }
  assert(bytes < 1024 * 1024 * 1024, 'Export exceeded 1 GiB; incomplete');
  if (page.isDone && tableIndex + 1 < tables.length) {
    tableIndex++;
    cursor = null;
    continue;
  }
  if (page.isDone) {
    console.log(JSON.stringify({ rows, bytes, pages, writes: 0 }));
    break;
  }
  assert.notEqual(page.continueCursor, cursor, 'Export made no progress');
  cursor = page.continueCursor;
  assert(pages < 200, 'Export incomplete after 200 pages');
}
