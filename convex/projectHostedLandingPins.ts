// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { readHostedRecord, hostedWriteProject } from './projectHostedRecords';
import { hostedStartMain } from './projectHostedChannels';
import { enqueueHostedCheck } from './projectHostedChecks';
import { loadHostedCheck } from './projectHostedCheckStore';
import { saveObject } from './projectHostedSaveStore';
import { hostedRecordSchema } from '../src/hosted-records';
import {
  hostedLandingAttemptSchema,
  type HostedLandingRequest,
  type HostedLandingAttempt,
} from '../src/hosted-landing';
import { effectivePolicy, type AcceptanceActor } from '../src/autonomy-policy';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';

/** Pin canonical metadata once. H14 still rechecks current main/policy/evidence
 * in its final transaction; neither this snapshot nor ready grants acceptance. */
export async function pinLandingAttempt(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: AcceptanceActor;
    request: HostedLandingRequest;
    submissionId: string;
    attemptId: string;
    parentAttemptId: string | null;
    number: number;
    at: string;
    operations: { check: string; accept: string };
    allowStaleMain?: boolean;
    retainedSelection?: HostedLandingAttempt['candidate'];
  },
) {
  invariant(
    input.parentAttemptId === null || input.actor.kind === 'agent' || input.retainedSelection !== undefined,
    'VIEW_STALE',
    'A person request retains the exact reviewed Candidate; a different selection uses a new request.',
  );
  const r = input.request;
  const project = await hostedWriteProject(ctx, input.projectId, input.actor.id, r.authorityEpoch);
  const main = await hostedStartMain(ctx, input.projectId);
  invariant(
    main.authority.epoch === r.authorityEpoch && main.authority.mode === project.sourceAuthority?.mode,
    'SOURCE_AUTHORITY_CHANGED',
    'Main and current project source authority differ.',
  );
  invariant(
    input.allowStaleMain ||
      input.retainedSelection !== undefined ||
      (input.actor.kind === 'person' && r.finish !== undefined) ||
      (main.head === r.expectedMain.head && main.receipt.id === r.expectedMain.receiptId),
    'CHANNEL_CHANGED',
    'Select the current main head and receipt.',
  );
  const row = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: input.actor.id,
    kind: 'candidate',
    key: r.candidateId,
  });
  invariant(row, 'NOT_FOUND', 'Select a canonical hosted Candidate.');
  const candidate = hostedRecordSchema.parse(JSON.parse(row.value));
  invariant(
    candidate.kind === 'candidate' &&
      (candidate.result.status === 'clean'
        ? candidate.result.head === r.expectedHead
        : r.expectedHead === null),
    'VIEW_STALE',
    'Select the original Candidate and its exact clean head or conflict.',
  );
  invariant(
    candidate.base.head === r.expectedMain.head && candidate.base.receiptId === r.expectedMain.receiptId,
    'CHANNEL_CHANGED',
    'The Candidate retains a different main base receipt.',
  );
  if (input.retainedSelection) {
    invariant(
      canonicalPayload(candidate.inputs) === canonicalPayload(input.retainedSelection.inputs) &&
        canonicalPayload(candidate.dependencies) === canonicalPayload(input.retainedSelection.dependencies),
      'WORK_OPERATION_CHANGED',
      'A finish retry must retain the original ordered selection.',
    );
  }
  let check = null;
  if (candidate.result.status === 'clean') {
    const head = candidate.result.head;
    const registered = await ctx.db
      .query('projectHostedStates')
      .withIndex('by_project_and_head', q => q.eq('projectId', input.projectId).eq('head', head))
      .unique();
    invariant(registered, 'SOURCE_UNAVAILABLE', 'The clean Candidate needs trusted source registration.');
    const source = await saveObject(ctx, input.projectId, { sha256: head });
    invariant(
      source.object.size === registered.size,
      'SOURCE_HASH_MISMATCH',
      'Registered source size differs.',
    );
    if (r.check) {
      const run =
        r.check.kind === 'run'
          ? (await loadHostedCheck(ctx, { projectId: input.projectId, runId: r.check.runId })).run
          : await enqueueHostedCheck(ctx, {
              projectId: input.projectId,
              actor: input.actor.id,
              request: {
                operationId: input.operations.check,
                authorityEpoch: r.authorityEpoch,
                candidateId: r.candidateId,
                expectedHead: head,
                checkId: r.check.checkId,
                expectedDefinition: r.check.expectedDefinition,
                expectedConfiguration: r.check.expectedConfiguration,
                expectedEnvironment: r.check.expectedEnvironment,
              },
            });
      await hostedWriteProject(ctx, input.projectId, run.actor, r.authorityEpoch);
      invariant(
        run.request.candidateId === r.candidateId &&
          run.request.expectedHead === head &&
          run.request.authorityEpoch === r.authorityEpoch &&
          run.candidate.digest === row.digest,
        'EVIDENCE_CHANGED',
        'The selected check belongs to different source or authority pins.',
      );
      check = {
        runId: run.id,
        checkId: run.check.id,
        definition: run.check.definition,
        configuration: run.request.expectedConfiguration,
        environment: run.request.expectedEnvironment,
      };
    }
  }
  const policy = effectivePolicy(project);
  return hostedLandingAttemptSchema.parse({
    schema: 1,
    projectId: input.projectId,
    submissionId: input.submissionId,
    operationId: r.operationId,
    id: input.attemptId,
    parentAttemptId: input.parentAttemptId,
    number: input.number,
    at: input.at,
    actor: input.actor,
    authorityEpoch: r.authorityEpoch,
    main: r.expectedMain,
    candidate: {
      id: candidate.id,
      digest: row.digest,
      head: r.expectedHead,
      inputs: candidate.inputs,
      dependencies: candidate.dependencies,
      algorithm: candidate.algorithm,
    },
    check,
    policy,
    policyDigest: digest(canonicalPayload(policy)),
    operations: input.operations,
  });
}
