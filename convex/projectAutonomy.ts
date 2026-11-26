// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { resolveUncheckedSelection } from './projectUncheckedLanding';
import { requireStoredRepositoryBinding } from './githubBindingAccess';
import { ensureMirrorRow, mirrorRow } from './projectGithubMirrorRows';
import { wakeHeldMirror } from './projectGithubMirrorCadence';
import { v } from 'convex/values';
import { TRUST_DEFAULTS } from '../src/agent-trust';
import { earnedTrustOffered } from './projectCreation';
import {
  query,
  mutation,
  guard,
  isDeviceIdentity,
  type QueryCtx,
  type MutationCtx,
  type ActionCtx,
} from './cliServer';
import { projectSettingsReader, activeOwnedProject } from './projectAuthority';
import { autonomyPolicy, policyImpactFields } from './autonomyFields';
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
import { acceptancePolicyDigest, ownerGated, weakensBootstrapGovernance } from '../src/policy-digest';
import { policyImpactReceipt } from './projectHostedLandingPolicyImpact';
import { policyImpactMessage } from '../src/policy-impact-receipt';
import { report } from './errors';
import { recordMutationReceipt } from './projectSelfMetricReceiptStore';
import { callerActorKind } from './metricActorKind';
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
import { digest } from '../src/state/hash';
import { retargetGithubMirror } from './projectGithubMirrorRetarget';
import { resumeMirrorQueue } from './projectGithubMirrorCatchup';
import { rescheduleMainAudit } from './projectHostedMainAuditState';
import { beginRollupCatchup } from './projectPlanRollupCatchupStore';
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
      return policyReadView(effectivePolicy(await projectSettingsReader(ctx, input.projectId, user.subject)));
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
/** What a held edit is pinned to: the parts an agent may not change alone, so a later edit of agent
 * defaults or notifications does not void the owner's pending grant. A deploy edit replaces the
 * complete deploy settings. Its versioned pin includes them, and older requests keep their pin. */
const DEPLOY_POLICY_BASE = 'deploys:';
const policyBase = (policy: AutonomyPolicy, pinDeploys = false) =>
  (pinDeploys ? DEPLOY_POLICY_BASE : '') +
  digest(
    canonicalPayload({
      acceptance: acceptancePolicyDigest(policy),
      unchecked: policy.acceptance.withoutCheck ?? null,
      mirror: policy.githubMirror ?? null,
      ...(policy.mainAudit ? { mainAudit: policy.mainAudit } : {}),
      ...(pinDeploys ? { deploys: policy.deploys ?? null } : {}),
    }),
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
  const impact = await policyImpactReceipt(ctx, project._id, previous, policy);
  const mirror = policy.githubMirror;
  const sameMirror = mirror?.repo.toLowerCase() === previous.githubMirror?.repo.toLowerCase();
  // Keep the disabled policy readable by existing CLIs (inbound:false); the project retains the resume choice.
  const pausedInbound =
    mirror && !mirror.autoPush && sameMirror
      ? previous.githubMirror?.autoPush
        ? previous.githubMirror.inbound === true
        : project.githubMirrorPausedInbound
      : undefined;
  await ctx.db.patch(project._id, {
    autonomyPolicy: policy,
    githubMirrorPausedInbound: pausedInbound,
    ...(command.teamTrustChoice ? { offerEarnedTrust: undefined } : {}),
  });
  if (previous.rollUpPlanningStatus === false && policy.rollUpPlanningStatus !== false)
    await beginRollupCatchup(ctx, { ...project, autonomyPolicy: policy }, command.operationId);
  if (
    command.mainAudit &&
    canonicalPayload(previous.mainAudit ?? null) !== canonicalPayload(policy.mainAudit ?? null)
  )
    await rescheduleMainAudit(ctx, { ...project, autonomyPolicy: policy });
  // Friction 77518c88: connecting GitHub sync creates the mirror queue row the pull request and
  // push webhooks look up, so the first PR is checked without a landing first. Only on an edit that
  // changes the connection: one indexed read, one insert at most; every other edit adds nothing.
  if (
    mirror?.autoPush &&
    project.sourceAuthority?.mode === 'server' &&
    canonicalPayload(previous.githubMirror ?? null) !== canonicalPayload(mirror)
  )
    await ensureMirrorRow(ctx, project._id, mirror.repo, mirror.branch);
  // A mirror pointed at another repository re-points its queue row now, off the landing path
  // (one indexed read, only when this edit sets the mirror).
  if (command.githubMirror && policy.githubMirror?.autoPush)
    await retargetGithubMirror(ctx, project._id, policy.githubMirror.repo, policy.githubMirror.branch);
  if (mirror?.autoPush && mirror.push === 'every-landing' && previous.githubMirror?.push !== mirror.push) {
    const queue = await mirrorRow(ctx, project._id);
    if (queue?.hold && !queue.hold.red) await wakeHeldMirror(ctx, queue, Date.now(), 'every');
  }
  // Un-pause is atomic: a lost web reply cannot leave a retained job and catch-up asleep. An
  // un-pause that also changes the repository has just retargeted the queue (no mapping), so
  // the same call queues current main for the new repository.
  if (
    project.sourceAuthority?.mode === 'server' &&
    previous.githubMirror?.autoPush === false &&
    mirror?.autoPush
  )
    await resumeMirrorQueue(ctx, { ...project, autonomyPolicy: policy }, true);
  await ctx.db.insert('projectPolicyChanges', {
    projectId: project._id,
    operationId: command.operationId,
    actor: input.actor,
    request: input.request,
    previous,
    policy,
    ...impact,
    rule: input.rule,
    at: new Date().toISOString(),
  });
  await recordMutationReceipt(ctx, {
    projectId: project._id,
    actor: input.actor,
    operationId: command.operationId,
    action: 'set-policy',
    actorKind: await callerActorKind(ctx, input.actor),
  });
  return {
    operationId: command.operationId,
    policy: receiptPolicy(policy),
    ...impact,
    impactMessage: policyImpactMessage(impact),
    rule: input.rule,
  };
}
/** `nforge github connect`: the owner's GitHub authorization of the repository is also the approval
 * to mirror Forge main there (publish and two-way sync), the owner-approved edit a second set-policy
 * would have asked for. A mirror that is already on, for any repository, is left as it is. */
export async function enableConnectedMirror(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    repo: string;
    operationId: string;
    /** Two-way (the default) takes GitHub pushes back in; false is one-way, Forge to GitHub. */
    inbound?: boolean;
  },
) {
  const project = await activeOwnedProject(ctx, input.projectId, input.actor);
  const previous = effectivePolicy(project);
  if (previous.githubMirror?.autoPush) return 'kept' as const;
  await requireStoredRepositoryBinding(ctx, input.projectId, input.repo);
  const command = policyWriteSchema.parse({
    action: 'set-policy',
    operationId: input.operationId,
    githubMirror: { repo: input.repo, autoPush: true, laneRefs: false, inbound: input.inbound !== false },
  });
  await writePolicy(ctx, project, {
    actor: input.actor,
    command,
    request: JSON.stringify(command),
    previous,
    policy: editedPolicy(previous, command),
    rule: 'owner-approved',
  });
  return 'enabled' as const;
}
/** Disconnect removes the matching mirror policy in the binding-removal transaction. */
export async function disconnectMirrorPolicy(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  actor: string,
  operationId: string,
  repository: string,
) {
  const previous = effectivePolicy(project);
  if (previous.githubMirror?.repo.toLowerCase() !== repository.toLowerCase()) return;
  const policy = { ...previous, preset: 'custom' as const };
  delete policy.githubMirror;
  const command = policyWriteSchema.parse({ action: 'set-policy', operationId });
  await writePolicy(ctx, project, {
    actor,
    command,
    request: JSON.stringify(command),
    previous,
    policy,
    rule: 'owner-person',
  });
}
export const set = mutation({
  args: { projectId: v.id('hostedProjects'), command: v.string() },
  returns: v.object({
    operationId: v.string(),
    policy: autonomyPolicy,
    dryRun: v.optional(v.literal(true)),
    ...policyImpactFields,
    impactAt: v.optional(v.string()),
    impactMessage: v.optional(v.string()),
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
      invariant(
        !isDeviceIdentity(user) ||
          !command.githubMirror ||
          (command.githubMirror.autoPush && effectivePolicy(project).githubMirror?.autoPush !== false),
        'PROJECT_UNAVAILABLE',
        'Only the owner person can pause or un-pause the GitHub mirror. Open Forge → Settings → GitHub mirror.',
      );
      const original = command.dryRun
        ? null
        : await ctx.db
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
        const impact = {
          ...(original.invalidatedLandings === undefined
            ? {}
            : { invalidatedLandings: original.invalidatedLandings }),
          ...(original.invalidatedSubmissionIds === undefined
            ? {}
            : { invalidatedSubmissionIds: original.invalidatedSubmissionIds }),
          ...(original.impactComplete === false ? { impactComplete: false as const } : {}),
          ...(original.impactUnexamined === undefined ? {} : { impactUnexamined: original.impactUnexamined }),
          ...(original.invalidatedByPhase === undefined
            ? {}
            : { invalidatedByPhase: original.invalidatedByPhase }),
          ...(original.heldForReview === undefined ? {} : { heldForReview: original.heldForReview }),
          ...(original.idsTruncated ? { idsTruncated: true as const } : {}),
        };
        const impactMessage = policyImpactMessage(impact);
        return {
          operationId: command.operationId,
          policy: receiptPolicy(original.policy),
          ...impact,
          ...(impactMessage === undefined ? {} : { impactMessage }),
          ...(original.rule ? { rule: original.rule } : {}),
        };
      }
      const previous = effectivePolicy(project);
      const device = isDeviceIdentity(user);
      const pending =
        device && !command.dryRun
          ? await heldReplay(ctx, input.projectId, POLICY_KEY, command.operationId, request)
          : null;
      if (pending) return heldPolicyReply(pending, previous, command.operationId);
      if (command.expectedPolicy?.acceptance.withoutCheck)
        command.expectedPolicy.acceptance.withoutCheck = await resolveUncheckedSelection(
          ctx,
          project,
          command.expectedPolicy.acceptance.withoutCheck,
          undefined,
          false,
        );
      invariant(
        !command.expectedPolicy || samePolicy(command.expectedPolicy, previous),
        'POLICY_CHANGED',
        'Project policy changed. Refresh it before editing.',
      );
      invariant(
        !command.teamTrustChoice || (!device && (await earnedTrustOffered(ctx, project))),
        'BAD_ARGUMENT',
        'The earned-trust choice is available to the owner when a new project has another member.',
      );
      const policy =
        command.teamTrustChoice === 'keep'
          ? previous
          : editedPolicy(
              previous,
              command.teamTrustChoice === 'enable'
                ? {
                    ...command,
                    acceptance: { ...command.acceptance, gate: 'contract' },
                    trust: { enabled: true, ...TRUST_DEFAULTS, establishedVendors: [project.owner] },
                  }
                : command,
            );
      if (command.acceptance?.withoutCheck)
        policy.acceptance.withoutCheck = await resolveUncheckedSelection(
          ctx,
          project,
          command.acceptance.withoutCheck,
          previous.acceptance.withoutCheck,
        );
      if (command.githubMirror && policy.githubMirror?.autoPush)
        await requireStoredRepositoryBinding(ctx, input.projectId, policy.githubMirror.repo);
      let rule: SettingRule = 'owner-person';
      if (device) {
        if (weakensBootstrapGovernance(previous, policy)) rule = 'held';
        else if (ownerGated(previous, policy)) rule = await agentSettingRule(ctx, input.projectId, user);
        else rule = 'no-gate-change';
      }
      if (command.dryRun) {
        const impactAt = new Date().toISOString();
        const impact = await policyImpactReceipt(ctx, project._id, previous, policy);
        return {
          operationId: command.operationId,
          dryRun: true as const,
          policy: receiptPolicy(policy),
          ...impact,
          impactAt,
          impactMessage: policyImpactMessage(impact, impactAt),
          rule,
        };
      }
      if (rule === 'held') {
        const row = await holdSetting(ctx, {
          projectId: input.projectId,
          key: POLICY_KEY,
          origin: 'policy',
          operationId: command.operationId,
          requester: user.subject,
          request,
          summary: `Policy change (${changedFields(command).join(', ') || 'no fields'}) from an agent sign-in.`,
          base: policyBase(previous, command.deploys !== undefined),
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
    key => !['action', 'operationId', 'expectedPolicy', 'governanceVersion', 'dryRun'].includes(key),
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
    base === policyBase(previous, base?.startsWith(DEPLOY_POLICY_BASE)),
    'POLICY_CHANGED',
    'Project policy changed since this request; decline it and ask the builder to request the change again.',
  );
  const policy = editedPolicy(previous, command);
  if (command.acceptance?.withoutCheck)
    policy.acceptance.withoutCheck = await resolveUncheckedSelection(
      ctx,
      project,
      command.acceptance.withoutCheck,
      previous.acceptance.withoutCheck,
    );
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
