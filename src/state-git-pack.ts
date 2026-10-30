// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { invariant } from './errors.js';
import { gitObjectId, type GitObject, type GitObjectType } from './state-git.js';

/** Git pack format version 2 with whole (deflated, non-delta) objects only, so
 * a pack is readable by Git itself and can be sent to `git-receive-pack`. */
const types: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };
const names = new Map(Object.entries(types).map(([name, code]) => [code, name as GitObjectType]));

export function writeGitPack(objects: Iterable<GitObject>): Buffer {
  const header = Buffer.alloc(12),
    parts: Buffer[] = [header];
  let count = 0;
  for (const { type, bytes } of objects) {
    let size = bytes.length,
      byte = (types[type] << 4) | (size & 0x0f);
    const head: number[] = [];
    for (size >>>= 4; size; size >>>= 7) {
      head.push(byte | 0x80);
      byte = size & 0x7f;
    }
    head.push(byte);
    parts.push(Buffer.from(head), deflateSync(bytes));
    count++;
  }
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Every object in a pack, keyed by its Git object ID. Deltas, tags, a bad
 * trailer or any byte outside an object fail closed. */
export function readGitPack(bytes: Uint8Array): Map<string, GitObject> {
  const pack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    end = pack.length - 20;
  const fail: (condition: unknown) => asserts condition = condition =>
    invariant(condition, 'GIT_OBJECT_INVALID', 'A Git pack is invalid.');
  fail(end >= 12 && pack.toString('latin1', 0, 4) === 'PACK' && pack.readUInt32BE(4) === 2);
  fail(createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end)));
  const objects = new Map<string, GitObject>(),
    count = pack.readUInt32BE(8);
  let at = 12;
  for (let index = 0; index < count; index++) {
    fail(at < end);
    let byte = pack.readUInt8(at++),
      size = byte & 0x0f,
      shift = 4;
    const type = names.get((byte >> 4) & 0x07);
    while (byte & 0x80) {
      fail(at < end && shift <= 28);
      byte = pack.readUInt8(at++);
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    fail(type);
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(pack.subarray(at, end), {
        info: true,
        maxOutputLength: size + 1,
      }) as unknown as typeof inflated;
    } catch {
      fail(false);
    }
    fail(inflated.buffer.length === size && inflated.engine.bytesWritten > 0);
    at += inflated.engine.bytesWritten;
    objects.set(gitObjectId(type, inflated.buffer), { type, bytes: inflated.buffer });
  }
  fail(at === end);
  return objects;
}
