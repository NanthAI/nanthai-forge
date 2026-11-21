// SPDX-License-Identifier: Apache-2.0
import { checkCause } from '../src/hosted-check';
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { recordCaller } from './projectHostedFrictionStore';
import { readHostedRecord } from './projectHostedRecords';
import { loadLanding } from './projectHostedLandingStore';
import { loadHostedCheck } from './projectHostedCheckStore';
import { enqueueHostedCheck } from './projectHostedChecks';
import { executeCommand } from './projectWorkCommand';
import { proofFollowupId } from '../src/run-evidence';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Reuses the configured check on exactly the original Candidate; it never switches to newer main. */
export const runAll = mutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string(), operationId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor } = await recordCaller(ctx, input.projectId, true);
      const { run } = await loadHostedCheck(ctx, input, false);
      return canonicalPayload(
        await enqueueHostedCheck(ctx, {
          projectId: input.projectId,
          actor,
          cause: checkCause.proof,
          fullCheck: { afterRunId: run.id },
          request: {
            ...run.request,
            operationId: input.operationId,
            gate: { mode: 'full', reason: 'Run every test requested from the exact-source proof page.' },
          },
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});

/** One page per transaction. IDs derive from the immutable save and line, shared by single and batch actions. */
export const followups = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    saveId: v.optional(v.string()),
    submissionId: v.optional(v.string()),
    line: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor } = await recordCaller(ctx, input.projectId, true);
      invariant(
        Boolean(input.saveId) !== Boolean(input.submissionId),
        'BAD_ARGUMENT',
        'Select one exact save or landing.',
      );
      let saved, kind;
      if (input.submissionId) {
        const { state } = await loadLanding(ctx, {
          projectId: input.projectId,
          submissionId: input.submissionId,
        });
        saved = {
          id: state.id,
          actor: state.actor,
          head: state.acceptance?.head ?? state.request.expectedHead,
          notVerified: state.request.notVerified,
        };
        kind = 'landing';
      } else {
        const row = await readHostedRecord(ctx, {
          projectId: input.projectId,
          actor,
          kind: 'save',
          key: input.saveId!,
        });
        invariant(row, 'NOT_FOUND', 'This exact save is unavailable.');
        saved = JSON.parse(row.value);
        kind = 'save';
      }
      invariant(
        Array.isArray(saved.notVerified),
        'NOT_FOUND',
        'This save has no reported verification list.',
      );
      const start = input.line ?? input.offset ?? 0;
      invariant(
        Number.isSafeInteger(start) &&
          start >= 0 &&
          (input.line === undefined || start < saved.notVerified.length),
        'BAD_ARGUMENT',
        'Select a reported verification line.',
      );
      const end = input.line === undefined ? Math.min(start + 100, saved.notVerified.length) : start + 1;
      const items = [];
      for (let index = start; index < end; index++) {
        const line: string = saved.notVerified[index];
        const id = proofFollowupId(saved.id, index);
        await executeCommand(ctx, {
          projectId: input.projectId,
          operationId: id,
          command: canonicalPayload({
            action: 'put-planning-item',
            operationId: id,
            itemId: id,
            expectedVersion: 0,
            kind: 'issue',
            title: line.trim() || 'Verify the agent’s unreported scope',
            status: 'open',
            body: `Reported as not verified with ${kind} ${saved.id} on source ${saved.head}.\n\n${line}\n\nThis is the agent’s claim, not check evidence.`,
            intentIds: [],
          }),
        });
        items.push({ id, line: index });
      }
      return canonicalPayload({
        items,
        nextOffset: input.line === undefined && end < saved.notVerified.length ? end : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
