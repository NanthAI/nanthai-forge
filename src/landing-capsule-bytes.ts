// SPDX-License-Identifier: Apache-2.0
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  landingCapsuleText,
  landingCapsuleTablePins,
  readLandingCapsule,
  type LandingCapsule,
} from './landing-capsule.js';
import type { LandingCapsulePointer } from './hosted-landing.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './state/hash.js';
import { ForgeError, invariant } from './errors.js';

export function encodeLandingCapsule(value: LandingCapsule) {
  const text = landingCapsuleText(value),
    body = gzipSync(text, { level: 9 });
  const pointer: LandingCapsulePointer = {
    protocol: 1,
    sha256: digest(body),
    size: body.length,
    rawSize: Buffer.byteLength(text),
    version: value.anchor.version,
    tables: canonicalPayload(landingCapsuleTablePins(value.tables)),
  };
  return { body, pointer, logicalBytes: Buffer.byteLength(text) };
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
    Number.isSafeInteger(pointer.rawSize) && pointer.rawSize >= 0,
    'EVIDENCE_CHANGED',
    'Landing capsule decoded size is invalid.',
  );
  let plain: Buffer;
  try {
    plain = gunzipSync(body, { maxOutputLength: pointer.rawSize });
  } catch {
    throw new ForgeError(
      'EVIDENCE_CHANGED',
      'Stored landing capsule cannot be decoded at its verified size.',
    );
  }
  invariant(plain.length === pointer.rawSize, 'EVIDENCE_CHANGED', 'Landing capsule decoded size differs.');
  return readLandingCapsule(plain.toString('utf8'), pointer, projectId, submissionId);
}
