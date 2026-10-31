// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { exchangeFetch } from '../src/exchange-request';
import { r2Config, presignPut, headObject, checksumOf } from './r2';

/** Shared write seam for server-built project artifacts and legacy-reader
 * materialization. The reservation exists before either store sees bytes. */
export async function storeProjectArtifact(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  bytes: Buffer,
) {
  const pin = { projectId, actor, digest: digest(bytes), size: bytes.length };
  const prepared = await ctx.runMutation(internal.projectExchangeCache.prepare, pin);
  if (prepared.stored) return;
  // Every new object goes to R2; prepare always returns its key.
  invariant(prepared.r2Key, 'R2_REQUIRED', 'Project artifacts upload to R2 only.');
  const config = r2Config();
  const target = await presignPut(config, prepared.r2Key, pin);
  const response = await exchangeFetch('R2 project artifact upload', target.url, {
    method: 'PUT',
    headers: target.headers,
    body: new Uint8Array(bytes),
  });
  invariant(
    response.ok || response.status === 412,
    'R2_UPLOAD_FAILED',
    'Object storage could not upload the artifact.',
  );
  const head = await headObject(config, prepared.r2Key);
  invariant(head.status !== 'missing', 'R2_OBJECT_MISSING', 'Uploaded artifact is missing.');
  invariant(head.status === 'ok', 'R2_VERIFY_FAILED', 'Object storage could not confirm the artifact.');
  invariant(head.size === pin.size, 'R2_OBJECT_SIZE_MISMATCH', 'Uploaded artifact size differs.');
  invariant(
    !head.checksum || head.checksum === checksumOf(pin.digest),
    'R2_OBJECT_CHECKSUM_MISMATCH',
    'Uploaded artifact checksum differs.',
  );
  await ctx.runMutation(internal.projectExchangeCache.completeR2, {
    id: prepared.id,
    actor,
    key: prepared.r2Key,
  });
}
