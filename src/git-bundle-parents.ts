// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { applyGitDelta } from './git-pack-delta.js';
import { invariant } from './errors.js';
type ObjectNode = {
  offset: number;
  type?: number;
  oid?: string;
  bytes?: Buffer;
  baseOffset?: number;
  baseId?: string;
};
/** Inert bundle/pack reader. It retains commit bytes only and never invokes Git,
 * hooks, repository configuration, or executable source. The pack trailer and
 * each recovered commit identity bind parent data to the stored source bytes.
 * Formats: https://git-scm.com/docs/gitformat-pack and gitformat-bundle. */
export function gitBundleParents(bytes: Buffer, format: 'sha1' | 'sha256'): Map<string, string[]> {
  const split = bytes.indexOf('\n\n'),
    width = format === 'sha1' ? 20 : 32;
  invariant(split > 0, 'INVALID_GIT_BUNDLE', 'Git bundle header is incomplete.');
  const header = bytes.subarray(0, split).toString('utf8').split('\n');
  invariant(
    header[0] === '# v2 git bundle' || header[0] === '# v3 git bundle',
    'INVALID_GIT_BUNDLE',
    'Git bundle version is unavailable.',
  );
  const declared = header.find(line => line.startsWith('@object-format='))?.slice(15) ?? 'sha1';
  invariant(declared === format, 'INVALID_GIT_BUNDLE', 'Git bundle object format differs.');
  const pack = bytes.subarray(split + 2),
    end = pack.length - width;
  invariant(
    end >= 12 && pack.subarray(0, 4).toString() === 'PACK' && [2, 3].includes(pack.readUInt32BE(4)),
    'INVALID_GIT_BUNDLE',
    'Git pack header is invalid.',
  );
  invariant(
    createHash(format).update(pack.subarray(0, end)).digest().equals(pack.subarray(end)),
    'INVALID_GIT_BUNDLE',
    'Git pack checksum differs.',
  );
  const nodes: ObjectNode[] = [],
    byOffset = new Map<number, ObjectNode>(),
    byId = new Map<string, ObjectNode>();
  const waitingOffsets = new Map<number, ObjectNode[]>(),
    waitingIds = new Map<string, ObjectNode[]>();
  const parents = new Map<string, string[]>();
  let position = 12;
  const byte = () => {
    invariant(position < end, 'INVALID_GIT_BUNDLE', 'Git pack object is incomplete.');
    return pack[position++]!;
  };
  const identify = (node: ObjectNode, content: Buffer) => {
    const type = ['', 'commit', 'tree', 'blob', 'tag'][node.type!]!;
    node.oid = createHash(format).update(`${type} ${content.length}\0`).update(content).digest('hex');
    byId.set(node.oid, node);
    if (node.type === 1) {
      node.bytes = content;
      const fields = content
        .subarray(0, content.indexOf('\n\n') < 0 ? content.length : content.indexOf('\n\n'))
        .toString('utf8')
        .split('\n');
      invariant(
        new RegExp(`^tree [a-f0-9]{${width * 2}}$`).test(fields[0] ?? ''),
        'INVALID_GIT_BUNDLE',
        'Git commit tree identity is invalid.',
      );
      const ids = fields.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
      invariant(
        ids.every(id => new RegExp(`^[a-f0-9]{${width * 2}}$`).test(id)),
        'INVALID_GIT_BUNDLE',
        'Git commit parent identity is invalid.',
      );
      parents.set(node.oid, ids);
    }
  };
  for (let index = 0, count = pack.readUInt32BE(8); index < count; index++) {
    const offset = position,
      first = byte(),
      type = (first >> 4) & 7;
    invariant([1, 2, 3, 4, 6, 7].includes(type), 'INVALID_GIT_BUNDLE', 'Git pack object type is invalid.');
    let size = first & 15,
      part = first,
      shift = 4;
    while (part & 128) {
      part = byte();
      size += (part & 127) * 2 ** shift;
      shift += 7;
      invariant(
        Number.isSafeInteger(size) && shift <= 60,
        'INVALID_GIT_BUNDLE',
        'Git pack object size is invalid.',
      );
    }
    const node: ObjectNode = { offset };
    if (type === 6) {
      part = byte();
      let distance = part & 127;
      while (part & 128) {
        part = byte();
        distance = (distance + 1) * 128 + (part & 127);
        invariant(Number.isSafeInteger(distance), 'INVALID_GIT_BUNDLE', 'Git delta offset is invalid.');
      }
      invariant(
        distance > 0 && distance <= offset - 12,
        'INVALID_GIT_BUNDLE',
        'Git delta base offset is outside its pack.',
      );
      node.baseOffset = offset - distance;
      invariant(
        byOffset.has(node.baseOffset),
        'INVALID_GIT_BUNDLE',
        'Git delta does not name a previous object.',
      );
    } else if (type === 7) {
      invariant(position + width <= end, 'INVALID_GIT_BUNDLE', 'Git delta base identity is incomplete.');
      node.baseId = pack.subarray(position, position + width).toString('hex');
      position += width;
    }
    // info exposes compressed bytes consumed, excluding subsequent objects.
    const decoded = inflateSync(pack.subarray(position, end), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    invariant(
      decoded.buffer.length === size &&
        decoded.engine.bytesWritten > 0 &&
        position + decoded.engine.bytesWritten <= end,
      'INVALID_GIT_BUNDLE',
      'Git pack object size differs.',
    );
    position += decoded.engine.bytesWritten;
    if (type < 5) {
      node.type = type;
      identify(node, decoded.buffer);
    } else node.bytes = decoded.buffer;
    byOffset.set(offset, node);
    nodes.push(node);
  }
  invariant(position === end, 'INVALID_GIT_BUNDLE', 'Git pack coverage differs from its header.');
  for (const node of nodes)
    if (!node.type) {
      const key = node.baseId ?? node.baseOffset!;
      // Separate maps retain precise string/object and numeric/offset identities.
      if (typeof key === 'string') {
        const list = waitingIds.get(key) ?? [];
        list.push(node);
        waitingIds.set(key, list);
      } else {
        const list = waitingOffsets.get(key) ?? [];
        list.push(node);
        waitingOffsets.set(key, list);
      }
    }
  const queue = nodes.filter(node => node.type !== undefined);
  for (let i = 0; i < queue.length; i++) {
    const base = queue[i]!;
    const children = [
      ...(waitingOffsets.get(base.offset) ?? []),
      ...(base.oid ? (waitingIds.get(base.oid) ?? []) : []),
    ];
    for (const node of children) {
      if (node.type !== undefined) continue;
      node.type = base.type!;
      if (base.type === 1) identify(node, applyGitDelta(base.bytes!, node.bytes!));
      else delete node.bytes; // Non-commit deltas cannot add commit parent relationships.
      queue.push(node);
    }
  }
  // Missing external/thin bases stay absent: membership is unknown when a
  // selected commit or any of its parents is not present in this map.
  return parents;
}
