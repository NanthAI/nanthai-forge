// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { beginHostedOperation } from './projectHostedOperations';
import { composeRow, loadCompose, hostedComposeInput, type ComposeState } from './projectHostedComposeStore';
import { hostedStartMain } from './projectHostedChannels';
import { saveObject } from './projectHostedSaveStore';
import { hostedPayloadHash, canonicalPayload } from '../src/hosted-source-operation';
import { buildComposePages } from '../src/hosted-compose';
import { savePin } from '../src/hosted-save';
import { loadBatch, writeBatch, type BatchIdentity } from './projectHostedLandingBatchStore';
import { readHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { semanticMember, mergeSemanticMembers, mainSemanticMembers } from './projectSemanticContracts';
import { invariant } from '../src/errors';

/** Members are clean dependency-first Candidates. Stacking those exact heads
 * preserves each member's validated dependency order without downloading pages. */
export async function prepareBatchCompose(ctx: MutationCtx, input: BatchIdentity) {
  const { batch } = await loadBatch(ctx, input);
  const first = batch.members[0]!;
  const auth = { projectId: input.projectId, actor: first.actor.id, operationId: batch.composeOperationId };
  const existing = await composeRow(ctx, auth);
  if (existing && batch.uploads) return { ...(await loadCompose(ctx, auth)), auth, uploads: batch.uploads };
  const inputs = buildComposePages([]),
    dependencies = buildComposePages(
      await Promise.all(
        batch.members.map(async member => ({
          candidateId: member.candidate.id,
          head: member.candidate.head!,
          state: await saveObject(ctx, input.projectId, { sha256: member.candidate.head! }),
        })),
      ),
    );
  if (!existing) {
    const main = await hostedStartMain(ctx, input.projectId);
    const request = {
      operationId: auth.operationId,
      intentId: '',
      authorityEpoch: first.authorityEpoch,
      expectedMain: { head: main.head, receiptId: main.receipt.id },
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
      message: 'Compose concurrent hosted landings',
    };
    const contracts = await mainSemanticMembers(ctx, auth, main.receipt.id);
    for (const member of batch.members) {
      const row = await readHostedRecord(ctx, { ...auth, kind: 'candidate', key: member.candidate.id });
      invariant(
        row?.digest === member.candidate.digest,
        'EVIDENCE_CHANGED',
        'The batch member Candidate changed.',
      );
      const candidate = hostedRecordSchema.options[3].parse(JSON.parse(row.value));
      if (!request.intentId) request.intentId = candidate.intentId;
      contracts.push(...(candidate.semanticPlan?.members ?? []));
      const own = await semanticMember(ctx, auth, candidate.intentId);
      if (own) contracts.push(own);
    }
    const expected = { authorityEpoch: first.authorityEpoch, ...request.expectedMain };
    const operation = await beginHostedOperation(ctx, {
      ...auth,
      payload: request,
      request: { schema: 1, ...auth, expected, payloadHash: hostedPayloadHash(request, expected) },
      firstAttempt: {
        projectId: input.projectId,
        operationId: auth.operationId,
        id: crypto.randomUUID(),
        parentAttemptId: null,
        at: batch.at,
        expected,
        ids: { candidate: crypto.randomUUID(), job: crypto.randomUUID(), jobOperation: crypto.randomUUID() },
      },
    });
    const state: ComposeState = {
      request,
      ownerInputs: true,
      batch: { members: batch.members.map(m => m.candidate.id) },
      ...(contracts.length ? { semanticPlan: mergeSemanticMembers(request.intentId, contracts) } : {}),
      main: await saveObject(ctx, input.projectId, { sha256: main.head }),
      inputs: { next: null, pages: inputs.manifest.pages, count: 0 },
      dependencies: { next: null, pages: dependencies.manifest.pages, count: batch.members.length },
      candidateId: operation.operation.firstAttempt.ids.candidate!,
      jobOperationId: operation.operation.firstAttempt.ids.jobOperation!,
      status: 'ready',
    };
    await ctx.db.insert('projectHostedComposes', {
      ...auth,
      jobId: operation.operation.firstAttempt.ids.job!,
      value: canonicalPayload(state),
    });
  }
  const source = await loadCompose(ctx, auth);
  const plan = hostedComposeInput(source.state, source.operation.firstAttempt.at);
  const uploads = [...inputs.pages, ...dependencies.pages, { pin: savePin(plan), value: plan }].map(page => ({
    pin: page.pin,
    value: canonicalPayload(page.value),
  }));
  await writeBatch(ctx, input, { ...batch, uploads });
  return { ...source, auth, uploads };
}
