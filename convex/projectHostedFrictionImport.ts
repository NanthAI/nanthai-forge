// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { hostedImportPageSchema } from '../src/hosted-record-input';
import { canonicalPayload } from '../src/hosted-source-operation';
import { recordCaller, frictionRow, appendFriction } from './projectHostedFrictionStore';
import { decisionRow, appendDecision } from './projectHostedDecisionsStore';
import { invariant } from '../src/errors';
import { report } from './errors';
async function inspect(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, input: string) {
  const parsed = hostedImportPageSchema.safeParse(JSON.parse(input));
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Send at most 100 native friction/decision records per import page.',
  );
  const page = parsed.data;
  const { actor } = await recordCaller(ctx, projectId, true, page.decisions.length > 0);
  let existing = 0;
  for (const record of [...page.friction, ...page.decisions]) {
    const old =
      record.kind === 'decision'
        ? await decisionRow(ctx, projectId, record.id)
        : await frictionRow(ctx, projectId, record.id);
    if (old) {
      invariant(
        canonicalPayload(JSON.parse(old.value)) === canonicalPayload(record),
        'WORK_OPERATION_CHANGED',
        'An imported ID already has different bytes.',
      );
      existing++;
    }
  }
  return {
    actor,
    page,
    result: {
      records: page.friction.length + page.decisions.length,
      existing,
      added: page.friction.length + page.decisions.length - existing,
    },
  };
}
const args = { projectId: v.id('hostedProjects'), request: v.string() };
export const preview = query({
  args,
  returns: v.string(),
  handler: async (ctx, { projectId, request }) => {
    try {
      const { result } = await inspect(ctx, projectId, request);
      return canonicalPayload({ ...result, dryRun: true });
    } catch (error) {
      return report(error);
    }
  },
});
export const apply = mutation({
  args,
  returns: v.string(),
  handler: async (ctx, { projectId, request }) => {
    try {
      const { actor, page, result } = await inspect(ctx, projectId, request);
      for (const record of page.friction) await appendFriction(ctx, projectId, actor, record);
      for (const record of page.decisions) await appendDecision(ctx, projectId, actor, record);
      return canonicalPayload({ ...result, dryRun: false });
    } catch (error) {
      return report(error);
    }
  },
});
