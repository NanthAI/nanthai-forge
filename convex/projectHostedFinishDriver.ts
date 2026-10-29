// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction } from './_generated/server';
import { finishStep, resumeFinishIO, type FinishIdentity } from './projectHostedFinishControl';
import { loadLanding } from './projectHostedLandingStore';
import { scheduleFinish } from './projectHostedFinishWake';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import type { FinishCommand } from '../src/hosted-finish';
import { r2Config, r2Key, presignPut } from './r2';
import { verifyArchiveUpload } from './archiveUpload';
import { exchangeFetch } from '../src/exchange-request';
import { invariant } from '../src/errors';
const identity = { projectId: v.id('hostedProjects'), submissionId: v.string() };
const stepIdentity = { ...identity, wakeId: v.string() };
export const step = internalMutation({
  args: stepIdentity,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const command = await finishStep(ctx, input);
    return command ? canonicalPayload(command) : null;
  },
});
export const resume = internalMutation({
  args: {
    ...stepIdentity,
    command: v.string(),
    page: v.optional(v.string()),
    storageId: v.optional(v.id('_storage')),
    key: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    await resumeFinishIO(ctx, {
      ...input,
      command: JSON.parse(input.command),
      ...(input.page ? { page: JSON.parse(input.page) } : {}),
    });
    return null;
  },
});
/** Consume terminal-parent events in finite windows; terminal history is never
 * scanned and an idle dependency owns neither a worker nor a polling timer. */
export const dependents = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    const { state } = await loadLanding(ctx, input);
    if (state.phase !== 'landed' && state.phase !== 'terminal-failed') return null;
    const page = await ctx.db
      .query('projectHostedFinishes')
      .withIndex('by_project_and_parent_and_waiting', q =>
        q.eq('projectId', input.projectId).eq('parentSubmissionId', input.submissionId).eq('waiting', true),
      )
      .paginate({ cursor: null, numItems: 40, maximumRowsRead: 40, maximumBytesRead: 96 * 1024 });
    for (const row of page.page) {
      await ctx.db.patch(row._id, { waiting: false });
      await scheduleFinish(ctx, row);
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('projectHostedFinishDriver:dependents'),
        input,
      );
    return null;
  },
});
/** One short step, one bounded metadata transfer, one completion transaction.
 * Crashing anywhere retains the original generation's recovery wake. */
export const drive = internalAction({
  args: stepIdentity,
  returns: v.null(),
  handler: async (ctx, input: FinishIdentity): Promise<null> => {
    const raw: string | null = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedFinishDriver:step'),
      input,
    );
    if (!raw) return null;
    const command = JSON.parse(raw) as FinishCommand;
    if (command.kind === 'plan') {
      const bytes = new TextEncoder().encode(command.value),
        key = r2Key(input.projectId, command.pin.sha256);
      invariant(
        bytes.length === command.pin.size && digest(bytes) === command.pin.sha256,
        'SOURCE_HASH_MISMATCH',
        'Source plan differs from its exact bytes.',
      );
      const target = await presignPut(r2Config(), key, { digest: command.pin.sha256, size: bytes.length });
      const response = await exchangeFetch('R2 finish plan upload', target.url, {
        method: 'PUT',
        headers: target.headers,
        body: bytes,
      });
      invariant(
        response.ok || response.status === 412,
        'R2_UPLOAD_FAILED',
        'Object storage could not upload the source plan.',
      );
      invariant(
        await verifyArchiveUpload({ r2Key: key, size: bytes.length, digest: command.pin.sha256 }),
        'R2_OBJECT_MISSING',
        'Uploaded source plan is missing.',
      );
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedFinishDriver:resume'), {
        ...input,
        command: raw,
        key,
      });
      return null;
    }
    invariant(
      command.pin.size <= 128 * 1024,
      'SOURCE_HASH_MISMATCH',
      'Selection metadata exceeds its transport window.',
    );
    const response = await fetch(command.url, {
      headers: { 'accept-encoding': 'identity' },
      signal: AbortSignal.timeout(10_000),
    });
    invariant(
      response.ok && response.body,
      'SOURCE_UNAVAILABLE',
      'Exact selection metadata download failed.',
    );
    const reader = response.body.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        invariant(
          size <= command.pin.size,
          'SOURCE_HASH_MISMATCH',
          'Selection metadata exceeds its exact size.',
        );
        parts.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    invariant(
      size === command.pin.size && digest(bytes) === command.pin.sha256,
      'SOURCE_HASH_MISMATCH',
      'Selection metadata differs from its exact bytes.',
    );
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedFinishDriver:resume'), {
      ...input,
      command: raw,
      page: new TextDecoder().decode(bytes),
    });
    return null;
  },
});
