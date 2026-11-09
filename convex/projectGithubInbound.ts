// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { mirrorJob } from './projectGithubMirrorRows';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { hostedWriteProject, writeHostedRecord } from './projectHostedRecords';
import { hostedStartMain } from './projectHostedChannels';
import { saveObject } from './projectHostedSaveStore';
import { beginHostedOperation } from './projectHostedOperations';
import { hostedComposeInput, loadCompose, type ComposeState } from './projectHostedComposeStore';
import { submitHostedCompose } from './projectHostedComposeJobs';
import { submitDesiredLanding } from './projectHostedLandingDesired';
import { checkSetting } from './projectHostedCheckStore';
import { prepareObjectTargets } from './projectObjects';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { githubSyncCommitSchema } from '../src/github-sync-types';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { hostedLandingDesiredSchema } from '../src/hosted-landing-desired';
import { buildComposePages } from '../src/hosted-compose';
import { savePin } from '../src/hosted-save';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { inboundMessage, type InboundJob } from '../src/github-inbound-job';
import { finish, parseInbound, twoWay } from './projectGithubInboundQueue';
import { invariant } from '../src/errors';

const identity = { jobId: v.id('projectGithubMirrorJobs'), step: v.number() };
const pin = v.object({ sha256: v.string(), size: v.number() });
/** What the inbound action needs: the GitHub commit the mirror last recorded, the State it
 * matches (`equivalent`) and the accepted State the Lane starts from (`base`). */
export async function inboundBegin(
  ctx: MutationCtx,
  input: { jobId: Id<'projectGithubMirrorJobs'>; step: number },
) {
  const active = await mirrorJob(ctx, input);
  if (!active) return null;
  const { job, queue, project } = active;
  invariant(twoWay(project), 'GITHUB_SYNC_DISABLED', 'Two-way sync is off for this mirror.');
  const inbound = parseInbound(job);
  if (inbound.phase === 'landing') return null;
  invariant(
    queue.mapping,
    'GITHUB_INBOUND_UNMAPPED',
    'GitHub main has no recorded mirror commit yet; publish one Forge landing first.',
  );
  const mapping = githubSyncCommitSchema.parse(JSON.parse(queue.mapping));
  const row = await acceptanceRow(ctx, { projectId: project._id, receiptId: mapping.acceptanceId });
  invariant(row, 'SOURCE_UNAVAILABLE', 'The mirrored acceptance receipt is unavailable.');
  const receipt = hostedAcceptanceSchema.parse(JSON.parse(row.value));
  if (job.status !== 'running') await ctx.db.patch(job._id, { status: 'running' });
  return {
    inbound: true as const,
    projectId: project._id,
    owner: project.owner,
    repository: job.repository,
    phase: inbound.phase,
    uploads: inbound.uploads ?? null,
    mapping: { commit: mapping.commit, tree: mapping.tree, state: mapping.state },
    base: { head: receipt.candidate.head, receiptId: receipt.id },
  };
}
/** Upload targets for one window of at most 99 new objects, charged to the project owner. */
export const prepareUploads = internalMutation({
  args: { ...identity, objects: v.array(pin) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const active = await mirrorJob(ctx, input);
    invariant(active?.job.inbound, 'GITHUB_SYNC_PENDING', 'Inbound step changed.');
    invariant(input.objects.length <= 99, 'BAD_ARGUMENT', 'Prepare at most 99 objects at once.');
    return JSON.stringify(
      await prepareObjectTargets(
        ctx,
        active.project._id,
        active.project.owner,
        input.objects.map(object => ({ digest: object.sha256, size: object.size })),
      ),
    );
  },
});
/** GitHub main is the recorded commit (Forge's own push), or holds the same tree: no landing. */
export const adopt = internalMutation({
  args: { ...identity, commit: v.string(), tree: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const active = await mirrorJob(ctx, input);
    if (!active?.job.inbound) return null;
    const { job, queue } = active;
    const mapping = githubSyncCommitSchema.parse(JSON.parse(queue.mapping!));
    const entry =
      mapping.commit === input.commit
        ? mapping
        : { ...mapping, parent: mapping.commit, commit: input.commit, tree: input.tree };
    await finish(ctx, job, queue, entry, 'done');
    return null;
  },
});
/** The project's verify check, or its only check; null lets project policy decide. */
async function checkRequest(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const rows = await ctx.db
    .query('projectHostedCheckSettings')
    .withIndex('by_project_and_kind', q => q.eq('projectId', projectId).eq('kind', 'definition'))
    .take(100);
  const checks = rows.map(row => ({ key: row.key, value: JSON.parse(row.value) }));
  const selected =
    checks.find(row => row.value.name === 'verify') ?? (checks.length === 1 ? checks[0] : null);
  if (!selected) return null;
  const runner = await checkSetting(ctx, projectId, 'runner', 'runner');
  if (!runner) return null;
  const configuration = JSON.parse(runner.value);
  return {
    kind: 'request' as const,
    checkId: selected.key,
    expectedDefinition: selected.value.definition,
    expectedConfiguration: runner.digest,
    expectedEnvironment: configuration.environmentFingerprint,
  };
}
const submitArgs = {
  ...identity,
  commit: v.string(),
  tree: v.string(),
  message: v.string(),
  head: pin,
  equivalent: pin,
  changes: v.number(),
  paths: v.array(v.string()),
};
/** One transaction writes the inbound Intent and Lane (as the project owner, an agent-kind
 * actor) and its composition; the action then uploads the small compose metadata. */
export const submit = internalMutation({
  args: submitArgs,
  returns: v.string(),
  handler: async (ctx, input) => {
    const active = await mirrorJob(ctx, input);
    invariant(active?.job.inbound, 'GITHUB_SYNC_PENDING', 'Inbound step changed.');
    const { job, project } = active;
    const inbound = parseInbound(job);
    if (inbound.phase !== 'pending') return canonicalPayload({ uploads: inbound.uploads ?? [] });
    const begun = (await inboundBegin(ctx, input))!;
    const actor = project.owner,
      epoch = project.sourceAuthority!.epoch;
    await hostedWriteProject(ctx, project._id, actor, epoch);
    const receipt = hostedAcceptanceSchema.parse(
      JSON.parse(
        (await acceptanceRow(ctx, { projectId: project._id, receiptId: begun.base.receiptId }))!.value,
      ),
    );
    const head = await saveObject(ctx, project._id, input.head);
    await saveObject(ctx, project._id, input.equivalent);
    const ids = {
      intent: crypto.randomUUID(),
      lane: crypto.randomUUID(),
      compose: crypto.randomUUID(),
      landing: crypto.randomUUID(),
    };
    const at = new Date().toISOString();
    const message = inboundMessage({
      commit: input.commit,
      message: input.message,
      repository: job.repository,
    });
    const outcome = `Bring in GitHub ${job.repository} main ${input.commit.slice(0, 12)}`;
    await writeHostedRecord(ctx, {
      projectId: project._id,
      actor,
      authorityEpoch: epoch,
      expectedVersion: null,
      record: {
        kind: 'intent',
        id: ids.intent,
        version: 0,
        at,
        outcome,
        constraints: message.slice(0, 4000),
        creatorAccountId: actor,
        assigneeAccountIds: [],
        base: begun.base,
        status: 'active',
      },
    });
    await writeHostedRecord(ctx, {
      projectId: project._id,
      actor,
      authorityEpoch: epoch,
      expectedVersion: null,
      // GitHub content is not the owner's own edit: protected paths still need owner review.
      ownerOnly: false,
      overlap: { baseSequence: receipt.snapshot.revision, intent: outcome, agent: 'github-inbound' },
      record: {
        kind: 'lane',
        id: ids.lane,
        intentId: ids.intent,
        actor,
        version: 0,
        at,
        base: begun.base,
        head: input.head.sha256,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        authorityEpoch: epoch,
      },
    });
    const main = await hostedStartMain(ctx, project._id);
    const inputs = buildComposePages([
      {
        laneId: ids.lane,
        head: input.head.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: head,
      },
    ]);
    const dependencies = buildComposePages([]);
    const request = {
      operationId: ids.compose,
      intentId: ids.intent,
      authorityEpoch: epoch,
      expectedMain: { head: main.head, receiptId: main.receipt.id },
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
      message,
    };
    const expected = { authorityEpoch: epoch };
    const first = {
      projectId: project._id,
      operationId: ids.compose,
      id: crypto.randomUUID(),
      parentAttemptId: null,
      at,
      expected,
      ids: { candidate: crypto.randomUUID(), job: crypto.randomUUID(), jobOperation: crypto.randomUUID() },
    };
    await beginHostedOperation(ctx, {
      projectId: project._id,
      actor,
      payload: request,
      request: {
        schema: 1,
        projectId: project._id,
        actor,
        operationId: ids.compose,
        expected,
        payloadHash: hostedPayloadHash(request, expected),
      },
      firstAttempt: first,
    });
    const compose: ComposeState = {
      request,
      ownerInputs: false,
      main: await saveObject(ctx, project._id, { sha256: main.head }),
      inputs: { next: null, pages: 1, count: 1 },
      dependencies: { next: null, pages: 1, count: 0 },
      candidateId: first.ids.candidate,
      jobOperationId: first.ids.jobOperation,
      status: 'ready',
    };
    await ctx.db.insert('projectHostedComposes', {
      projectId: project._id,
      actor,
      operationId: ids.compose,
      jobId: first.ids.job,
      value: canonicalPayload(compose),
    });
    await ctx.db.insert('projectHostedComposeSelections', {
      projectId: project._id,
      actor,
      operationId: ids.compose,
      kind: 'inputs',
      key: ids.lane,
    });
    const uploads = [...inputs.pages, ...dependencies.pages].map(page => ({
      value: canonicalPayload(page.value),
      pin: page.pin,
    }));
    const value = canonicalPayload(hostedComposeInput(compose, at));
    uploads.push({ value, pin: savePin(JSON.parse(value)) });
    const next: InboundJob = {
      phase: 'compose',
      commit: input.commit,
      tree: input.tree,
      message: input.message.slice(0, 4000),
      equivalent: input.equivalent.sha256,
      base: begun.base,
      intentId: ids.intent,
      laneId: ids.lane,
      composeOperationId: ids.compose,
      landingOperationId: ids.landing,
      changes: input.changes,
      paths: input.paths.slice(0, 20),
      uploads,
    };
    await ctx.db.patch(job._id, { inbound: canonicalPayload(next), state: input.head.sha256 });
    return canonicalPayload({ uploads });
  },
});
/** After the action uploaded the compose metadata: bind it, submit the composition and the
 * desired landing through the normal pipeline. The job then holds the queue until it settles. */
export const land = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    const active = await mirrorJob(ctx, input);
    invariant(active?.job.inbound, 'GITHUB_SYNC_PENDING', 'Inbound step changed.');
    const { job, project } = active;
    const inbound = parseInbound(job);
    if (inbound.phase !== 'compose') return null;
    // The action stored these through prepareUploads; bind exactly the bytes this job named.
    for (const upload of inbound.uploads ?? [])
      invariant(
        upload.pin.size <= 128 * 1024 && savePin(JSON.parse(upload.value)).sha256 === upload.pin.sha256,
        'SOURCE_HASH_MISMATCH',
        'Inbound metadata differs.',
      );
    const actor = project.owner;
    await submitHostedCompose(ctx, {
      projectId: project._id,
      actor,
      operationId: inbound.composeOperationId!,
    });
    const composed = await loadCompose(
      ctx,
      { projectId: project._id, actor, operationId: inbound.composeOperationId! },
      false,
    );
    const state = hostedLandingStateSchema.parse(
      JSON.parse(
        await submitDesiredLanding(
          ctx,
          project._id,
          hostedLandingDesiredSchema.parse({
            operationId: inbound.landingOperationId!,
            authorityEpoch: composed.state.request.authorityEpoch,
            check: await checkRequest(ctx, project._id),
            message: composed.state.request.message,
            composeOperationId: inbound.composeOperationId!,
            after: null,
          }),
          { id: actor, kind: 'agent' },
          'github-inbound',
        ),
      ),
    );
    const { uploads: _uploads, ...rest } = inbound;
    void _uploads;
    await ctx.db.patch(job._id, {
      inbound: canonicalPayload({ ...rest, phase: 'landing', submissionId: state.id } satisfies InboundJob),
    });
    return null;
  },
});
