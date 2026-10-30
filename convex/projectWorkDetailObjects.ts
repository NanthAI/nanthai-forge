// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { digest } from '../src/hash';
import { storeProjectArtifact } from './projectArtifactActions';
/** Keep detail bytes on the same project-scoped, verified placement path. */
export function detailObjectWriter(ctx: ActionCtx, projectId: Id<'hostedProjects'>, actor: string) {
  return async (bytes: Uint8Array) => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    await storeProjectArtifact(ctx, projectId, actor, Buffer.from(bytes));
    return pin;
  };
}
