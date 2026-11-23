// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { gzipSync, gunzipSync } from 'node:zlib';
import type { LandingCapsulePointer } from './hosted-landing.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './state/hash.js';
import { ForgeError, invariant } from './errors.js';

/** Node complete-object codec for journal segments (landing capsules use convex/projectLandingCapsuleCodec). */
export function encodeArchiveBytes(text: string, version: number, tables: unknown) {
  const body = gzipSync(text, { level: 9 });
  const pointer: LandingCapsulePointer = {
    protocol: 1,
    sha256: digest(body),
    size: body.length,
    rawSize: Buffer.byteLength(text),
    version,
    tables: canonicalPayload(tables),
  };
  return { body, pointer, logicalBytes: Buffer.byteLength(text) };
}

export function decodeArchiveBytes(body: Uint8Array, pointer: LandingCapsulePointer) {
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
  return plain.toString('utf8');
}
