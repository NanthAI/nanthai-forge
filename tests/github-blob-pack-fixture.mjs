// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { writeGitPack } from '../dist/state/git-pack.js';
import { pktLine } from '../dist/git-upload-pack.js';
export function blobPackResponse(bytes) {
  const pack = Buffer.isBuffer(bytes) ? bytes : writeGitPack(bytes.map(bytes => ({ type: 'blob', bytes })));
  const packets = [Buffer.from(pktLine('packfile\n'))];
  for (let at = 0; at < pack.length; at += 60000) {
    const data = Buffer.concat([Buffer.from([1]), pack.subarray(at, at + 60000)]);
    packets.push(Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data);
  }
  return new Response(Buffer.concat([...packets, Buffer.from('0000')]));
}
export function wantedBlobResponse(init, bodies) {
  const wants = [
    ...Buffer.from(init.body)
      .toString()
      .matchAll(/want ([0-9a-f]{40})/g),
  ].map(m => m[1]);
  return blobPackResponse([...new Set(wants)].map(sha => bodies.get(sha)));
}

/** A large whole blob response with no whole-blob or whole-pack allocation. */
export function streamedBlobResponse(size, source) {
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(1, 8);
  const object = [];
  let byte = 0x30 | (size & 15);
  for (size = Math.floor(size / 16); size; size = Math.floor(size / 128)) {
    object.push(byte | 128);
    byte = size & 127;
  }
  object.push(byte);
  async function* pack() {
    const hash = createHash('sha1'),
      head = Buffer.concat([header, Buffer.from(object)]);
    hash.update(head);
    yield head;
    for await (const part of source.pipeThrough(new CompressionStream('deflate'))) {
      hash.update(part);
      yield part;
    }
    yield hash.digest();
  }
  async function* frames() {
    yield pktLine('packfile\n');
    for await (const value of pack())
      for (let at = 0; at < value.length; at += 60000) {
        const data = Buffer.concat([Buffer.from([1]), value.subarray(at, at + 60000)]);
        yield Buffer.from((data.length + 4).toString(16).padStart(4, '0'));
        yield data;
      }
    yield Buffer.from('0000');
  }
  return new Response(ReadableStream.from(frames()));
}
