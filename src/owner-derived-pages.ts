// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { OWNER_DERIVED_MAX_BYTES } from './owner-derived.js';
const pin = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .safe()
      .positive()
      .max(128 * 1024),
  })
  .strict();
export const ownerDerivedPagesSchema = z
  .object({
    schema: z.literal(3),
    encoding: z.literal('pages'),
    pages: z.array(pin).max(500),
    level: z.number().safe().nonnegative().default(0),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** Page arbitrary UTF-8 bytes; only the assembled document is decoded. */
export function ownerDerivedPages(bytes: Buffer) {
  const objects = new Map<string, Buffer>();
  if (bytes.length <= OWNER_DERIVED_MAX_BYTES) return { root: bytes, objects };
  let nodes: { pin: { sha256: string; size: number }; start: number; end: number }[] = [];
  for (let offset = 0; offset < bytes.length; offset += 128 * 1024) {
    const page = bytes.subarray(offset, offset + 128 * 1024),
      sha256 = digest(page);
    objects.set(sha256, page);
    nodes.push({ pin: { sha256, size: page.length }, start: offset, end: offset + page.length });
  }
  let level = 0;
  while (nodes.length > 500) {
    const next: typeof nodes = [];
    for (let offset = 0; offset < nodes.length; offset += 500) {
      const group = nodes.slice(offset, offset + 500),
        start = group[0]!.start,
        end = group.at(-1)!.end;
      const page = Buffer.from(
          JSON.stringify({
            schema: 3,
            encoding: 'pages',
            level,
            pages: group.map(n => n.pin),
            sha256: digest(bytes.subarray(start, end)),
          }),
        ),
        sha256 = digest(page);
      objects.set(sha256, page);
      next.push({ pin: { sha256, size: page.length }, start, end });
    }
    nodes = next;
    level++;
  }
  return {
    root: Buffer.from(
      JSON.stringify({
        schema: 3,
        encoding: 'pages',
        level,
        pages: nodes.map(n => n.pin),
        sha256: digest(bytes),
      }),
    ),
    objects,
  };
}

export async function resolveOwnerDerived(
  bytes: Buffer,
  read: (pins: { sha256: string; size: number }[]) => Promise<Buffer[]>,
) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.encoding !== 'pages') return value;
  async function decode(value: unknown, expectedLevel?: number): Promise<Buffer> {
    const root = ownerDerivedPagesSchema.parse(value),
      parts: Buffer[] = [];
    invariant(
      expectedLevel === undefined || root.level === expectedLevel,
      'INVALID_OWNER_DATA',
      'Owner display page level changed.',
    );
    for (let offset = 0; offset < root.pages.length; offset += 8) {
      const pins = root.pages.slice(offset, offset + 8),
        batch = await read(pins);
      invariant(batch.length === pins.length, 'INVALID_OWNER_DATA', 'Incomplete owner display page batch.');
      for (const [i, part] of batch.entries()) {
        const pin = pins[i]!;
        invariant(
          part.length === pin.size && digest(part) === pin.sha256,
          'INVALID_OWNER_DATA',
          'Owner display page differs from its hash or size.',
        );
        parts.push(root.level ? await decode(JSON.parse(part.toString('utf8')), root.level - 1) : part);
      }
    }
    const joined = Buffer.concat(parts);
    invariant(digest(joined) === root.sha256, 'INVALID_OWNER_DATA', 'Owner display document hash changed.');
    return joined;
  }
  return JSON.parse((await decode(value)).toString('utf8'));
}
