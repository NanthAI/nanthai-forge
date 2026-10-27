// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './hash.js';
import { ownerDerivedSchema, type OwnerDerived } from './owner-derived.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().safe().nonnegative();
export const displayStatsSchema = z
  .object({
    files: count,
    add: count.optional(),
    del: count.optional(),
  })
  .strict()
  .refine(s => (s.add === undefined) === (s.del === undefined));
export type DisplayStats = z.infer<typeof displayStatsSchema> & {
  provenance: 'owner-reported' | 'server-computed';
  exact: boolean;
};
export const diffstatPageSchema = z
  .object({
    work: hash,
    stats: z.array(z.tuple([z.string().regex(/^[a-f0-9]{64}:[a-f0-9]{64}$/), displayStatsSchema])).max(100),
  })
  .strict();
export const diffstatPagePinSchema = z
  .object({
    sha256: hash,
    size: count.max(64 * 1024),
    first: z.string(),
    last: z.string(),
  })
  .strict();
export const ownerViewPageSchema = z
  .object({ work: hash, view: ownerDerivedSchema.shape.views.element })
  .strict();
/** A small companion to existing owner display bytes, without copying View provenance. */
export function ownerDiffstatPages(
  derived: Pick<OwnerDerived, 'work' | 'stats'> & Partial<Pick<OwnerDerived, 'views'>>,
) {
  const stats = [...new Map(derived.stats)].sort(([a], [b]) => a.localeCompare(b)),
    objects = new Map<string, Buffer>(),
    pages: z.infer<typeof diffstatPagePinSchema>[] = [];
  for (let offset = 0; offset < stats.length; offset += 100) {
    const page = stats.slice(offset, offset + 100),
      bytes = Buffer.from(JSON.stringify(diffstatPageSchema.parse({ work: derived.work, stats: page }))),
      sha256 = digest(bytes);
    objects.set(sha256, bytes);
    pages.push({ sha256, size: bytes.length, first: page[0]![0], last: page.at(-1)![0] });
  }
  const viewObjects = new Map<string, () => Buffer>();
  const views = (derived.views ?? []).map(view => {
    const bytes = Buffer.from(JSON.stringify({ work: derived.work, view })),
      sha256 = digest(bytes);
    viewObjects.set(sha256, () => Buffer.from(JSON.stringify({ work: derived.work, view })));
    return { key: view[0], sha256, size: bytes.length };
  });
  return {
    pages,
    views,
    objects,
    read: (sha256: string) => objects.get(sha256) ?? viewObjects.get(sha256)?.(),
  };
}
