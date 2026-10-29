// SPDX-License-Identifier: Apache-2.0
import { _SHA256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { invariant } from './errors.js';
export type SourceHashState = { words: number[]; buffer: number[]; length: number; pos: number };
/** Pinned noble 2.0.1 SHA-256 state, stored only in trusted execution progress.
 * Persist the partial block as well as the chaining words, including empty input. */
export class SourceStepHash extends _SHA256 {
  constructor(state?: SourceHashState) {
    super();
    if (state) {
      invariant(
        state.words.length === 8 &&
          state.buffer.length === 64 &&
          state.pos >= 0 &&
          state.pos < 64 &&
          Number.isSafeInteger(state.length) &&
          state.length >= 0 &&
          state.length % 64 === state.pos,
        'SOURCE_JOB_INVALID',
        'Invalid durable source hash progress.',
      );
      this.set(...(state.words as [number, number, number, number, number, number, number, number]));
      this.buffer.set(state.buffer);
      this.length = state.length;
      this.pos = state.pos;
    }
  }
  snapshot(): SourceHashState {
    return { words: this.get(), buffer: [...this.buffer], length: this.length, pos: this.pos };
  }
  hex() {
    return bytesToHex(this.digest());
  }
}
