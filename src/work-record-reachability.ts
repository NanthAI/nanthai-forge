import { hostname } from 'node:os';
import { processAlive } from './local-process.js';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readSource } from './files.js';
import { invariant } from './errors.js';
import { recordManifest, recordObject, readWorkFile, type RecordCollection } from './work-records.js';
import { RETENTION_MS } from './clean-retention.js';
import type { WorkStore } from './work-store.js';

const hash = /^[0-9a-f]{64}$/;
export type RecordRoots = {
  kept: Map<string, Set<string>>;
  metadata: string[];
  details: Map<string, { sha256: string; size: number }>;
};
/** Mark exact record links; opaque extension pins are conservatively retained too.
 * Source hashes are never opened or collected by this walker. */
export function recordRoots(store: WorkStore, available: Set<string>, now = Date.now()): RecordRoots {
  const kept = new Map<string, Set<string>>(),
    metadata: string[] = [],
    details = new Map<string, { sha256: string; size: number }>();
  function mark(id: string, reason: string, required = false) {
    if (!available.has(id) && !required) return;
    const reasons = kept.get(id) ?? new Set<string>();
    if (reasons.has(reason)) return;
    reasons.add(reason);
    kept.set(id, reasons);
    visit(recordObject(store.directory, id), reason, true);
  }
  function collection(value: RecordCollection, reason: string) {
    for (const id of value.pages) mark(id, reason, true);
    if (value.lookup) mark(value.lookup, reason, true);
  }
  function visit(value: unknown, reason: string, object = false) {
    if (typeof value === 'string') {
      // Includes exact IDs and file pins such as records/<id>.
      for (const id of value.match(/[0-9a-f]{64}/g) ?? []) mark(id, reason);
    } else if (Array.isArray(value)) {
      for (const child of value) {
        if (object && typeof child === 'string' && hash.test(child)) mark(child, reason, true);
        else visit(child, reason);
      }
    } else if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>,
        manifest = recordManifest(value);
      for (const field of ['detailRef', 'resultRef']) {
        const pin = row[field] as { sha256?: unknown; size?: unknown } | undefined;
        if (
          pin &&
          typeof pin.sha256 === 'string' &&
          hash.test(pin.sha256) &&
          typeof pin.size === 'number' &&
          Number.isSafeInteger(pin.size) &&
          pin.size >= 0
        )
          details.set(pin.sha256, { sha256: pin.sha256, size: pin.size });
      }
      if (manifest) {
        for (const index of Object.values(manifest.collections)) collection(index, reason);
        visit(manifest.fields, reason);
      } else if (row.kind === 'forge-work-record-v2') {
        for (const index of Object.values(row.arrays as Record<string, RecordCollection>))
          collection(index, reason);
        visit(row.fields, reason);
      } else if (object && row.branches && typeof row.branches === 'object') {
        for (const id of Object.values(row.branches)) {
          invariant(
            typeof id === 'string' && hash.test(id),
            'INVALID_WORK_STORE',
            'Invalid Work lookup link.',
          );
          mark(id, reason, true);
        }
      } else for (const child of Object.values(row)) visit(child, reason);
    }
  }
  const pointer = readWorkFile(store.directory);
  invariant(pointer, 'INVALID_WORK_STORE', 'Work pointer is unavailable.');
  const current = JSON.parse(pointer.toString());
  visit(current, 'current Work pointer/revision');
  // Existing auto-snapshots contain only source pins. If a retained snapshot has
  // Work-page pins, retain those as well; old closed snapshots have the same
  // seven-day expiry as source snapshot collection.
  function snapshot(value: unknown): string | undefined {
    const row = value as { laneId?: string; at?: string };
    if (!row?.laneId) return 'Lane snapshot (unknown lifecycle)';
    const lane = store.select('lanes', row.laneId);
    if (!lane || !['completed', 'abandoned'].includes(lane.state)) return 'open Lane latest snapshot';
    const closed = lane.lifecycle?.at(-1);
    const at = Math.max(Date.parse(row.at ?? ''), Date.parse(closed?.at ?? row.at ?? ''));
    return !Number.isFinite(at) || (closed && closed.to !== lane.state) || now - at <= RETENTION_MS
      ? 'Lane snapshot within seven-day retention'
      : undefined;
  }
  function walk(directory: string, backup = false, root = store.directory, label = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        name = relative(root, path);
      if (entry.isSymbolicLink()) {
        invariant(
          false,
          'INVALID_WORK_STORE',
          `Cannot establish record references through metadata symlink: ${name}`,
        );
      }
      if (entry.isDirectory()) {
        if (/^(?:records|objects|lane-.*|check-.*|lock.*|.*-queue|node_modules|\.git)$/.test(entry.name))
          continue;
        walk(path, backup || /backup/.test(entry.name), root, label);
      } else if (entry.isFile() && entry.name.endsWith('.json') && name !== 'work.json') {
        if (name === 'record-collection-backups.json') continue;
        const bytes = readSource(root, name, Number.MAX_SAFE_INTEGER);
        invariant(bytes, 'INVALID_WORK_STORE', `Record reference metadata is unreadable: ${name}`);
        let value: unknown;
        try {
          value = JSON.parse(bytes.toString());
        } catch {
          invariant(false, 'INVALID_WORK_STORE', `Record reference metadata is invalid: ${name}`);
        }
        if (name.startsWith('record-staging/')) {
          if (
            (value as { host?: string }).host !== hostname() ||
            processAlive(value as Parameters<typeof processAlive>[0])
          ) {
            for (const id of available) mark(id, `pending record writer: ${name}`);
            visit(value, `pending detail writer: ${name}`);
          }
          continue;
        }
        const reason = backup
          ? `kept backup: ${label}${name}`
          : name.startsWith('auto-snapshots/')
            ? snapshot(value)
            : `pending journal/operation: ${name}`;
        if (reason) {
          visit(value, reason);
          metadata.push(name);
        }
      }
    }
  }
  walk(store.directory);
  // Full-directory backups are independent copies. Their record closure remains
  // protected in the owner too, until the backup is explicitly removed.
  const registry = readSource(store.directory, 'record-collection-backups.json', Number.MAX_SAFE_INTEGER);
  if (registry) {
    const entries = JSON.parse(registry.toString()) as { path: string }[];
    for (const entry of entries) {
      if (!existsSync(entry.path)) continue;
      invariant(
        lstatSync(entry.path).isDirectory() && !lstatSync(entry.path).isSymbolicLink(),
        'INVALID_WORK_STORE',
        'Record backup must be a real directory.',
      );
      const bytes = readWorkFile(join(entry.path, '.forge/work'));
      invariant(bytes, 'INVALID_WORK_STORE', 'Kept backup has no Work pointer.');
      visit(JSON.parse(bytes.toString()), `kept backup: ${entry.path}`);
      const directory = join(entry.path, '.forge/work');
      walk(directory, true, directory, `${entry.path}/`);
    }
  }
  return { kept, metadata, details };
}
