// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
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
  | { location: 'r2' }
  | { location: 'convex'; url: string }
  | { location: 'recipe'; recipe: { digest: string; size: number } }
);
export type SignedDownload = { digest: string; size: number; url: string };
