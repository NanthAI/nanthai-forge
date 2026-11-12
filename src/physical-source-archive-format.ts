// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { physicalKey } from './physical-manifest-binary.js';
const pin = z
  .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().safe().nonnegative() })
  .strict();
const physicalArchiveObjectSchema = pin
  .extend({
    nonce: z
      .string()
      .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
      .optional(),
  })
  .strict();
export const physicalArchiveEntrySchema = z
  .object({
    // These are retained coordinates, never destination-project read authority.
    placement: z.literal('archive'),
    state: pin,
    root: pin,
    objects: z.array(physicalArchiveObjectSchema),
    unavailable: z.enum(['SOURCE_UNAVAILABLE', 'SOURCE_HASH_MISMATCH']).optional(),
    rootRetained: z.literal(true).optional(),
  })
  .strict()
  .refine(
    entry =>
      new Set(entry.objects.map(object => physicalKey(object.sha256, object.nonce))).size ===
      entry.objects.length,
  );
export type PhysicalArchiveEntry = z.infer<typeof physicalArchiveEntrySchema>;
export const physicalArchivePageSchema = z
  .object({
    kind: z.literal('forge-source-physical-archive'),
    schema: z.literal(1),
    previous: pin.nullable(),
    entries: z.array(physicalArchiveEntrySchema).min(1),
  })
  .strict();
