// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { selectedSourcePacks } from './projectSourcePackStore';
import { actionsSession, sessionArgs, type SessionInput } from './projectHostedActionsSession';
import {
  sourcePackUploadSchema,
  sourcePackKey,
  sourcePackSchema,
  type SourcePackUpload,
} from '../src/source-pack';
import { presignPut, presignDelete, r2Config, headObject, checksumOf, putExpiry } from './r2';
import { invariant } from '../src/errors';
import { isStored } from './projectObjectFields';
import { findObject } from './projectObjectFind';

type PackInput = SessionInput & { object: string; cleanupAck?: string };
/** Two slots include in-flight uploads. Reserve before PUT, so races and failed
 * uploads cannot create an unbounded collection of untracked cache objects. */
export async function prepareSourcePack(ctx: MutationCtx, input: PackInput, now = Date.now()) {
  const { run } = await actionsSession(ctx, input);
  const object = sourcePackUploadSchema.parse(JSON.parse(input.object));
  invariant(
    object.stateRef === run.candidate.base.head,
    'EVIDENCE_CHANGED',
    'Pack the pinned accepted base.',
  );
  return reserveSourcePack(ctx, input.projectId, object, input.cleanupAck, now);
}
/** Shared by the check runner (pinned base) and signed-in clients (current main).
 * Callers have already authorized the project and selected the expected State. */
export async function reserveSourcePack(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  object: SourcePackUpload,
  cleanupAck: string | undefined,
  now: number,
) {
  const state = await findObject(ctx, projectId, object.stateRef);
  invariant(
    state && !state.removed && isStored(state),
    'SOURCE_UNAVAILABLE',
    'Project State is unavailable.',
  );
  let row = await selectedSourcePacks(ctx, projectId);
  const objectKey = sourcePackKey(projectId, object.stateRef, object.sha256);
  if (row?.latest?.objectKey === objectKey) return null;
  if (cleanupAck) {
    invariant(
      row?.other?.objectKey === cleanupAck && row.other.expiresAt <= now && row.other.deleting,
      'WORK_STALE',
      'Pack cleanup changed.',
    );
    await ctx.db.patch(row._id, { other: undefined });
    row = { ...row, other: undefined };
  }
  if (row?.other) {
    if (row.other.expiresAt <= now) {
      if (!row.other.deleting) await ctx.db.patch(row._id, { other: { ...row.other, deleting: true } });
      return { cleanup: row.other.objectKey };
    }
    if (row.other.ready || row.other.objectKey !== objectKey) return null;
    invariant(
      row.other.size === object.size && row.other.fileCount === object.fileCount,
      'EVIDENCE_CHANGED',
      'Pack retry changed.',
    );
  }
  const other = {
    ...object,
    objectKey,
    createdAt: row?.other?.createdAt ?? now,
    // Keep retired keys until every signed PUT and bounded upload has expired;
    // a delayed retry must not recreate an already deleted object.
    expiresAt: now + putExpiry * 1000 + 120_000,
    ready: false,
  };
  if (row) await ctx.db.patch(row._id, { other });
  else await ctx.db.insert('projectSourcePacks', { projectId, other });
  return { target: await presignPut(r2Config(), objectKey, { digest: object.sha256, size: object.size }) };
}
export async function commitSourcePack(ctx: MutationCtx, input: PackInput) {
  const { run } = await actionsSession(ctx, input);
  const object = sourcePackUploadSchema.parse(JSON.parse(input.object));
  invariant(object.stateRef === run.candidate.base.head, 'EVIDENCE_CHANGED', 'Pack State changed.');
  return promoteSourcePack(ctx, input.projectId, object);
}
export async function promoteSourcePack(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  object: SourcePackUpload,
) {
  const key = sourcePackKey(projectId, object.stateRef, object.sha256);
  const row = await selectedSourcePacks(ctx, projectId);
  if (row?.latest?.objectKey === key) return null;
  invariant(
    row?.other &&
      !row.other.ready &&
      !row.other.deleting &&
      row.other.objectKey === key &&
      row.other.size === object.size &&
      row.other.fileCount === object.fileCount,
    'WORK_STALE',
    'Pack reservation changed.',
  );
  const latest = { ...sourcePackSchema.strip().parse(row.other), expiresAt: row.other.expiresAt };
  await ctx.db.patch(row._id, { latest, other: row.latest ? { ...row.latest, ready: true } : undefined });
  return null;
}
const args = { ...sessionArgs, object: v.string(), cleanupAck: v.optional(v.string()) };
export const prepare = internalMutation({ args, returns: v.any(), handler: prepareSourcePack });
export const commit = internalMutation({ args, returns: v.null(), handler: commitSourcePack });
/** No pack bytes cross Convex. HTTP has verified OIDC; mutations repeat current
 * project authority/fence checks before signing and after external HEAD I/O. */
export async function sourcePackCommand(
  ctx: ActionCtx,
  input: SessionInput,
  phase: 'prepare' | 'commit',
  object: SourcePackUpload,
) {
  const data = { ...input, object: JSON.stringify(object) };
  return sourcePackFlow(input.projectId, phase, object, {
    prepare: cleanupAck =>
      ctx.runMutation(
        makeFunctionReference<'mutation'>('projectSourcePacks:prepare'),
        cleanupAck ? { ...data, cleanupAck } : data,
      ),
    authorize: () =>
      ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsSession:session'), input),
    commit: () => ctx.runMutation(makeFunctionReference<'mutation'>('projectSourcePacks:commit'), data),
  });
}
type PackSteps = {
  prepare(cleanupAck?: string): Promise<{ cleanup?: string; target?: unknown } | null>;
  authorize(): Promise<unknown>;
  commit(): Promise<null>;
};
/** Prepare signs one PUT (after deleting an expired reservation); commit authorizes,
 * verifies the uploaded size/checksum with HEAD, then promotes the reservation. */
export async function sourcePackFlow(
  projectId: string,
  phase: 'prepare' | 'commit',
  object: SourcePackUpload,
  steps: PackSteps,
) {
  if (phase === 'prepare') {
    let result = await steps.prepare();
    if (result?.cleanup) {
      const response = await fetch(await presignDelete(r2Config(), result.cleanup), {
        method: 'DELETE',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      invariant(response.ok || response.status === 404, 'R2_VERIFY_FAILED', 'Old pack deletion failed.');
      result = await steps.prepare(result.cleanup);
    }
    return result?.target ?? null;
  }
  // Authorize before HEAD too. A separate mutation is necessary: signed upload
  // size/checksum verification is external I/O and cannot run in a transaction.
  await steps.authorize();
  const observed = await headObject(r2Config(), sourcePackKey(projectId, object.stateRef, object.sha256));
  invariant(
    observed.status === 'ok' &&
      observed.size === object.size &&
      (!observed.checksum || observed.checksum === checksumOf(object.sha256)),
    'R2_VERIFY_FAILED',
    'Pack upload verification failed.',
  );
  return steps.commit();
}
