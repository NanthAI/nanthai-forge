// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction, internalQuery } from './server';
import { finishStep, resumeFinishIO, type FinishIdentity } from './projectHostedFinishControl';
import { loadLanding } from './projectHostedLandingStore';
import { finishRow, scheduleFinish } from './projectHostedFinishWake';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import type { FinishCommand } from '../src/hosted-finish';
import { composeRow, composeStateSchema, hostedComposeInput } from './projectHostedComposeStore';
import { r2Config, r2Key, presignPut } from './r2';
import { verifyArchiveUpload } from './archiveUpload';
import { exchangeFetch } from '../src/exchange-request';
import { invariant } from '../src/errors';
import { readExactObject } from './projectR2ExactRead';
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
/** Item 9a04d916 (FORGE_QUEUE_COMPOSE_SETTLE): the finish step as a scheduled
 * mutation (exactly once), for a completed compose and for the recompose submit.
 * Only a step that needs IO hands its command to the drive action, untracked: the
 * retained retry wake the step armed owns that IO. Task args never carry IO bytes
 * or URLs: a solo plan travels as its pin and compose identity, and the action
 * re-reads its bytes; a cohort plan or an acceptance page (rare here) goes to an
 * immediate drive, as before the switch. */
export const settle = internalMutation({
  args: stepIdentity,
  returns: v.null(),
  handler: async (ctx, input) => {
    const command = await finishStep(ctx, input);
    if (!command) return null;
    if (command.kind === 'page' || (command.kind === 'plan' && !command.source)) {
      const row = await finishRow(ctx, input);
      if (row) await scheduleFinish(ctx, row, 0, true);
      return null;
    }
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedFinishDriver:drive'), {
      ...input,
      command: canonicalPayload(
        command.kind === 'plan' ? { kind: 'plan', pin: command.pin, source: command.source } : command,
      ),
    });
    return null;
  },
});
/** The exact bytes of a settled solo plan: one indexed compose read, rebuilt the way
 * the step built them. The action checks them against the pin; resume checks again. */
export const planValue = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), operationId: v.string(), at: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { at, ...input }) => {
    const row = await composeRow(ctx, input);
    return row
      ? canonicalPayload(hostedComposeInput(composeStateSchema.parse(JSON.parse(row.value)), at))
      : null;
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
  args: { ...stepIdentity, command: v.optional(v.string()) },
  returns: v.null(),
  handler: async (
    ctx,
    { command: settled, ...input }: FinishIdentity & { command?: string },
  ): Promise<null> => {
    // A settle mutation already ran the step and passes its IO command.
    let raw: string | null =
      settled ??
      (await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedFinishDriver:step'), input));
    if (!raw) return null;
    let command = JSON.parse(raw) as FinishCommand;
    if (command.kind === 'plan' && command.source) {
      // Only a settled command arrives without its bytes; the drive's own step has them.
      const { source, ...plan } = command;
      const value: string | null =
        (plan as { value?: string }).value ??
        (await ctx.runQuery(makeFunctionReference<'query'>('projectHostedFinishDriver:planValue'), {
          projectId: input.projectId,
          ...source,
        }));
      if (value === null) return null;
      // The same command bytes the drive's own step would have returned.
      command = { ...plan, value };
      raw = canonicalPayload(command);
    }
    if (command.kind === 'reuse') {
      await ctx.runAction(makeFunctionReference<'action'>('projectHostedReuse:prove'), {
        projectId: input.projectId,
        submissionId: input.submissionId,
        pendingId: command.pendingId,
      });
      return null;
    }
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
    const bytes = await readExactObject(
      { url: command.url, size: command.pin.size, ...(command.range ? { range: command.range } : {}) },
      {
        failed: 'Exact selection metadata download failed.',
        exceeds: 'Selection metadata exceeds its exact size.',
      },
    );
    invariant(
      bytes.length === command.pin.size && digest(bytes) === command.pin.sha256,
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
