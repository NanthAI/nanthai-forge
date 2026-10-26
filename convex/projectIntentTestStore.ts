import { report } from './errors';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery, internalMutation, type QueryCtx, type MutationCtx } from './_generated/server';
import { query } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { readHostedRecord, writeHostedRecord, hostedWriteProject } from './projectHostedRecords';
import { saveObject } from './projectHostedSaveStore';
import { hostedRecordSchema } from '../src/hosted-records';
import {
  intentTestContractSchema,
  latestTestContract,
  candidateTestContract,
} from '../src/intent-test-contract';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
const identity = { projectId: v.id('hostedProjects'), candidateId: v.string() };
export async function intentTestContext(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; candidateId: string },
) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read Intent contracts.');
  const project = await accessibleProject(ctx, input.projectId, user.subject);
  const row = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: user.subject,
    kind: 'candidate',
    key: input.candidateId,
  });
  invariant(row, 'NOT_FOUND', 'Candidate not found.');
  const candidate = hostedRecordSchema.options[3].parse(JSON.parse(row.value));
  invariant(candidate.result.status === 'clean', 'VIEW_STALE', 'Select a clean Candidate.');
  const parent = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: user.subject,
    kind: 'intent',
    key: candidate.intentId,
  });
  invariant(parent, 'NOT_FOUND', 'Intent not found.');
  const intent = hostedRecordSchema.options[0].parse(JSON.parse(parent.value));
  return { actor: user.subject, project, candidate, intent };
}
export const context = internalQuery({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    const { actor, project, candidate, intent } = await intentTestContext(ctx, input);
    return canonicalPayload({
      actor,
      authorityEpoch: project.sourceAuthority?.epoch ?? 0,
      candidate,
      intent,
      head: candidate.result.status === 'clean' ? candidate.result.head : null,
    });
  },
});
export const objects = internalQuery({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read Candidate source.');
    await accessibleProject(ctx, input.projectId, user.subject);
    return canonicalPayload(
      await Promise.all(input.digests.map(sha256 => saveObject(ctx, input.projectId, { sha256 }))),
    );
  },
});
/** The action supplies measured bytes; only this internal CAS publishes metadata.
 * Canonical record versions and retained contract operations preserve edits/retries. */
export const confirm = internalMutation({
  args: { ...identity, contract: v.string(), authorityEpoch: v.number() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const { actor, candidate, intent } = await intentTestContext(ctx, input);
    const contract = intentTestContractSchema.parse(JSON.parse(input.contract));
    const prior = intent.testContracts?.find(item => item.operationId === contract.operationId);
    if (prior) {
      invariant(
        prior.request === contract.request,
        'WORK_OPERATION_CHANGED',
        'Replay the original contract confirmation.',
      );
      return canonicalPayload({ intentId: intent.id, contract: prior, gate: 'unchanged' });
    }
    await hostedWriteProject(ctx, input.projectId, actor, input.authorityEpoch);
    invariant(
      candidate.result.status === 'clean' &&
        candidate.result.head === contract.measuredOn &&
        candidate.id === contract.candidateId,
      'VIEW_STALE',
      'Confirm this exact Candidate.',
    );
    invariant(
      (latestTestContract(intent)?.version ?? 0) + 1 === contract.version,
      'WORK_STALE',
      'The Intent contract changed. Read its proposal again.',
    );
    await writeHostedRecord(ctx, {
      projectId: input.projectId,
      actor,
      authorityEpoch: input.authorityEpoch,
      expectedVersion: intent.version,
      record: {
        ...intent,
        version: intent.version + 1,
        testContracts: [...(intent.testContracts ?? []), contract],
      },
    });
    return canonicalPayload({ intentId: intent.id, contract, gate: 'unchanged' });
  },
});

/** Review reads the current authority's Intent; a binding alone does not select it. */
export const review = query({
  args: {
    projectId: v.id('hostedProjects'),
    intentId: v.string(),
    candidateId: v.optional(v.string()),
    head: v.optional(v.string()),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read Intent contracts.');
      const project = await accessibleProject(ctx, input.projectId, user.subject);
      if (project.sourceAuthority?.mode !== 'server') return null;
      const row = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor: user.subject,
        kind: 'intent',
        key: input.intentId,
      });
      if (!row) return canonicalPayload({ contract: null });
      const intent = hostedRecordSchema.options[0].parse(JSON.parse(row.value));
      const contract = input.candidateId
        ? candidateTestContract(intent, input.candidateId, input.head)
        : latestTestContract(intent);
      return canonicalPayload({ contract });
    } catch (error) {
      return report(error);
    }
  },
});
