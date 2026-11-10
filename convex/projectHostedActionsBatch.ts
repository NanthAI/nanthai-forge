// SPDX-License-Identifier: Apache-2.0
import { cleanPoolClaims } from './projectHostedActionsPool';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './server';
import { batchArgs, type BatchInput } from './projectHostedActionsBatchStore';
import type { SessionInput } from './projectHostedActionsSession';
import { presignResultSlot, presignResultList, presignPut, presignGet, r2Config } from './r2';
import { convexFetch } from './networkFetch';
import { outputSigningKey, storeOutputObject, verifyOutputObject } from './projectHostedOutputApi';
import { directOutput } from '../src/hosted-actions-direct';
import { outputKey, outputMessage } from '../src/hosted-check-output';
import { canonicalPayload } from '../src/hosted-source-operation';
import { hostedCheckTerminal, type HostedCheckRun } from '../src/hosted-check';
import {
  resultEnvelopeSchema,
  resultSlotKey,
  resultBatchPrefix,
  readResultSlot,
  resultPageBytes,
  type ResultEnvelope,
} from '../src/hosted-actions-result-batch';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { deleteR2Object } from './r2Operations';

/** CPU-only targets added to the existing plan response; never stored in the run or given to
 * Candidate code. The exact run/fence/execution namespace cannot accept an earlier run's upload. */
export async function resultBatchTargets(run: HostedCheckRun) {
  const config = r2Config();
  return {
    slots: await Promise.all(
      Array.from({ length: run.plan!.shardCount }, (_, i) =>
        Promise.all([
          presignResultSlot(config, resultSlotKey(run, i)),
          presignResultSlot(config, resultSlotKey(run, `log-${i}`)),
        ]).then(([slot, log]) => ({ ...slot!, log: log! })),
      ),
    ),
    coordinator: await presignResultSlot(config, resultSlotKey(run, 'coordinator')),
    list: await presignResultList(config, resultBatchPrefix(run)),
  };
}
async function cleanupInbox(run: HostedCheckRun) {
  const keys = Array.from({ length: run.plan!.shardCount }, (_, i) => resultSlotKey(run, i));
  keys.push(
    ...Array.from({ length: run.plan!.shardCount }, (_, i) => resultSlotKey(run, `log-${i}`)),
    resultSlotKey(run, 'coordinator'),
  );
  await Promise.allSettled(keys.map(key => deleteR2Object(r2Config(), key)));
  if (run.poolClaimed) await cleanPoolClaims(run.projectId, run.id);
}
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
/** One event-driven collector; no polling or hosted worker. The last uploader invokes it using
 * OIDC. A signed completed webhook invokes the same path if that uploader lost its process/reply.
 * Peak buffers are one 512 KiB slot plus a <768 KiB page, independent of total reports. */
export async function collectResultBatch(
  ctx: ActionCtx,
  identity: BatchInput | SessionInput,
  conclusion?: string | null,
) {
  const input: BatchInput =
    'executionId' in identity
      ? identity
      : {
          ...identity,
          fence: identity.fence!,
          executionId: String(JSON.parse(identity.claims).run_id),
        };
  const run: HostedCheckRun = JSON.parse(
    await ctx.runMutation(reference('projectHostedActionsBatchStore:prepare'), input),
  );
  const config = r2Config();
  if (hostedCheckTerminal(run) && !['passed', 'failed'].includes(run.status)) {
    await cleanupInbox(run);
    return { id: run.id, status: run.status, counts: run.counts };
  }
  let page: ResultEnvelope['result'][] = [],
    pageSize = 2;
  let settled = run;
  const flush = async (last: boolean) => {
    if (!page.length && !last) return;
    const { run: updated, final } = JSON.parse(
      await ctx.runMutation(reference('projectHostedActionsResults:batch'), {
        ...input,
        results: canonicalPayload(page),
        ...(last && conclusion !== undefined ? { conclusion } : {}),
      }),
    );
    settled = updated;
    page = [];
    pageSize = 2;
    invariant(final !== 'prepare', 'EVIDENCE_CHANGED', 'Finalize only settled output with complete seals.');
    if (final) {
      await storeOutputObject(final.target, canonicalPayload(final.root));
      await verifyOutputObject(input.projectId, outputMessage(settled, { kind: 'final', root: final.root }));
      await ctx.runMutation(reference('projectHostedActionsBatchStore:output'), {
        ...input,
        root: canonicalPayload(final.root),
      });
    }
  };
  if (!hostedCheckTerminal(run)) {
    for (let index = 0; index < run.plan!.shardCount; index++) {
      const response = await convexFetch(await presignGet(config, resultSlotKey(run, index)));
      if (response.status === 404) {
        await response.body?.cancel();
        continue;
      }
      invariant(response.ok, 'R2_VERIFY_FAILED', 'Read the original result inbox.');
      const envelope = resultEnvelopeSchema.parse(JSON.parse(await readResultSlot(response)));
      invariant(envelope.result.index === index, 'EVIDENCE_CHANGED', 'Shard result differs from its slot.');
      const { result } = envelope;
      let logBytes = envelope.logBytes;
      if (result.log && logBytes === undefined) {
        const logResponse = await convexFetch(await presignGet(config, resultSlotKey(run, `log-${index}`)));
        invariant(logResponse.ok, 'R2_VERIFY_FAILED', 'Read the original shard log.');
        logBytes = await readResultSlot(logResponse);
      }
      if (result.log) {
        if (logBytes !== undefined) {
          const bytes = Uint8Array.from(atob(logBytes), c => c.charCodeAt(0));
          invariant(
            bytes.length === result.log.object.size && digest(bytes) === result.log.object.sha256,
            'EVIDENCE_CHANGED',
            'Log bytes differ from the result pin.',
          );
          await storeOutputObject(
            await presignPut(config, outputKey(input.projectId, run.id, result.log.object), {
              digest: result.log.object.sha256,
              size: result.log.object.size,
            }),
            bytes,
          );
        }
        await verifyOutputObject(
          input.projectId,
          directOutput(run, index, result.log, outputSigningKey(run.keyId))[0]!.message,
        );
      }
      const size = new TextEncoder().encode(canonicalPayload(result)).length + 1;
      if (pageSize + size > resultPageBytes) await flush(false);
      page.push(result);
      pageSize += size;
    }
  }
  await flush(true);
  // Ingested scratch bytes can be reconstructed by a retry; retained reports/logs use their
  // existing stores and policies. Failure leaves the exact inbox recoverable, never loses evidence.
  if (hostedCheckTerminal(settled) || settled.actions?.verdictPending) {
    await cleanupInbox(settled);
  }
  return { id: settled.id, status: settled.status, counts: settled.counts };
}
export const collect = internalAction({
  args: { ...batchArgs, conclusion: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { conclusion, ...input }) => {
    await collectResultBatch(ctx, input, conclusion);
    return null;
  },
});
