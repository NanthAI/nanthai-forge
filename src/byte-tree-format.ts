// SPDX-License-Identifier: Apache-2.0
// Physical byte-tree pins are shared by file recipes and Work exchange. Keep
// their wire format independent of Work construction and native owner services.
import { z } from 'zod';
export const bytePinSchema = z
  .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().safe().nonnegative() })
  .strict();
export const treeRefSchema = bytePinSchema
  .extend({ height: z.number().safe().nonnegative(), length: z.number().safe().nonnegative() })
  .strict();
export type TreeRef = z.infer<typeof treeRefSchema>;
export type BytePin = z.infer<typeof bytePinSchema>;

/** Canonical source recipes: shared by stream readers and the trusted State signer. */
export const objectChunkPageSchema = z
  .object({
    kind: z.literal('forge-byte-tree'),
    schema: z.literal(1),
    children: z.array(treeRefSchema).min(2),
  })
  .strict();
export const objectRecipeSchema = z
  .object({
    kind: z.literal('forge-object-recipe'),
    schema: z.literal(1),
    object: bytePinSchema,
    tree: treeRefSchema,
  })
  .strict();
export type ObjectRecipe = z.infer<typeof objectRecipeSchema>;
