// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { failure } from './hosted-durability-compare.mjs';

// Phase 5 B1.9: tables whose writers B1.6-B1.8 deleted. `indexes` counts declared indexes
// (each deleted row also removes one entry per index plus the creation-time index).
export const RETIRED_TABLES = {
  ownerAcceptanceMachines: { indexes: 1 },
  ownerAcceptanceRequests: { indexes: 3 },
  projectPublicationAttempts: { indexes: 2 },
  projectPublications: { indexes: 2 },
  projectPublicationPages: { indexes: 2 },
  projectReturnSupersessions: { indexes: 1 },
};
// Optional fields on live rows. Reported only: live code still reads them, so they are not purged here.
export const REPORT_ONLY_FIELDS = [
  { table: 'hostedProjects', path: 'exchangeCleanupCursor' },
  { table: 'hostedProjects', path: 'exchangeCleanupDone' },
  { table: 'hostedProjects', path: 'work.intentMigration' },
  { table: 'projectBackups', path: 'metadataPublication' },
  { table: 'projectBackups', path: 'ownerDerived' },
];
// One CLI read returns at most this many rows. A full page is treated as truncated, never as complete.
export const READ_CAP = 20000;
export const MANIFEST = 'manifest.json';
const FORMAT = 1;

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const lineOf = row => JSON.stringify(row);
const stable = row => {
  const { _creationTime, ...rest } = row;
  return JSON.stringify(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)));
};

export function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw failure('TABLE_READ_INVALID');
    }
  }
  return rows;
}

export async function readTable(runner, table, cap = READ_CAP) {
  const rows = parseRows(await runner.data(table, cap));
  if (rows.length >= cap) throw failure('TABLE_TRUNCATED');
  const bytes = rows.reduce((total, row) => total + Buffer.byteLength(lineOf(row)), 0);
  return { rows, bytes };
}

const present = (row, path) => path.split('.').reduce((value, key) => value?.[key], row) !== undefined;

export async function inventory(runner, cap = READ_CAP) {
  const tables = {};
  for (const table of Object.keys(RETIRED_TABLES)) {
    const { rows, bytes } = await readTable(runner, table, cap);
    tables[table] = { rows: rows.length, bytes };
  }
  const cache = new Map();
  const fields = [];
  for (const { table, path } of REPORT_ONLY_FIELDS) {
    if (!cache.has(table)) cache.set(table, (await readTable(runner, table, cap)).rows);
    const rows = cache.get(table);
    fields.push({ table, path, scanned: rows.length, rows: rows.filter(row => present(row, path)).length });
  }
  return { tables, fields };
}

export async function exportTables(runner, directory, { deployment, now = new Date(), cap = READ_CAP }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tables = {};
  for (const table of Object.keys(RETIRED_TABLES)) {
    const { rows, bytes } = await readTable(runner, table, cap);
    const text = rows.map(row => `${lineOf(row)}\n`).join('');
    // wx: an export never overwrites an earlier archive.
    await writeFile(join(directory, `${table}.jsonl`), text, { flag: 'wx', mode: 0o600 });
    tables[table] = { rows: rows.length, bytes, sha256: sha256(text) };
  }
  const manifest = {
    format: FORMAT,
    kind: 'forge-retired-tables',
    createdAt: now.toISOString(),
    deploymentDigest: sha256(deployment),
    tables,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(directory, MANIFEST), text, { flag: 'wx', mode: 0o600 });
  return { manifestSha256: sha256(text), manifest };
}

/** Re-hashes every archived file against the manifest; throws on any difference. */
export async function verifyExport(directory) {
  let text;
  try {
    text = await readFile(join(directory, MANIFEST), 'utf8');
  } catch {
    throw failure('EXPORT_MISSING');
  }
  const manifest = JSON.parse(text);
  if (manifest.format !== FORMAT || manifest.kind !== 'forge-retired-tables') throw failure('EXPORT_INVALID');
  const rows = {};
  for (const table of Object.keys(RETIRED_TABLES)) {
    const entry = manifest.tables?.[table];
    if (!entry) throw failure('EXPORT_INVALID');
    let body;
    try {
      body = await readFile(join(directory, `${table}.jsonl`), 'utf8');
    } catch {
      throw failure('EXPORT_MISSING');
    }
    rows[table] = parseRows(body);
    if (sha256(body) !== entry.sha256 || rows[table].length !== entry.rows)
      throw failure('EXPORT_CHECKSUM_MISMATCH');
  }
  return { manifest, manifestSha256: sha256(text), rows };
}

/** Imports an export into a scratch deployment (never the source) and proves the rows came back. */
export async function restoreTables(runner, directory, { deployment, cap = READ_CAP }) {
  const { manifest, rows } = await verifyExport(directory);
  if (sha256(deployment) === manifest.deploymentDigest) throw failure('RESTORE_TARGET_IS_SOURCE');
  for (const table of Object.keys(RETIRED_TABLES))
    if ((await readTable(runner, table, cap)).rows.length) throw failure('RESTORE_TARGET_NOT_EMPTY');
  const restored = {};
  for (const table of Object.keys(RETIRED_TABLES)) {
    if (rows[table].length) await runner.importTable(table, join(directory, `${table}.jsonl`), 'append');
    const back = (await readTable(runner, table, cap)).rows;
    const want = new Set(rows[table].map(stable));
    if (back.length !== rows[table].length || back.some(row => !want.has(stable(row))))
      throw failure('RESTORE_MISMATCH');
    restored[table] = back.length;
  }
  return { restored };
}
