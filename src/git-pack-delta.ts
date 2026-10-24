// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
/** Git pack delta instructions: https://git-scm.com/docs/gitformat-pack */
export function applyGitDelta(base: Buffer, delta: Buffer): Buffer {
  let position = 0;
  const byte = () => {
    invariant(position < delta.length, 'INVALID_GIT_BUNDLE', 'Git delta is incomplete.');
    return delta[position++]!;
  };
  const size = () => {
    let value = 0,
      shift = 0,
      part: number;
    do {
      part = byte();
      value += (part & 127) * 2 ** shift;
      shift += 7;
      invariant(
        Number.isSafeInteger(value) && shift <= 56,
        'INVALID_GIT_BUNDLE',
        'Git delta size is invalid.',
      );
    } while (part & 128);
    return value;
  };
  invariant(size() === base.length, 'INVALID_GIT_BUNDLE', 'Git delta base size differs.');
  const output = Buffer.alloc(size());
  let written = 0;
  while (position < delta.length) {
    const op = byte();
    invariant(op !== 0, 'INVALID_GIT_BUNDLE', 'Git delta instruction is invalid.');
    if (op & 128) {
      let offset = 0,
        count = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (4 + i))) count += byte() * 2 ** (8 * i);
      count ||= 65536;
      invariant(
        offset + count <= base.length && written + count <= output.length,
        'INVALID_GIT_BUNDLE',
        'Git delta copy is outside its source or result.',
      );
      base.copy(output, written, offset, offset + count);
      written += count;
    } else {
      invariant(
        position + op <= delta.length && written + op <= output.length,
        'INVALID_GIT_BUNDLE',
        'Git delta insertion is incomplete.',
      );
      delta.copy(output, written, position, position + op);
      position += op;
      written += op;
    }
  }
  invariant(written === output.length, 'INVALID_GIT_BUNDLE', 'Git delta result size differs.');
  return output;
}
