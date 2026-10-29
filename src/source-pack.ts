// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
/** Cache bounds, never source/check limits. Oversized trees use ordinary source transfer. */
export const sourcePackBytes = 300 * 1024 * 1024;
export const sourcePackTreeBytes = 1024 * 1024 * 1024;
export const sourcePackFileBytes = 32 * 1024 * 1024;
export const sourcePackSchema = z
  .object({
    stateRef: z.string().regex(/^[a-f0-9]{64}$/),
    objectKey: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().max(sourcePackBytes),
    fileCount: z.number().int().nonnegative().max(100_000),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type SourcePack = z.infer<typeof sourcePackSchema>;
export const sourcePackDownloadSchema = sourcePackSchema.extend({ url: z.url() });
export type SourcePackDownload = z.infer<typeof sourcePackDownloadSchema>;
export const sourcePackKey = (project: string, state: string, sha256: string) =>
  `v1/p/${project}/source-pack/${state}/${sha256}.gz`;
export function refreshSourcePack(pack: SourcePack | null, files: number, bytes: number, total: number) {
  return !pack || files > 300 || bytes > total * 0.1;
}

export const sourcePackUploadSchema = sourcePackSchema.omit({ objectKey: true, createdAt: true });
export type SourcePackUpload = z.infer<typeof sourcePackUploadSchema>;
