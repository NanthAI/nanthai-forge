// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { failure } from './hosted-durability-compare.mjs';
import { READ_CAP, RETIRED_TABLES, readTable, verifyExport } from './retired-tables.mjs';

export const APPROVAL_DECISION = 'approve-retired-table-purge';
export function eligibility(deployedAt) {
  return {
    known: Boolean(deployedAt),
    retiredCodeDeployedAt: deployedAt?.toISOString(),
    note: 'Owner-approved gate: backup fix closed, real alert received, one verified post-deploy backup.',
  };
}

/** Counts what a purge would touch, against the live tables and the verified export. */
export async function purgePlan(runner, directory, { deployedAt, cap = READ_CAP } = {}) {
  const { manifest, manifestSha256, rows: exported } = await verifyExport(directory);
  const tables = {};
  const liveRows = {};
  let rows = 0,
    bytes = 0,
    entries = 0;
  for (const [table, { indexes }] of Object.entries(RETIRED_TABLES)) {
    const live = await readTable(runner, table, cap);
    liveRows[table] = live;
    const known = new Set(exported[table].map(row => row._id));
    const unexported = live.rows.filter(row => !known.has(row._id)).length;
    tables[table] = {
      rows: live.rows.length,
      bytes: live.bytes,
      exportedRows: known.size,
      unexportedRows: unexported,
    };
    rows += live.rows.length;
    bytes += live.bytes;
    entries += live.rows.length * (indexes + 1);
  }
  const populated = Object.values(tables).filter(entry => entry.rows).length;
  const plan = {
    tables,
    totals: { rows, bytes },
    // Estimate: rows and bytes are measured; the I/O model (one verify read, one replace scan,
    // one delete per document and index entry) is assumed, not observed.
    cost: {
      basis: 'estimate',
      userFunctionCalls: 0,
      cliRequests: Object.keys(tables).length + populated * 2,
      dbReadBytes: bytes * 2,
      documentsDeleted: rows,
      indexEntriesDeleted: entries,
      deletedBytes: bytes,
    },
    manifestSha256,
    manifestCreatedAt: manifest.createdAt,
    deploymentDigest: manifest.deploymentDigest,
    eligibility: eligibility(deployedAt),
  };
  Object.defineProperty(plan, 'liveRows', { value: liveRows });
  return plan;
}

/** Throws unless the approval record names this deployment, this export and the qualified post-deploy backup and alert. */
export function checkApproval(record, plan, { deployedAt, now = new Date() }) {
  const text = value => typeof value === 'string' && value.length > 0;
  const at = value => (text(value) && !Number.isNaN(Date.parse(value)) ? new Date(value) : null);
  if (!record || record.decision !== APPROVAL_DECISION || !text(record.approvedBy))
    throw failure('APPROVAL_INVALID');
  const approvedAt = at(record.approvedAt);
  if (!approvedAt || approvedAt > now || approvedAt < new Date(plan.manifestCreatedAt))
    throw failure('APPROVAL_INVALID');
  if (
    record.deploymentDigest !== plan.deploymentDigest ||
    record.manifestSha256 !== plan.manifestSha256 ||
    !Array.isArray(record.tables) ||
    Object.keys(plan.tables).some(table => !record.tables.includes(table))
  )
    throw failure('APPROVAL_MISMATCH');
  // Dropped tables exported to private storage need no backup attestation: the verified export
  // (live rows must equal it before any deletion) plus the named lead decision and Issue.
  const populated = Object.entries(plan.tables).filter(([, entry]) => entry.rows > 0);
  // A replay after completion has nothing left to delete.
  if (populated.length && populated.every(([table]) => RETIRED_TABLES[table].gate === 'exported')) {
    if (!text(record.leadDecision) || !text(record.issue)) throw failure('APPROVAL_INVALID');
    return;
  }
  if (!deployedAt) throw failure('DEPLOY_TIME_REQUIRED');
  const backup = record.verifiedBackup;
  const completedAt = at(backup?.completedAt);
  if (
    !record.backupFixClosed ||
    !record.alertReceived ||
    !text(backup?.id) ||
    !completedAt ||
    completedAt < deployedAt ||
    completedAt > now ||
    !(backup.r2Bytes > 0) ||
    !/^[a-f0-9]{64}$/.test(backup.sha256 ?? '')
  )
    throw failure('APPROVAL_BACKUPS_INSUFFICIENT');
}

const skipFiles = new Set(['schema.ts', 'projectPublicationFields.ts']);
async function* sources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '_generated' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.(?:ts|mjs)$/.test(entry.name) && !skipFiles.has(entry.name)) yield path;
  }
}

/** Source files outside the schema that still name a retired table: blockers for removing its definition. */
export async function definitionBlockers(root) {
  const found = Object.fromEntries(Object.keys(RETIRED_TABLES).map(table => [table, []]));
  for (const directory of ['convex', 'src'])
    for await (const path of sources(join(root, directory))) {
      const text = await readFile(path, 'utf8');
      for (const table of Object.keys(found))
        if (text.includes(`'${table}'`) || text.includes(`"${table}"`))
          found[table].push(relative(root, path));
    }
  return found;
}
