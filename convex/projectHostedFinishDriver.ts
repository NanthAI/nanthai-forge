// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction, internalQuery } from './server';
import type { MutationCtx } from './_generated/server';
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
import { readExactObject, type ExactGrant } from './projectR2ExactRead';
import { candidateFileListSchema } from '../src/hosted-compose';
import { protectedEntries, type ReviewProtect } from '../src/protected-review';
import { hostedWriteProject } from './projectHostedRecords';
import { findObject } from './projectObjectFind';
import { isStored } from './projectObjectFields';
import { packHeaders, packRange } from '../src/object-pack-range';
import { presignGet } from './r2';
const identity = { projectId: v.id('hostedProjects'), submissionId: v.string() };
const filePin = v.object({ sha256: v.string(), size: v.number() });

/** Resolve only the current finish action's two exact Candidate listings. */
export const reviewFiles = internalQuery({
  args: { ...identity, wakeId: v.string(), files: v.array(filePin) },
  returns: v.any(),
  handler: async (ctx, { files, ...input }) => {
    const finish = await finishRow(ctx, input);
    if (finish?.wake?.id !== input.wakeId) return null;
    const { state } = await loadLanding(ctx, input);
    await hostedWriteProject(ctx, input.projectId, state.actor, state.request.authorityEpoch);
    return Promise.all(
      files.map(async pin => {
        const object = await findObject(ctx, input.projectId, pin.sha256);
        // Item fe2b0a86: a listing that is gone cannot prove the approval still holds, so it re-asks.
        if (!(object && !object.removed && object.size === pin.size && isStored(object) && object.r2Key))
          return null;
        const range = packRange(object);
        return {
          url: await presignGet(r2Config(), object.r2Key, packHeaders(range, pin.size)),
          size: pin.size,
          ...(range ? { range } : {}),
        };
      }),
    );
  },
});

/** One reviewed listing reduced to its digests before the next is read (one listing in memory at a
 * time): every changed file, and with a protected scope its protected entries. Null when the listing
 * is gone, differs from its pin or does not parse: the approval cannot be proven. A failed read
 * throws, so the finish retries as before instead of asking the owner again during an outage. */
async function reviewedDigests(grant: ExactGrant | null, sha256: string, protect: ReviewProtect | undefined) {
  if (!grant) return null;
  const bytes = await readExactObject(grant, {
    failed: 'Exact reviewed Candidate files could not be read.',
    exceeds: 'Reviewed Candidate files exceed their exact size.',
  });
  try {
    invariant(
      bytes.length === grant.size && digest(bytes) === sha256,
      'SOURCE_HASH_MISMATCH',
      'Reviewed Candidate files differ from their exact bytes.',
    );
    const { files } = candidateFileListSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    const scoped = protect ? protectedEntries(files, protect) : [];
    return {
      all: digest(canonicalPayload(files, true)),
      scoped: scoped.length ? digest(canonicalPayload(scoped, true)) : null,
    };
  } catch {
    return null;
  }
}
/** Item fe2b0a86: whether the recomposed Candidate keeps what the owner approved. With a protected
 * scope only the protected entries (before and after content) must match; otherwise, or when the
 * approved Candidate has no protected entry under it, every changed file must. Unreadable: no. */
async function sameReviewedFiles(
  grants: [ExactGrant | null, ExactGrant | null],
  pins: [string, string],
  protect: ReviewProtect | undefined,
  scopedOnly = false,
) {
  const approved = await reviewedDigests(grants[0], pins[0], protect);
  // Part B (scopedOnly): only protected entries may stand for an earlier approval; none is no match.
  if (scopedOnly && !approved?.scoped) return false;
  const current = approved && (await reviewedDigests(grants[1], pins[1], protect));
  if (!approved || !current) return false;
  return approved.scoped ? approved.scoped === current.scoped : approved.all === current.all;
}
// `attempt`: mutation retries in a row since the last drive step (L2 budget, retryFinish);
// absent on a first retry.
const stepIdentity = { ...identity, wakeId: v.string(), attempt: v.optional(v.number()) };
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
/** Item 9a04d916 (compose settle): the finish step as a scheduled mutation (exactly
 * once), for every finish wake with no IO in flight (scheduleFinish). Only a step that
 * needs IO hands its command to the drive action, untracked: the retained retry wake
 * the step armed owns that IO. Task args never carry IO bytes or URLs: a solo plan
 * travels as its pin and compose identity, and the action re-reads its bytes; a cohort
 * plan or an acceptance page goes to an immediate drive that re-steps, backed by the
 * step's retry mutation. */
export const settle = internalMutation({
  args: stepIdentity,
  returns: v.null(),
  handler: (ctx, input) => settleStep(ctx, input),
});
/** Review ba9ce962 L2: a step's retained IO retry (retryFinish). The
 * settle step; a retry without a count is the generation's first. */
export const retry = internalMutation({
  args: stepIdentity,
  returns: v.null(),
  handler: (ctx, input) => settleStep(ctx, { ...input, attempt: input.attempt ?? 1 }),
});
async function settleStep(ctx: MutationCtx, input: FinishIdentity): Promise<null> {
  const command = await finishStep(ctx, input);
  if (!command) return null;
  if (command.kind === 'page' || (command.kind === 'plan' && !command.source)) {
    // Review ba9ce962 L2: the step armed its retained retry as a mutation (retryFinish);
    // it stays as this generation's backstop. The wake is due now, so one
    // untracked drive re-steps at once: its step mints the IO afresh and replaces the
    // retry with its own. Losing that drive leaves the retry, never the alarm.
    const row = await finishRow(ctx, input);
    if (row?.wake?.id === input.wakeId) {
      await ctx.db.patch(row._id, { wake: { ...row.wake, at: Date.now() } });
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>('projectHostedFinishDriver:drive'),
        input,
      );
    }
    return null;
  }
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedFinishDriver:drive'), {
    ...input,
    command: canonicalPayload(
      command.kind === 'plan' ? { kind: 'plan', pin: command.pin, source: command.source } : command,
    ),
  });
  return null;
}
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
    if (command.kind === 'review' || command.kind === 'protected') {
      const { before, after } = command;
      const grants: [ExactGrant | null, ExactGrant | null] | null = await ctx.runQuery(
        makeFunctionReference<'query'>('projectHostedFinishDriver:reviewFiles'),
        {
          projectId: input.projectId,
          submissionId: input.submissionId,
          wakeId: input.wakeId,
          files: [before, after],
        },
      );
      if (!grants) return null;
      const same = await sameReviewedFiles(
        grants,
        [before.sha256, after.sha256],
        command.protect,
        command.kind === 'protected',
      );
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedFinishDriver:resume'), {
        ...input,
        command: raw,
        page: canonicalPayload(same),
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
