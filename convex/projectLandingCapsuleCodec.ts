// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { gzipSync, gunzipSync } from 'fflate';
import {
  landingCapsuleText,
  landingCapsuleTablePins,
  readLandingCapsule,
  type LandingCapsule,
} from '../src/landing-capsule';
import type { LandingCapsulePointer } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { ForgeError, invariant } from '../src/errors';

/** Runtime-portable landing capsule codec (Convex V8 and Node actions; not packaged with the CLI). Standard gzip, so objects written by
 * the earlier Node zlib writer decode unchanged. A zero mtime keeps equal text at one content pin. */
export function encodeLandingCapsule(value: LandingCapsule) {
  const text = landingCapsuleText(value),
    plain = new TextEncoder().encode(text);
  const body = gzipSync(plain, { level: 9, mtime: 0 });
  const pointer: LandingCapsulePointer = {
    protocol: 1,
    sha256: digest(body),
    size: body.length,
    rawSize: plain.length,
    version: value.anchor.version,
    tables: canonicalPayload(landingCapsuleTablePins(value.tables)),
  };
  return { body, pointer, logicalBytes: plain.length };
}

export function decodeLandingCapsule(
  body: Uint8Array,
  pointer: LandingCapsulePointer,
  projectId: string,
  submissionId: string,
) {
  invariant(
    body.length === pointer.size && digest(body) === pointer.sha256,
    'EVIDENCE_CHANGED',
    'Stored landing capsule differs from its verified content pin.',
  );
  invariant(
    Number.isSafeInteger(pointer.rawSize) && pointer.rawSize >= 0 && body.length >= 18,
    'EVIDENCE_CHANGED',
    'Landing capsule decoded size is invalid.',
  );
  // The gzip trailer records the decoded size; the output buffer is bounded by the verified pin.
  const trailer = new DataView(body.buffer, body.byteOffset, body.length).getUint32(body.length - 4, true);
  invariant(
    trailer === pointer.rawSize % 2 ** 32,
    'EVIDENCE_CHANGED',
    'Landing capsule decoded size differs.',
  );
  let plain: Uint8Array;
  try {
    plain = gunzipSync(body, { out: new Uint8Array(pointer.rawSize) });
  } catch {
    throw new ForgeError(
      'EVIDENCE_CHANGED',
      'Stored landing capsule cannot be decoded at its verified size.',
    );
  }
  invariant(plain.length === pointer.rawSize, 'EVIDENCE_CHANGED', 'Landing capsule decoded size differs.');
  return readLandingCapsule(new TextDecoder().decode(plain), pointer, projectId, submissionId);
}
