// SPDX-License-Identifier: Apache-2.0
import type { NativeSource } from './native-source.js';
import type { WorkData } from './work-types.js';
import { invariant } from './errors.js';
import {
  recoveryRowsSchema,
  recoveryObjectSchema,
  type HostedRecovery,
  type RecoveryTable,
} from './recovery-hosted-protocol.js';

/** Newest pages first; callers page/stream rows instead of assembling tables.
 * Values are the exact canonical hosted documents, including receipt/progress bytes. */
export function* hostedRecoveryRows(source: NativeSource, recovery: HostedRecovery, table?: RecoveryTable) {
  let pin = recovery.pages;
  while (pin) {
    const bytes = source.object(pin.sha256);
    invariant(bytes.length === pin.size, 'INVALID_WORK_BACKUP', 'Hosted recovery page size differs.');
    const page = recoveryRowsSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (!table || table === page.table)
      for (const row of page.rows) yield JSON.parse(row) as Record<string, unknown>;
    pin = page.previous;
  }
}

/** Archive export/restore reuses the existing native object closure. */
export function* hostedRecoveryObjects(source: NativeSource, data: WorkData): Generator<string> {
  const recovery = data.hostedRecovery;
  if (!recovery) return;
  let pin = recovery.pages;
  while (pin) {
    yield pin.sha256;
    const bytes = source.object(pin.sha256);
    invariant(bytes.length === pin.size, 'INVALID_WORK_BACKUP', 'Hosted recovery page size differs.');
    pin = recoveryRowsSchema.parse(JSON.parse(bytes.toString('utf8'))).previous;
  }
  const pending = recovery.objects ? [{ ...recovery.objects, nested: true }] : [];
  // Inventory links are a DAG. Repeated references need no repeated traversal.
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    const identity = `${current.nested ? 'inventory' : 'opaque'}:${current.sha256}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    yield current.sha256;
    const bytes = source.object(current.sha256);
    invariant(bytes.length === current.size, 'INVALID_WORK_BACKUP', 'Hosted recovery object size differs.');
    if (!current.nested) continue;
    let raw;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue;
    }
    if (raw?.kind !== 'forge-hosted-recovery-object') continue;
    const node = recoveryObjectSchema.parse(raw);
    if (node.previous) pending.push({ ...node.previous, nested: true });
    pending.push({ ...node.object, nested: node.nested });
  }
}
