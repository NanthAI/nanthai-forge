// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { readHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { latestTestContract } from '../src/intent-test-contract';
import type { SemanticPlan } from '../src/intent-semantic-conflict';

/** Selected canonical records only. Declarations are carried forward with the
 * composed source, so history size adds no reads or client function calls. */
export async function semanticMember(
  ctx: MutationCtx,
  auth: { projectId: Id<'hostedProjects'>; actor: string },
  intentId: string,
) {
  const row = await readHostedRecord(ctx, { ...auth, kind: 'intent', key: intentId });
  if (!row) return;
  const intent = hostedRecordSchema.options[0].parse(JSON.parse(row.value));
  const contract = latestTestContract(intent);
  return contract
    ? { intentId, outcome: intent.outcome, version: contract.version, tests: contract.tests }
    : undefined;
}
export function mergeSemanticMembers(
  primaryIntentId: string,
  ...groups: (SemanticPlan['members'] | undefined)[]
): SemanticPlan {
  const members = new Map<string, SemanticPlan['members'][number]>();
  for (const group of groups)
    for (const member of group ?? []) {
      if ((members.get(member.intentId)?.version ?? 0) <= member.version)
        members.set(member.intentId, member);
    }
  return { primaryIntentId, members: [...members.values()] };
}
export async function mainSemanticMembers(
  ctx: MutationCtx,
  auth: { projectId: Id<'hostedProjects'>; actor: string },
  receiptId: string,
) {
  const receipt = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_receipt', q => q.eq('projectId', auth.projectId).eq('receiptId', receiptId))
    .unique();
  if (!receipt) return [];
  const candidateId = JSON.parse(receipt.value).candidate.id as string;
  const row = await readHostedRecord(ctx, { ...auth, kind: 'candidate', key: candidateId });
  if (!row) return [];
  const candidate = hostedRecordSchema.options[3].parse(JSON.parse(row.value));
  const own = await semanticMember(ctx, auth, candidate.intentId);
  return mergeSemanticMembers(
    candidate.intentId,
    candidate.semanticPlan?.members,
    own ? [{ ...own, acceptedSequence: receipt.sequence }] : [],
  ).members;
}

export async function semanticBaseSequence(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  receiptId: string,
) {
  const row = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId).eq('receiptId', receiptId))
    .unique();
  return row?.sequence ?? 0;
}
