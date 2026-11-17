// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './server';
import { accessibleProject } from './projectAuthority';
import { effectivePolicy } from '../src/autonomy-policy';
import { digest } from '../src/state/hash';
import { ForgeError, invariant } from '../src/errors';
/** A key may have separate account approvals. A browser never sees another account's labels. */
export async function deviceApproval(ctx: QueryCtx | MutationCtx, row: Doc<'deviceCodes'>, owner: string) {
  if (!row.deviceKey) return null;
  const proposed = await ctx.db
    .query('cliCredentials')
    .withIndex('by_credentialId', q => q.eq('credentialId', row.credentialId))
    .unique();
  invariant(
    !proposed || proposed.removed || proposed.deviceKey === row.deviceKey,
    'AUTH_REQUIRED',
    'Use the approved key for this device.',
  );
  // Custom UUIDv8: account/key identity is deterministic, so the existing credential
  // index also reconciles concurrent first approvals without another persisted index.
  const hash = digest(JSON.stringify(['forge-device-account-v1', owner, row.deviceKey]));
  const credentialId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${(8 + (parseInt(hash[16]!, 16) % 4)).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const current =
    proposed?.owner === owner && proposed.credentialId === credentialId
      ? proposed
      : await ctx.db
          .query('cliCredentials')
          .withIndex('by_credentialId', q => q.eq('credentialId', credentialId))
          .unique();
  invariant(
    !current || current.removed || current.deviceKey === row.deviceKey,
    'AUTH_REQUIRED',
    'Use the approved key for this device.',
  );
  const foreign = Boolean(proposed && proposed.owner !== owner);
  if (current?.deviceApprovedAt !== undefined && !current.removed)
    return { current, projectName: null, credentialId, foreign, enabled: true };
  const proposal = JSON.parse(row.request) as { deviceVersion?: number; projectId?: string };
  if (proposal.deviceVersion !== 1 || !proposal.projectId)
    return { current: null, projectName: null, credentialId, foreign, enabled: false };
  const projectId = ctx.db.normalizeId('hostedProjects', proposal.projectId);
  if (!projectId) return { current: null, projectName: null, credentialId, foreign, enabled: false };
  try {
    const project = await accessibleProject(ctx, projectId, owner);
    let enabled = effectivePolicy(project).accessIdentities?.devices === true;
    if (enabled) {
      const identity = await ctx.auth.getUserIdentity();
      // Existing legacy-only accounts keep their earlier approval flow; stable auth
      // receipts never force an account migration as part of device login.
      enabled =
        Boolean(identity?.subject === owner && typeof identity.forgeAuthUser === 'string') ||
        Boolean(
          await ctx.db
            .query('users')
            .withIndex('by_accountKey', q => q.eq('accountKey', owner))
            .unique(),
        );
    }
    return {
      current: null,
      removedId: current?.removed ? current._id : undefined,
      projectName: project.name,
      credentialId,
      foreign,
      enabled,
    };
  } catch (error) {
    if (!(error instanceof ForgeError) || error.code !== 'PROJECT_UNAVAILABLE') throw error;
    // Explicit login continues through the existing account-wide credential flow when
    // the selected project's rollout is unavailable to this browser account.
    return { current: null, projectName: null, credentialId, foreign, enabled: false };
  }
}
