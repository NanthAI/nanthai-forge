// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { gzipSync, gunzipSync } from 'fflate';
import { canonicalPayload } from '../src/hosted-source-operation';
import { journalTablePins, type JournalSegment } from '../src/journal-segment';
import { digest } from '../src/state/hash';
import { ForgeError, invariant } from '../src/errors';
import type { LandingCapsulePointer } from '../src/hosted-landing';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { phaseKey, receiptRow, type Control } from './projectJournalMaintenance';
import { recordHead } from './projectHostedRecords';
import { intentBelongsToItem } from './projectItemIntentHeads';

export const journalObjectKey = (projectId: string, sha256: string) =>
  `v1/p/${projectId}/journal-segments/${sha256}`;

/** Runtime-portable journal codec (Convex V8 and Node). Standard gzip with a zero mtime, so equal text
 * keeps one content pin, and the capture can pin Intent archive bytes before its action uploads them. */
export function encodePlannedJournal(text: string, segment: JournalSegment) {
  const plain = new TextEncoder().encode(text);
  const body = gzipSync(plain, { level: 9, mtime: 0 });
  const pointer = {
    protocol: 1 as const,
    sha256: digest(body),
    size: body.length,
    rawSize: plain.length,
    version: segment.through,
    tables: canonicalPayload(journalTablePins(segment.tables)),
  };
  return { body, pointer };
}

/** Verified decode bounded by the content pin; objects from the earlier Node zlib writer decode unchanged. */
export function decodeJournalBytes(body: Uint8Array, pointer: LandingCapsulePointer) {
  invariant(
    body.length === pointer.size && digest(body) === pointer.sha256,
    'EVIDENCE_CHANGED',
    'Stored journal segment differs from its verified content pin.',
  );
  invariant(
    Number.isSafeInteger(pointer.rawSize) && pointer.rawSize >= 0 && body.length >= 18,
    'EVIDENCE_CHANGED',
    'Journal segment decoded size is invalid.',
  );
  const trailer = new DataView(body.buffer, body.byteOffset, body.length).getUint32(body.length - 4, true);
  invariant(
    trailer === pointer.rawSize % 2 ** 32,
    'EVIDENCE_CHANGED',
    'Journal segment decoded size differs.',
  );
  let plain: Uint8Array;
  try {
    plain = gunzipSync(body, { out: new Uint8Array(pointer.rawSize) });
  } catch {
    throw new ForgeError(
      'EVIDENCE_CHANGED',
      'Stored journal segment cannot be decoded at its verified size.',
    );
  }
  invariant(plain.length === pointer.rawSize, 'EVIDENCE_CHANGED', 'Journal segment decoded size differs.');
  return new TextDecoder().decode(plain);
}

export async function pendingIntentArchives(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  itemId: string,
  legacyKeys?: readonly string[],
) {
  const controls = await Promise.all(
    [false, true].map(existing =>
      receiptRow(ctx, projectId, phaseKey({ projectId, operationId: '', existing })),
    ),
  );
  const pending = controls.flatMap(row => {
    const value = row && (JSON.parse(row.envelope) as Control).pending;
    return value ? [value] : [];
  });
  const related = await Promise.all(
    pending.map(async capture => {
      const keys =
        capture.intentKeys ??
        (
          await Promise.all(
            capture.refs
              .filter(ref => ref.table === 'projectHostedRecords')
              .map(ref => ctx.db.get(ref.id as Id<'projectHostedRecords'>)),
          )
        ).flatMap(row => (row?.kind === 'intent' ? [row.key] : []));
      if (legacyKeys) return keys.some(key => legacyKeys.includes(key));
      for (const key of new Set(keys)) {
        const head = await recordHead(ctx, projectId, 'intent', key);
        if (head && intentBelongsToItem(head, itemId)) return true;
      }
      return false;
    }),
  );
  return pending.flatMap((capture, i) =>
    related[i] ? [{ input: capture.input, availableAt: capture.until }] : [],
  );
}
