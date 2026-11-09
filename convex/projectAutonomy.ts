// SPDX-License-Identifier: Apache-2.0
import { requireStoredRepositoryBinding } from './githubBindingAccess';
import { v } from 'convex/values';
import {
  query,
  mutation,
  guard,
  isDeviceIdentity,
  type QueryCtx,
  type MutationCtx,
  type ActionCtx,
} from './cliServer';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { autonomyPolicy } from './autonomyFields';
import {
  effectivePolicy,
  policyWriteSchema,
  editedPolicy,
  policyReadView,
  samePolicy,
  type AcceptanceActor,
  type AutonomyPolicy,
} from '../src/autonomy-policy';
import { invariant } from '../src/errors';
import { acceptancePolicyDigest } from '../src/policy-digest';
import { landingQueue } from './projectHostedLandingEvents';
import { report } from './errors';
import { recordMutationReceipt } from './projectSelfMetricReceiptStore';
import type { Doc, Id } from './_generated/dataModel';
import type { ApprovalRow } from './projectHostedApprovalStore';
import {
  agentSettingRule,
  heldReplay,
  holdSetting,
  settingKey,
  settingReply,
  type SettingRule,
} from './projectSettingApprovals';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
/** Device identity always uses agent authority; callers may explicitly downscope to it. */
export async function acceptanceActor(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  agent = false,
): Promise<AcceptanceActor> {
  await guard(ctx, 'cli');
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to accept source.');
  return { kind: agent || isDeviceIdentity(user) ? 'agent' : 'person', id: user.subject };
}
export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: autonomyPolicy,
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project policy.');
      return policyReadView(effectivePolicy(await accessibleProject(ctx, input.projectId, user.subject)));
    } catch (error) {
      return report(error);
    }
  },
});
/** The receipt shows the policy exactly as the following `policy` read does, agent defaults filled in
 * (49760b39); the stored policy and its digests keep the stored form. */
const receiptPolicy = (policy: AutonomyPolicy) => policyReadView(effectivePolicy({ autonomyPolicy: policy }));
const settingRuleValidator = v.union(
  v.literal('owner-person'),
  v.literal('owner-approved'),
  v.literal('bootstrap'),
  v.literal('no-gate-change'),
  v.literal('held'),
);
const POLICY_KEY = settingKey('policy');
/** Issue 470ef29b: an agent's edit needs the owner person when it changes what a landing may accept
 * (the acceptance digest: gate, mode, protected and owner-approval paths, auto actors, checks,
 * lifecycle, enforced trust) or where accepted source is mirrored. */
const gatesLandings = (previous: AutonomyPolicy, policy: AutonomyPolicy) =>
  acceptancePolicyDigest(previous) !== acceptancePolicyDigest(policy) ||
  canonicalPayload(previous.githubMirror ?? null) !== canonicalPayload(policy.githubMirror ?? null);
/** What a held edit is pinned to: the parts an agent may not change alone, so a later edit of agent
 * defaults or notifications does not void the owner's pending grant. */
const policyBase = (policy: AutonomyPolicy) =>
  digest(
    canonicalPayload({ acceptance: acceptancePolicyDigest(policy), mirror: policy.githubMirror ?? null }),
  );
function parsePolicyCommand(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Send a JSON policy command.');
  }
  const parsed = policyWriteSchema.safeParse(value);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Send a set-policy command with its original operation UUID.');
  return { command: parsed.data, request: JSON.stringify(parsed.data) };
}
type PolicyCommand = ReturnType<typeof parsePolicyCommand>['command'];
function heldPolicyReply(row: ApprovalRow, previous: AutonomyPolicy, operationId: string) {
  return {
    operationId,
    policy: receiptPolicy(previous),
    rule: 'held' as const,
    approval: settingReply(row),
  };
}
/** One policy write: patch, change row, receipt. The caller has decided who may write it. */
async function writePolicy(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  input: {
    actor: string;
    command: PolicyCommand;
    request: string;
    previous: AutonomyPolicy;
    policy: AutonomyPolicy;
    rule: SettingRule;
  },
) {
  const { command, previous, policy } = input;
  // One queue-row read, only on an edit that changes what landings are pinned to.
  const invalidatedLandings =
    acceptancePolicyDigest(previous) === acceptancePolicyDigest(policy)
      ? 0
      : ((await landingQueue(ctx, { projectId: project._id, channel: 'main' }))?.status?.total ?? 0);
  await ctx.db.patch(project._id, { autonomyPolicy: policy });
  await ctx.db.insert('projectPolicyChanges', {
    projectId: project._id,
    operationId: command.operationId,
    actor: input.actor,
    request: input.request,
    previous,
    policy,
    invalidatedLandings,
    rule: input.rule,
    at: new Date().toISOString(),
  });
  await recordMutationReceipt(ctx, {
    projectId: project._id,
    actor: input.actor,
    operationId: command.operationId,
    action: 'set-policy',
  });
  return {
    operationId: command.operationId,
    policy: receiptPolicy(policy),
    invalidatedLandings,
    rule: input.rule,
  };
}
export const set = mutation({
  args: { projectId: v.id('hostedProjects'), command: v.string() },
  returns: v.object({
    operationId: v.string(),
    policy: autonomyPolicy,
    /** Queued or checking landings this edit invalidated (their pinned policy no longer matches); 0 when it changed nothing a landing depends on. Absent on a replay. */
    invalidatedLandings: v.optional(v.number()),
    /** Issue 470ef29b: who could write it (SettingRule); `held` means nothing changed yet. Absent on replays of edits from before it existed. */
    rule: v.optional(settingRuleValidator),
    /** A held edit: the owner's approval request, its link and how to wait for it. */
    approval: v.optional(
      v.object({
        id: v.string(),
        status: v.union(v.literal('requested'), v.literal('granted'), v.literal('declined')),
        live: v.boolean(),
        url: v.union(v.string(), v.null()),
        next: v.string(),
      }),
    ),
  }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change project policy.');
      // Forge currently has owners/contributors, not a general maintainer role.
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      const { command, request } = parsePolicyCommand(input.command);
      const original = await ctx.db
        .query('projectPolicyChanges')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', command.operationId),
        )
        .unique();
      if (original) {
        invariant(
          original.actor === user.subject && original.request === request,
          'WORK_OPERATION_CHANGED',
          'Retry policy with its original values.',
        );
        return {
          operationId: command.operationId,
          policy: receiptPolicy(original.policy),
          ...(original.invalidatedLandings === undefined
            ? {}
            : { invalidatedLandings: original.invalidatedLandings }),
          ...(original.rule ? { rule: original.rule } : {}),
        };
      }
      const previous = effectivePolicy(project);
      const device = isDeviceIdentity(user);
      const pending = device
        ? await heldReplay(ctx, input.projectId, POLICY_KEY, command.operationId, request)
        : null;
      if (pending) return heldPolicyReply(pending, previous, command.operationId);
      invariant(
        !command.expectedPolicy || samePolicy(command.expectedPolicy, previous),
        'POLICY_CHANGED',
        'Project policy changed. Refresh it before editing.',
      );
      const policy = editedPolicy(previous, command);
      if (command.githubMirror && policy.githubMirror?.autoPush)
        await requireStoredRepositoryBinding(ctx, input.projectId, policy.githubMirror.repo);
      const rule: SettingRule = !device
        ? 'owner-person'
        : gatesLandings(previous, policy)
          ? await agentSettingRule(ctx, input.projectId, user)
          : 'no-gate-change';
      if (rule === 'held') {
        const row = await holdSetting(ctx, {
          projectId: input.projectId,
          key: POLICY_KEY,
          origin: 'policy',
          operationId: command.operationId,
          requester: user.subject,
          request,
          summary: `Policy change (${changedFields(command).join(', ') || 'no fields'}) from an agent sign-in.`,
          base: policyBase(previous),
        });
        return heldPolicyReply(row, previous, command.operationId);
      }
      return await writePolicy(ctx, project, {
        actor: user.subject,
        command,
        request,
        previous,
        policy,
        rule,
      });
    } catch (error) {
      return report(error);
    }
  },
});
/** The fields a set-policy command edits, for the owner's one-line summary. */
const changedFields = (command: PolicyCommand) =>
  Object.keys(command).filter(
    key => !['action', 'operationId', 'expectedPolicy', 'governanceVersion'].includes(key),
  );
/** Issue 470ef29b: the owner person granted an agent's held edit. It applies only to the policy the
 * request was made against, as the agent's operation (its retry then returns this receipt). */
export async function applyApprovedPolicy(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  text: string,
  base: string | undefined,
) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user && !isDeviceIdentity(user), 'PROJECT_UNAVAILABLE', 'Only the owner person can grant this.');
  const project = await activeOwnedProject(ctx, projectId, user.subject);
  const { command, request } = parsePolicyCommand(text);
  const previous = effectivePolicy(project);
  invariant(
    base === policyBase(previous),
    'POLICY_CHANGED',
    'Project policy changed since this request; decline it and ask the builder to request the change again.',
  );
  const policy = editedPolicy(previous, command);
  if (command.githubMirror && policy.githubMirror?.autoPush)
    await requireStoredRepositoryBinding(ctx, projectId, policy.githubMirror.repo);
  return writePolicy(ctx, project, {
    actor: user.subject,
    command,
    request,
    previous,
    policy,
    rule: 'owner-approved',
  });
}
