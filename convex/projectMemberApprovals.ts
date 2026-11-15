// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { v } from 'convex/values';
import { internalMutation } from './server';
import { holdSetting, heldReplay } from './projectSettingApprovals';
import { laneApproveUrl } from './projectHostedApprovalStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { MutationCtx } from './_generated/server';
import type { ApprovalRow } from './projectHostedApprovalStore';
import { activeOwnedProject } from './projectAuthority';
import { addContributor, inviteContributor } from './projectContributors';
import { setReader } from './projectReaders';
import { requireOwnerPerson } from './ownerPerson';
import { invariant } from '../src/errors';

const memberChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contributor'), contributor: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('invite'),
      person: z.string().min(1),
      contributor: z.string().optional(),
      email: z.string().optional(),
      operationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reader'),
      reader: z.string().min(1),
      present: z.literal(true),
      operationId: z.uuid(),
    })
    .strict(),
]);
/** Reader first: only the person's exact-head grant can apply a retained membership request. */
export async function applyApprovedMember(ctx: MutationCtx, row: ApprovalRow) {
  const user = await requireOwnerPerson(ctx, 'grant project membership');
  const project = await activeOwnedProject(ctx, row.projectId, user.subject);
  invariant(
    row.requester === project.owner,
    'PROJECT_UNAVAILABLE',
    'This membership request is unavailable.',
  );
  const change = memberChange.parse(JSON.parse(row.setting!.request));
  const common = { projectId: row.projectId, owner: user.subject };
  switch (change.kind) {
    case 'contributor':
      await addContributor(ctx, { ...common, contributor: change.contributor });
      break;
    case 'invite':
      await inviteContributor(ctx, {
        ...common,
        person: change.person,
        contributor: change.contributor,
        email: change.email,
        operationId: change.operationId,
      });
      break;
    case 'reader':
      await setReader(ctx, {
        ...common,
        reader: change.reader,
        present: true,
        operationId: change.operationId,
      });
      break;
  }
  return { rule: 'owner-approved' };
}

/** A membership request never uses settings bootstrap: even an empty project needs the person. */
export const request = internalMutation({
  args: { projectId: v.id('hostedProjects'), request: v.string(), operationId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage project membership.');
    await activeOwnedProject(ctx, input.projectId, user.subject);
    memberChange.parse(JSON.parse(input.request));
    const key = `setting:membership:${input.operationId}`;
    const previous = await heldReplay(ctx, input.projectId, key, input.operationId, input.request);
    const row =
      previous ??
      (await holdSetting(ctx, {
        projectId: input.projectId,
        key,
        origin: 'membership',
        requester: user.subject,
        operationId: input.operationId,
        request: input.request,
        summary: 'Grant project membership',
      }));
    return canonicalPayload({
      status: row.status,
      applied: row.ended?.kind === 'applied',
      id: key,
      url: laneApproveUrl(input.projectId, key),
    });
  },
});
