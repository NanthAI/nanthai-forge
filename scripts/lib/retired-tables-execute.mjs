// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { writeRecoveryState } from '../../dist/recovery-state.js';
import { join, dirname } from 'node:path';
import { failure } from './hosted-durability-compare.mjs';
import { RETIRED_TABLES, readTable, verifyExport, sha256 } from './retired-tables.mjs';

const rowKey = row => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

/** Retained operation receipt reconciles a lost import reply before issuing another replacement. */
export async function purgeTables(runner, command, plan) {
  const { operationId, approval, deployment } = command;
  if (!/^[a-f0-9-]{36}$/.test(operationId ?? '')) throw failure('PURGE_OPERATION_REQUIRED');
  if (sha256(deployment) !== plan.deploymentDigest) throw failure('APPROVAL_MISMATCH');
  const { rows: exported } = await verifyExport(command.directory);
  const path = join(dirname(approval), `purge-${operationId}.json`);
  const request = sha256(
    JSON.stringify([
      operationId,
      deployment,
      plan.manifestSha256,
      command.deployedAt?.toISOString(),
      sha256(await readFile(approval)),
    ]),
  );
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (receipt && receipt.request !== request) throw failure('PURGE_OPERATION_CHANGED');
  // Check every table before the first write, including changed rows with old IDs.
  const live = plan.liveRows;
  for (const table of Object.keys(RETIRED_TABLES)) {
    const expected = new Set(exported[table].map(rowKey));
    if (
      (receipt?.completedAt && live[table].rows.length) ||
      live[table].rows.some(row => !expected.has(rowKey(row))) ||
      (!receipt && live[table].rows.length !== exported[table].length)
    )
      throw failure('PURGE_INVENTORY_CHANGED');
  }
  if (!receipt) {
    receipt = { operationId, request, before: plan.totals, tables: {}, startedAt: new Date().toISOString() };
    writeRecoveryState(path, receipt);
  }
  const save = () => writeRecoveryState(path, receipt);
  const empty = join(dirname(approval), `purge-${operationId}-empty.jsonl`);
  await writeFile(empty, '', { mode: 0o600 });
  for (const table of Object.keys(RETIRED_TABLES)) {
    if (live[table].rows.length) await runner.importTable(table, empty, 'replace');
    const after = live[table].rows.length ? await readTable(runner, table) : live[table];
    if (after.rows.length) throw failure('PURGE_VERIFY_FAILED');
    receipt.tables[table] = { rows: 0, bytes: 0 };
    await save();
  }
  receipt.after = { rows: 0, bytes: 0 };
  receipt.completedAt ??= new Date().toISOString();
  await save();
  return { operation: 'purge', dryRun: false, ...receipt };
}
