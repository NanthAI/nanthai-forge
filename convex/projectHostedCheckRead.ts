// SPDX-License-Identifier: Apache-2.0
import { isMachineRunner } from '../src/hosted-machine-runner';
import { v } from 'convex/values';
import { query, type QueryCtx, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { requireMacMachine } from './projectHostedCheckMachines';
import { effectivePolicy } from '../src/autonomy-policy';
import { checkPin, type HostedCheckRun } from '../src/hosted-check';
import { recordHead, hostedWriteProject } from './projectHostedRecords';
import { checkSetting, loadHostedCheck, type CheckIdentity } from './projectHostedCheckStore';
import { summarizeCheckRun } from '../src/hosted-check-summary';
import { exactHostedCheckEvidence } from '../src/hosted-check-evidence';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { boardWake } from './projectBoardDelivery';

const identity = { projectId: v.id('hostedProjects'), runId: v.string() };
export async function checkReader(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted checks.');
  await accessibleProject(ctx, projectId, user.subject);
}
export const status = query({
  args: {
    ...identity,
    features: v.optional(v.array(v.string())),
    board: v.optional(v.object({ laneId: v.string(), after: v.number() })),
  },
  returns: v.string(),
  handler: async (ctx, { features, board: cursor, ...input }) => {
    try {
      await checkReader(ctx, input.projectId);
      const { run } = await loadHostedCheck(ctx, input, !features?.includes('check-report-detail'));
      invariant(
        !run.reportPointer || features?.includes('check-report-detail'),
        'CLI_UPGRADE_REQUIRED',
        'Update the Forge CLI to read check report detail.',
      );
      if (features?.includes('check-report-detail')) delete run.contractReports;
      // Older CLIs parse runs strictly: a ci-status run goes only to callers that know its shape.
      invariant(
        run.configuration.provider !== 'ci-status' || Boolean(features?.includes('ci-status-check')),
        'BAD_ARGUMENT',
        `Check run ${run.id} uses the ci-status provider; update the Forge CLI to read it.`,
      );
      const user = cursor ? await ctx.auth.getUserIdentity() : null;
      const board =
        cursor && user
          ? await boardWake(ctx, {
              projectId: input.projectId,
              viewer: user.subject,
              ...cursor,
            })
          : undefined;
      return canonicalPayload({ ...run, ...(board ? { board } : {}) });
    } catch (error) {
      return report(error);
    }
  },
});
/** `status` without the 80 KB run: counts, failed and flaky file names, timings and selection scope in
 * under 8 KB. The same single run-row read as `status`; nothing else is read or written. */
export const summary = query({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await checkReader(ctx, input.projectId);
      return canonicalPayload(summarizeCheckRun((await loadHostedCheck(ctx, input)).run));
    } catch (error) {
      return report(error);
    }
  },
});
export const shards = query({
  args: { ...identity, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await checkReader(ctx, input.projectId);
      await loadHostedCheck(ctx, input);
      const page = await ctx.db
        .query('projectHostedCheckShards')
        .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
        .paginate({
          cursor: input.cursor,
          numItems: 100,
          maximumRowsRead: 100,
          maximumBytesRead: 128 * 1024,
        });
      return canonicalPayload({ ...page, page: page.page.map(row => JSON.parse(row.value)) });
    } catch (error) {
      return report(error);
    }
  },
});
export const list = query({
  args: { projectId: v.id('hostedProjects'), candidateId: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await checkReader(ctx, input.projectId);
      const page = await ctx.db
        .query('projectHostedCheckRuns')
        .withIndex('by_project_and_candidate', q =>
          q.eq('projectId', input.projectId).eq('candidateId', input.candidateId),
        )
        .paginate({
          cursor: input.cursor,
          numItems: 100,
          maximumRowsRead: 100,
          maximumBytesRead: 128 * 1024,
        });
      return canonicalPayload({
        ...page,
        page: page.page.map(row => ({
          runId: row.runId,
          candidateId: row.candidateId,
          status: row.status,
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});
/** H13/H14 call this inside their own transaction, then independently check
 * current landing policy and main head+receipt. A result never grants acceptance. */
export async function requireHostedCheckEvidence(
  ctx: QueryCtx | MutationCtx,
  input: CheckIdentity & {
    actor: string;
    candidateId: string;
    head: string;
    checkId: string;
    definition: string;
    configuration: string;
    environment: string;
    authorityEpoch: number;
  },
  // A canonical run already loaded in this transaction; authority and current settings still recheck.
  loadedRun?: HostedCheckRun,
) {
  const project = await hostedWriteProject(ctx, input.projectId, input.actor, input.authorityEpoch);
  const selected = loadedRun ? null : await loadHostedCheck(ctx, input, false);
  const run = loadedRun ?? selected!.run;
  invariant(
    run.id === input.runId && run.projectId === input.projectId,
    'EVIDENCE_CHANGED',
    'Hosted run identity differs from its record.',
  );
  if (run.actor !== input.actor)
    await hostedWriteProject(ctx, input.projectId, run.actor, input.authorityEpoch);
  const check = await checkSetting(ctx, input.projectId, 'definition', input.checkId);
  const runner = await checkSetting(ctx, input.projectId, 'runner', 'runner');
  invariant(
    check?.digest === input.definition && runner?.digest === input.configuration,
    'EVIDENCE_CHANGED',
    'The current check definition or runner configuration changed.',
  );
  let sameTreeReuse = false;
  if (run.request.candidateId !== input.candidateId) {
    const row = selected?.row ?? (await loadHostedCheck(ctx, input, false)).row;
    const alias = await ctx.db
      .query('projectHostedCheckCallbacks')
      .withIndex('by_project_and_run_and_event', q =>
        q.eq('projectId', input.projectId).eq('runId', run.id).eq('eventId', `reuse:${input.candidateId}`),
      )
      .unique();
    sameTreeReuse = Boolean(row.verdictKey && alias?.digest === row.verdictKey);
  }
  exactHostedCheckEvidence(run, input, sameTreeReuse);
  if (isMachineRunner(run.configuration)) {
    const machineId = run.configuration.machineId;
    const machine = await requireMacMachine(ctx, input.projectId, machineId);
    const evidence = run.macEvidence;
    invariant(
      evidence &&
        evidence.machineId === machineId &&
        evidence.machineOwner === machine.actor &&
        evidence.runnerFingerprint ===
          checkPin({
            runtime: run.configuration.runtime,
            environmentFingerprint: run.configuration.environmentFingerprint,
          }),
      'EVIDENCE_CHANGED',
      `Runner machine ${machineId} has no matching completed-run receipt.`,
    );
    const head = await recordHead(ctx, input.projectId, 'candidate', input.candidateId);
    const candidate = head ? await ctx.db.get(head.recordId) : null;
    invariant(
      effectivePolicy(project).acceptance.mode === 'auto-on-pass' &&
        machine.actor === project.owner &&
        run.actor === project.owner &&
        input.actor === project.owner &&
        candidate?.creatorAccountId === project.owner,
      'HOSTED_RUNNER_REQUIRED',
      `Runner machine ${machineId} evidence requires owner-controlled trusted or autonomous work; supervised projects and outside contributors need hosted-runner evidence.`,
    );
  }
  return run;
}
