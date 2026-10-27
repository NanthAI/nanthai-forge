// SPDX-License-Identifier: Apache-2.0
'use node';
import { gzipSync, gunzipSync } from 'node:zlib';
import { invariant } from '../src/errors';

const headerBytes = 16,
  memberLimit = 0xffffffff;
const magic = Buffer.from('FWMD');
export type WorkMetadataBytes = { manifest: Uint8Array; work: Uint8Array };

// Rebuildable versioned derivative; both metadata members remain original bytes.
// This envelope changes neither the authoritative archive nor the Work format.
export function encodeWorkMetadataSidecar(value: WorkMetadataBytes): Blob {
  invariant(
    value.manifest.byteLength <= memberLimit && value.work.byteLength <= memberLimit,
    'INVALID_WORK_BACKUP',
    'Archive metadata exceeds the sidecar unsigned 32-bit length representation.',
  );
  const header = Buffer.alloc(headerBytes);
  magic.copy(header);
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(value.manifest.byteLength, 8);
  header.writeUInt32BE(value.work.byteLength, 12);
  return new Blob([new Uint8Array(gzipSync(Buffer.concat([header, value.manifest, value.work])))], {
    type: 'application/gzip',
  });
}

export function decodeWorkMetadataSidecar(bytes: Uint8Array): WorkMetadataBytes {
  let value: Buffer;
  try {
    value = gunzipSync(bytes, { maxOutputLength: memberLimit });
  } catch {
    invariant(false, 'INVALID_WORK_BACKUP', 'Derived source and Work metadata are unavailable or invalid.');
  }
  invariant(
    value!.byteLength >= headerBytes && value!.subarray(0, 4).equals(magic) && value!.readUInt32BE(4) === 2,
    'INVALID_WORK_BACKUP',
    'Derived source and Work metadata have an unsupported format.',
  );
  const manifestBytes = value!.readUInt32BE(8),
    workBytes = value!.readUInt32BE(12);
  invariant(
    manifestBytes <= memberLimit &&
      workBytes <= memberLimit &&
      value!.byteLength === headerBytes + manifestBytes + workBytes,
    'INVALID_WORK_BACKUP',
    'Derived source and Work metadata differ from their original length pins.',
  );
  return {
    manifest: value!.subarray(headerBytes, headerBytes + manifestBytes),
    work: value!.subarray(headerBytes + manifestBytes),
  };
}
