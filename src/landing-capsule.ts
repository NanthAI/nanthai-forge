// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  LANDING_CAPSULE_TABLES,
  hostedLandingStateSchema,
  type LandingCapsulePointer,
} from './hosted-landing.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './state/hash.js';
import { invariant } from './errors.js';

const table = z.enum(LANDING_CAPSULE_TABLES);
const schema = z
  .object({
    protocol: z.literal(1),
    projectId: z.string(),
    submissionId: z.string(),
    anchor: hostedLandingStateSchema,
    tables: z.partialRecord(table, z.array(z.string())),
  })
  .strict();
export type LandingCapsule = z.infer<typeof schema>;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Hash the original canonical row strings, before any viewer-dependent projection. */
export function landingCapsuleTablePins(tables: LandingCapsule['tables']) {
  return LANDING_CAPSULE_TABLES.flatMap((name, index) => {
    const rows = tables[name] ?? [];
    return rows.length
      ? [[index, rows.length, rows.reduce((n, row) => n + bytes(row), 0), digest(canonicalPayload(rows))]]
      : [];
  });
}

export function landingCapsuleText(input: LandingCapsule) {
  const parsed = schema.safeParse(input);
  invariant(parsed.success, 'EVIDENCE_CHANGED', 'Landing capsule metadata is invalid.');
  const value = parsed.data;
  invariant(
    value.anchor.projectId === value.projectId && value.anchor.id === value.submissionId,
    'EVIDENCE_CHANGED',
    'Capsule anchor differs from its landing.',
  );
  for (const [name, rows] of Object.entries(value.tables)) {
    const ids = new Set<string>();
    for (const text of rows!) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(text);
      } catch {
        invariant(false, 'EVIDENCE_CHANGED', 'Capsule row JSON is invalid.');
      }
      invariant(
        row !== null && typeof row === 'object' && !Array.isArray(row),
        'EVIDENCE_CHANGED',
        'Capsule row metadata is invalid.',
      );
      invariant(
        typeof row._id === 'string' &&
          !ids.has(row._id) &&
          (name === 'legacyStorageCleanupPages' || row.projectId === value.projectId),
        'EVIDENCE_CHANGED',
        'Capsule rows differ from their project or repeat an identity.',
      );
      ids.add(row._id as string);
      invariant(
        name !== 'projectHostedCheckCallbacks' || !String(row.eventId).startsWith('reuse:'),
        'EVIDENCE_CHANGED',
        'Check reuse aliases must remain transactional.',
      );
    }
  }
  return canonicalPayload(value);
}

export function readLandingCapsule(
  text: string,
  pointer: Pick<LandingCapsulePointer, 'version'> &
    Partial<Pick<LandingCapsulePointer, 'tables' | 'tablesDigest'>>,
  projectId: string,
  submissionId: string,
) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    invariant(false, 'EVIDENCE_CHANGED', 'Landing capsule JSON is invalid.');
  }
  const parsed = schema.safeParse(decoded);
  invariant(parsed.success, 'EVIDENCE_CHANGED', 'Landing capsule metadata is invalid.');
  const value = parsed.data;
  invariant(
    value.projectId === projectId &&
      value.submissionId === submissionId &&
      value.anchor.version === pointer.version &&
      landingCapsuleText(value) === text &&
      digest(canonicalPayload(landingCapsuleTablePins(value.tables))) ===
        (pointer.tablesDigest ?? digest(pointer.tables ?? '')),
    'EVIDENCE_CHANGED',
    'Landing capsule or its per-table digests differ from the verified pointer.',
  );
  return value;
}
