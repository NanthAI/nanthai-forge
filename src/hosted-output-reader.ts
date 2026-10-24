// SPDX-License-Identifier: Apache-2.0
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  outputChunkSchema,
  outputStreamId,
  outputSealSchema,
  type OutputChunk,
  type OutputSeal,
  type OutputStream,
} from './hosted-check-output.js';
import { invariant } from './errors.js';

/** Portable reader: one bounded direct download, no refresh/tail/poll timer. */
export function verifyOutputBytes(input: OutputChunk, bytes: Uint8Array) {
  const chunk = outputChunkSchema.parse(input);
  invariant(
    bytes.length === chunk.object.size && bytesToHex(sha256(bytes)) === chunk.object.sha256,
    'R2_OBJECT_CHECKSUM_MISMATCH',
    'Downloaded output differs from its committed chunk.',
  );
  return bytes;
}
/** Full-stream verifier, independent of UTF-8 boundaries or artifact encoding.
 * For reconnect, keep this instance and request only its next sequence/offset.
 * A new instance verifies a full retained stream starting from sequence zero. */
export class HostedOutputReader {
  private readonly hash = sha256.create();
  private readonly streamId: string;
  sequence = 0;
  offset = 0;
  constructor(stream: OutputStream) {
    this.streamId = outputStreamId(stream);
  }
  accept(chunk: OutputChunk, bytes: Uint8Array) {
    invariant(
      outputStreamId(chunk.stream) === this.streamId &&
        chunk.sequence === this.sequence &&
        chunk.offset === this.offset,
      'EVIDENCE_CHANGED',
      'Output has a missing sequence, changed stream or different offset. Recover the exact chunk.',
    );
    verifyOutputBytes(chunk, bytes);
    this.hash.update(bytes);
    this.sequence++;
    this.offset += bytes.length;
    return bytes;
  }
  verifySeal(input: OutputSeal) {
    const seal = outputSealSchema.parse(input);
    invariant(
      outputStreamId(seal.stream) === this.streamId &&
        seal.chunks === this.sequence &&
        seal.bytes === this.offset &&
        seal.sha256 === bytesToHex(this.hash.clone().digest()),
      'EVIDENCE_CHANGED',
      'Retained output is incomplete or its final digest differs.',
    );
  }
}
