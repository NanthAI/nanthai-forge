// SPDX-License-Identifier: Apache-2.0
import { assertHostedCheckActive, checkSetting } from './projectHostedCheckStore';
import { ConvexError, v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { writableHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { directActions, settleDirectActions } from './projectHostedActionsDirect';
import { hostedCheckTerminal, type HostedCheckRun } from '../src/hosted-check';
import {
  repositoryVisibility,
  runnerVisibilityRequired,
  runnerPublicCode,
  runnerPublicReason,
} from '../src/runner-visibility';
import { recordRepositoryVisibility } from './githubRepositoryVisibility';
import { actionsClaimsSchema, validateActionsClaims } from '../src/github-actions-oidc';
import { invariant } from '../src/errors';
import { githubHostedRunsOn } from '../src/github-actions-runner-label';
import { hostedActionsCapabilities } from '../src/hosted-actions-capabilities';
import { latestSourcePack } from './projectSourcePackStore';
import { hostedTimingHistory } from './projectHostedTestTimings';
import { submoduleAllowListSchema, type SubmoduleAllow } from '../src/submodule-allowlist';
import { runnerTokenScope } from './githubBindingAccess';
export const sessionArgs = {
  projectId: v.id('hostedProjects'),
  runId: v.string(),
  claims: v.string(),
  fence: v.optional(v.number()),
};
export type SessionInput = { projectId: Id<'hostedProjects'>; runId: string; claims: string; fence?: number };
/** HTTP verifies the JWT signature. Every transaction rechecks current epoch,
 * original actor authority, dispatch fence, and exact repository/workflow/run. */
export async function actionsSession(ctx: MutationCtx, input: SessionInput) {
  const selected = await writableHostedCheck(ctx, input),
    { row, run, project } = selected;
  assertHostedCheckActive(run);
  invariant(
    directActions(run) &&
      run.configuration.provider === 'github-actions' &&
      run.dispatchStarted &&
      run.actions &&
      run.actions.fence === run.fence &&
      (input.fence === undefined || input.fence === run.fence),
    'WORK_STALE',
    'Actions dispatch is no longer current.',
  );
  const claims = sessionClaims(run, input);
  // Fresh on every runner call, before any source or plan: a repository made
  // public after connecting is refused here even inside the dispatch cache window.
  // ConvexError keeps the code across the HTTP action boundary.
  if (
    runnerVisibilityRequired(project.visibility, run.configuration) &&
    claims.repository_visibility !== 'private'
  )
    throw new ConvexError({
      code: runnerPublicCode,
      message: runnerPublicReason(run.configuration.repository, claims.repository_visibility),
    });
  if (!run.actions.workflowSha) {
    run.actions.workflowSha = claims.workflow_sha;
    await writeHostedCheck(ctx, row._id, run);
  }
  return selected;
}
function sessionClaims(run: HostedCheckRun, input: SessionInput) {
  invariant(run.configuration.provider === 'github-actions', 'WORK_STALE', 'Select Actions.');
  const claims = validateActionsClaims(actionsClaimsSchema.parse(JSON.parse(input.claims)), {
    audience: process.env.CONVEX_SITE_URL!,
    repository: run.configuration.repository,
    executionId: run.executionId,
    workflowSha: run.actions?.workflowSha,
    selfHosted: !githubHostedRunsOn(run.configuration.runsOn ?? 'ubuntu-latest'),
  });
  // Binding is provided by dispatch response or HMAC webhook, never "first JWT wins".
  invariant(
    run.executionId === claims.run_id,
    'EVIDENCE_CHANGED',
    'Await the original Actions dispatch acknowledgement or workflow_run event.',
  );
  return claims;
}
/** The owner's current submodule policy for this run's runner: one settings read. The
 * current row, not the run's pinned copy, so a withdrawal applies to running checks; a
 * runner moved to another repository allows nothing for runs of the old one. A fork pull
 * request's run (Issue f7793473) is allowed nothing, whatever the allowlist says. Check logs
 * are public when the owner accepted that or the run's repository is not proven private
 * by the verified OIDC claims (`repository_visibility`; absent counts as public). */
async function submodulePolicy(
  ctx: MutationCtx,
  input: SessionInput,
  run: { configuration: object; request: { origin?: 'fork-pull' } },
) {
  const row = await checkSetting(ctx, input.projectId, 'runner', 'runner');
  const current = row
    ? (JSON.parse(row.value) as {
        provider?: unknown;
        repository?: unknown;
        publicLogs?: unknown;
        submodules?: unknown;
      })
    : null;
  const pinned = run.configuration as { repository?: string; publicLogs?: true };
  const same =
    current?.provider === 'github-actions' &&
    typeof current.repository === 'string' &&
    current.repository.toLowerCase() === pinned.repository?.toLowerCase();
  const listed = same ? submoduleAllowListSchema.safeParse(current.submodules) : null;
  const submodules: SubmoduleAllow[] =
    listed?.success && run.request.origin !== 'fork-pull' ? listed.data : [];
  const claimed = (JSON.parse(input.claims) as { repository_visibility?: unknown }).repository_visibility;
  const logsPublic =
    pinned.publicLogs === true ||
    (same && current.publicLogs === true) ||
    repositoryVisibility({ visibility: claimed }) !== 'private';
  return { submodules, logsPublic };
}
/** Only after a session refused a public runner (HTTP, verified claims): settle the
 * run with the reason and remember the visibility so the next dispatch refuses early. */
export const refusePublicRunner = internalMutation({
  args: sessionArgs,
  returns: v.null(),
  handler: async (ctx, input) => {
    const selected = await writableHostedCheck(ctx, input),
      { run, project } = selected;
    if (hostedCheckTerminal(run) || !directActions(run) || run.configuration.provider !== 'github-actions')
      return null;
    const claims = sessionClaims(run, input),
      visibility = claims.repository_visibility;
    if (!runnerVisibilityRequired(project.visibility, run.configuration) || visibility === 'private')
      return null;
    if (visibility) await recordRepositoryVisibility(ctx, run.configuration.repository, visibility);
    await settleDirectActions(
      ctx,
      selected,
      'runner-unavailable',
      runnerPublicReason(run.configuration.repository, visibility),
    );
    return null;
  },
});
export const session = internalMutation({
  args: { ...sessionArgs, timings: v.optional(v.boolean()), submodules: v.optional(v.boolean()) },
  // JSON text (Issue 0c457ae4): a finished run's reports are keyed by test file.
  returns: v.string(),
  handler: async (ctx, input) => {
    const { run } = await actionsSession(ctx, input);
    if (input.submodules)
      return JSON.stringify({
        run,
        policy: await submodulePolicy(ctx, input, run),
        runnerScope:
          run.configuration.provider === 'github-actions'
            ? await runnerTokenScope(ctx, input.projectId, run.configuration.repository)
            : null,
      });
    if (!input.timings) return JSON.stringify({ ...run, capabilities: [...hostedActionsCapabilities] });
    const { history } = await hostedTimingHistory(ctx, input.projectId);
    return JSON.stringify({
      run,
      capabilities: [...hostedActionsCapabilities],
      timingHistory: JSON.stringify(history),
      sourcePack: await latestSourcePack(ctx, input.projectId),
    });
  },
});
