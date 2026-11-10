// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { PackRange } from './object-pack-range.js';
export const downloadPinSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().safe().nonnegative(),
});
export type DownloadPin = z.infer<typeof downloadPinSchema>;
export const downloadTreeSchema = downloadPinSchema.extend({
  height: z.number().safe().nonnegative(),
  length: z.number().safe().nonnegative(),
});
export type DownloadTree = z.infer<typeof downloadTreeSchema>;
export const downloadPageSchema = z.object({
  kind: z.literal('forge-byte-tree'),
  schema: z.literal(1),
  children: z.array(downloadTreeSchema).min(2),
});
export const downloadRecipeSchema = z.object({
  kind: z.literal('forge-object-recipe'),
  schema: z.literal(1),
  object: downloadPinSchema,
  tree: downloadTreeSchema,
});
export type DownloadRow = { digest: string; size: number } & (
  | { location: 'r2'; url?: string | undefined; range?: PackRange | undefined }
  | { location: 'convex'; url: string }
  // A signed describe may also sign the recipe object itself (url/range); readers may ignore it.
  | {
      location: 'recipe';
      closure?: SignedDownload[] | undefined;
      recipe: { digest: string; size: number; url?: string | undefined; range?: PackRange | undefined };
    }
);
export type SignedDownload = { digest: string; size: number; url: string; range?: PackRange | undefined };

export const downloadClosureSchema = z
  .array(
    z.object({
      digest: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.number().safe().nonnegative(),
      url: z.url(),
      range: z
        .object({ offset: z.number().safe().nonnegative(), total: z.number().safe().positive() })
        .optional(),
    }),
  )
  .max(100);
