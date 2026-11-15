// SPDX-License-Identifier: Apache-2.0
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { makeFunctionReference } from 'convex/server';
import { isDeviceIdentity } from './cliServer';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { ForgeError } from '../src/errors';
/** Keep the existing null success replies. A held request is a structured refusal with its
 * approval link and wait command; the request's submutation is committed before the refusal. */
export async function requestMemberApproval(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  change: Record<string, unknown>,
  operationId?: string,
) {
  const user = await ctx.auth.getUserIdentity();
  if (!user || !isDeviceIdentity(user)) return false;
  if (process.env.FORGE_MEMBER_APPROVAL_REQUESTS !== '1')
    throw new ForgeError(
      'PROJECT_UNAVAILABLE',
      'Membership approval requests are not enabled on this server yet. Only the owner person can grant access; open Forge in a browser.',
    );
  const request = canonicalPayload(change);
  const id = operationId ?? digest(request);
  const reply = JSON.parse(
    await ctx.runMutation(
      makeFunctionReference<
        'mutation',
        {
          projectId: Id<'hostedProjects'>;
          request: string;
          operationId: string;
        },
        string
      >('projectMemberApprovals:request'),
      { projectId, request, operationId: id },
    ),
  ) as {
    status: string;
    applied: boolean;
    id: string;
    url: string | null;
  };
  if (reply.applied) return true;
  throw new ForgeError(
    'PROJECT_UNAVAILABLE',
    `Project membership ${reply.status === 'declined' ? 'was declined by' : 'needs'} the owner person. ` +
      `Approval request ${reply.id}. ${reply.url ? `Open ${reply.url} in a browser to grant or decline. ` : 'Open the project approve page in a browser to grant or decline. '}` +
      `Wait: nforge agent ROOT wait '${JSON.stringify({ approval: reply.id })}'. Retry the original command after a grant.`,
  );
}
