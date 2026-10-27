// SPDX-License-Identifier: Apache-2.0
'use node';
import { blobStore } from './blobStore';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { digest } from '../src/hash';
/** Reuse the existing project-scoped immutable-object binding and recovery path. */
export function detailObjectWriter(ctx: ActionCtx, projectId: Id<'hostedProjects'>, actor: string) {
  return async (bytes: Uint8Array) => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    const input = { projectId, actor, digest: pin.sha256, size: pin.size };
    if (await ctx.runQuery(internal.projectGithubImportObjects.stored, input)) return pin;
    const nonce = await ctx.runMutation(internal.projectGithubImportObjects.reserve, input);
    const storageId = await blobStore(ctx).store(
      new Blob([Buffer.from(bytes)], { type: `application/x-forge-object-${nonce}` }),
    );
    await ctx.runMutation(internal.projectGithubImportObjects.bind, {
      ...input,
      nonce,
      storageId: storageId as Id<'_storage'>,
    });
    return pin;
  };
}
