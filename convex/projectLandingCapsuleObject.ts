// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Runtime-portable: the V8 packer and cold reader and the Node journal share this transport.
import { r2Config, presignGet, presignPut } from './r2';
import { exchangeRequest } from '../src/exchange-request';
import { observeExchangeResponse } from '../src/exchange-observation-hooks';
import { decodeLandingCapsule } from './projectLandingCapsuleCodec';
import type { LandingCapsulePointer } from '../src/hosted-landing';
import type { LandingCapsule } from '../src/landing-capsule';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

const key = (projectId: string, pin: LandingCapsulePointer) =>
  `v1/p/${projectId}/landing-capsules/${pin.sha256}`;
/** A content pin is an integrity bound, never a history quota. */
async function readObject(response: Response, expected: number, progressed: () => void) {
  invariant(response.ok && response.body, 'SOURCE_UNAVAILABLE', 'The stored landing capsule is unavailable.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > expected) await reader.cancel();
      invariant(size <= expected, 'EVIDENCE_CHANGED', 'Landing capsule bytes exceed their verified size.');
      chunks.push(part.value);
      observeExchangeResponse(part.value.length);
      progressed();
    }
  } finally {
    reader.releaseLock();
  }
  invariant(size === expected, 'EVIDENCE_CHANGED', 'Landing capsule bytes differ from their verified size.');
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}
export async function getLandingCapsule(
  projectId: string,
  submissionId: string,
  pointer: LandingCapsulePointer,
  optional = false,
) {
  const body = await getArchiveObject(key(projectId, pointer), pointer, optional);
  return body === null ? null : decodeLandingCapsule(body, pointer, projectId, submissionId);
}
/** Shared private transport; a caller must verify its envelope after byte verification. */
export async function getArchiveObject(
  objectKey: string,
  pointer: LandingCapsulePointer,
  optional = false,
  signal?: AbortSignal,
) {
  invariant(/^[a-f0-9]{64}$/.test(pointer.sha256), 'EVIDENCE_CHANGED', 'Archive content pin is invalid.');
  const url = await presignGet(r2Config(), objectKey);
  const body = await exchangeRequest(
    'Archive read',
    url,
    { headers: { 'accept-encoding': 'identity' }, signal },
    (response, progressed) =>
      optional && response.status === 404
        ? Promise.resolve(null)
        : readObject(response, pointer.size, progressed),
  );
  return body;
}
export async function putArchiveObject(
  objectKey: string,
  encoded: { body: Uint8Array; pointer: LandingCapsulePointer },
  signal?: AbortSignal,
) {
  let stored = await getArchiveObject(objectKey, encoded.pointer, true, signal);
  if (!stored) {
    const target = await presignPut(r2Config(), objectKey, {
      digest: encoded.pointer.sha256,
      size: encoded.pointer.size,
    });
    await exchangeRequest(
      'Archive write',
      target.url,
      { method: 'PUT', headers: target.headers, body: new Uint8Array(encoded.body), signal },
      async response => {
        invariant(
          response.ok || response.status === 412,
          'SOURCE_UNAVAILABLE',
          'Archive write is unavailable.',
        );
      },
      { retries: 0 },
    );
    stored = await getArchiveObject(objectKey, encoded.pointer, false, signal);
  }
  invariant(stored !== null, 'SOURCE_UNAVAILABLE', 'Verified archive bytes are unavailable.');
  return stored;
}
/** An unknown PUT outcome first reconciles by content pin. Healthy packing writes one complete object. */
export async function putLandingCapsule(
  projectId: string,
  submissionId: string,
  encoded: { body: Uint8Array; pointer: LandingCapsulePointer },
  expected: LandingCapsule,
) {
  const body = await putArchiveObject(key(projectId, encoded.pointer), encoded);
  const stored = decodeLandingCapsule(body, encoded.pointer, projectId, submissionId);
  invariant(
    stored.protocol === expected.protocol &&
      stored.projectId === expected.projectId &&
      stored.submissionId === expected.submissionId &&
      canonicalPayload(stored.anchor) === canonicalPayload(expected.anchor) &&
      Object.keys(stored.tables).length === Object.keys(expected.tables).length &&
      Object.entries(expected.tables).every(([table, rows]) => {
        const actual = stored.tables[table as keyof LandingCapsule['tables']];
        return actual?.length === rows.length && rows.every((row, index) => actual[index] === row);
      }),
    'EVIDENCE_CHANGED',
    'Stored capsule rows differ from their original captured bytes.',
  );
}
