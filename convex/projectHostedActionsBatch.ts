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
import { hostedCheckTerminal, checkPin, type HostedCheckRun } from '../src/hosted-check';
import {
  resultEnvelopeSchema,
  resultSlotKey,
  resultBatchPrefix,
  readResultSlot,
  resultPageBytes,
  resultSlotBytes,
  type ResultEnvelope,
} from '../src/hosted-actions-result-batch';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { deleteR2Object } from './r2Operations';
import { foldShardStep } from './projectHostedActionsReports';
import { checkReportHeader, checkReportPointer } from '../src/check-file-summary';
import { checkReportsKey } from './projectHostedCheckReports';
import { semanticReportsSchema } from '../src/intent-semantic-conflict';
import { runFlakes } from '../src/self-metrics-flakes';
export type PreparedResultBatch = {
  run: HostedCheckRun;
  packed: boolean;
  reportStorage?: 'r2';
  collect?: boolean;
  collectionToken?: string;
  timings?: boolean;
  final?: Awaited<ReturnType<typeof import('./projectHostedActionsOutput').finalOutputTarget>>;
};

/** CPU-only targets added to the existing plan response; never stored in the run or given to
 * Candidate code. The exact run/fence/execution namespace cannot accept an earlier run's upload. */
export async function resultBatchTargets(run: HostedCheckRun, packed = false) {
  const config = r2Config();
  if (packed)
    return {
      packed: true as const,
      slots: await Promise.all(
        Array.from({ length: run.plan!.shardCount }, async (_, i) => {
          const { put, get, head } = await presignResultSlot(config, resultSlotKey(run, i));
          return { put, get, head };
        }),
      ),
      coordinator: await presignResultSlot(config, resultSlotKey(run, 'coordinator')),
    };
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
async function cleanupInbox(run: HostedCheckRun, packed = false) {
  if (packed) {
    if (run.poolClaimed) await cleanPoolClaims(run.projectId, run.id);
    return;
  }
  const keys = Array.from({ length: run.plan!.shardCount }, (_, i) => resultSlotKey(run, i));
  keys.push(
    ...Array.from({ length: run.plan!.shardCount }, (_, i) => resultSlotKey(run, `log-${i}`)),
    resultSlotKey(run, 'coordinator'),
  );
  await Promise.allSettled(keys.map(key => deleteR2Object(r2Config(), key)));
  if (run.poolClaimed) await cleanPoolClaims(run.projectId, run.id);
}
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
async function commitBatchOutput(
  ctx: ActionCtx,
  input: BatchInput,
  run: HostedCheckRun,
  final: NonNullable<PreparedResultBatch['final']>,
) {
  await storeOutputObject(final.target, canonicalPayload(final.root));
  await verifyOutputObject(input.projectId, outputMessage(run, { kind: 'final', root: final.root }));
  await ctx.runMutation(reference('projectHostedActionsBatchStore:output'), {
    ...input,
    root: canonicalPayload(final.root),
  });
}

/** One event-driven collector; no polling or hosted worker. The last uploader invokes it using
 * OIDC. A signed completed webhook invokes the same path if that uploader lost its process/reply.
 * Peak buffers are one 512 KiB metadata slot plus its encoded 64 KiB log and a <768 KiB page. */
export async function collectResultBatch(
  ctx: ActionCtx,
  identity: BatchInput | SessionInput,
  conclusion?: string | null,
  prepared?: PreparedResultBatch,
) {
  const input: BatchInput =
    'executionId' in identity
      ? identity
      : {
          ...identity,
          fence: identity.fence!,
          executionId: String(JSON.parse(identity.claims).run_id),
        };
  const work: PreparedResultBatch =
    prepared ?? JSON.parse(await ctx.runMutation(reference('projectHostedActionsBatchStore:prepare'), input));
  const { run, packed, reportStorage } = work;
  if (reportStorage && work.collect === false && !work.timings) {
    if (work.final) await commitBatchOutput(ctx, input, run, work.final);
    return { id: run.id, status: run.status, counts: run.counts };
  }
  const config = r2Config();
  if (!reportStorage && hostedCheckTerminal(run) && !['passed', 'failed'].includes(run.status)) {
    await cleanupInbox(run, packed);
    return { id: run.id, status: run.status, counts: run.counts };
  }
  let envelopes: Record<number, { object: { sha256: string; size: number }; fence: number }> = {};
  let page: ResultEnvelope['result'][] = [],
    pageSize = 2;
  let settled = run;
  const receipts: ResultEnvelope['result'][] = [];
  const resultDigests: Record<number, string> = {};
  let folded = { reports: {} as NonNullable<HostedCheckRun['contractReports']>, pending: [] as string[] };
  let fromObject = false;
  if (reportStorage && run.reportPointer) {
    const response = await convexFetch(await presignGet(config, checkReportsKey(run)));
    invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Retained check reports are unavailable.');
    const body = await response.text();
    folded.reports = semanticReportsSchema.parse(JSON.parse(body));
    invariant(
      new TextEncoder().encode(body).length === run.reportPointer.size &&
        checkPin(folded.reports) === run.reportPointer.digest,
      'EVIDENCE_CHANGED',
      'Retained check reports differ from their pin.',
    );
    folded.pending = run.poolPending ?? [];
    fromObject = true;
  }
  const flush = async (last: boolean) => {
    if (!page.length && !last) return;
    const { run: updated, final } = JSON.parse(
      await ctx.runMutation(reference('projectHostedActionsResults:batch'), {
        ...input,
        results: canonicalPayload(page),
        envelopes: canonicalPayload(envelopes),
        ...(last && conclusion !== undefined ? { conclusion } : {}),
      }),
    );
    settled = updated;
    page = [];
    envelopes = {};
    pageSize = 2;
    invariant(final !== 'prepare', 'EVIDENCE_CHANGED', 'Finalize only settled output with complete seals.');
    if (final) {
      await commitBatchOutput(ctx, input, settled, final);
    }
  };
  if (!fromObject && (!hostedCheckTerminal(run) || reportStorage)) {
    for (let index = 0; index < run.plan!.shardCount; index++) {
      const response = await convexFetch(await presignGet(config, resultSlotKey(run, index)));
      if (response.status === 404) {
        await response.body?.cancel();
        continue;
      }
      invariant(response.ok, 'R2_VERIFY_FAILED', 'Read the original result inbox.');
      const body = await readResultSlot(response, packed);
      const envelope = resultEnvelopeSchema.parse(JSON.parse(body));
      invariant(
        new TextEncoder().encode(canonicalPayload(envelope.result)).length <= resultSlotBytes,
        'BAD_ARGUMENT',
        'Result exceeds the existing metadata window.',
      );
      invariant(!envelope.packed || packed, 'EVIDENCE_CHANGED', 'Use the negotiated result format.');
      invariant(envelope.result.index === index, 'EVIDENCE_CHANGED', 'Shard result differs from its slot.');
      const { result } = envelope;
      if (reportStorage) {
        resultDigests[index] = checkPin(result);
        const { contractReports, ...receipt } = result;
        receipts.push(receipt);
        folded = foldShardStep(folded, {
          reports: contractReports ?? {},
          yielded: result.pool?.yielded ?? [],
          complete: receipts.length === run.plan!.shardCount,
        });
      }
      let logBytes = envelope.logBytes;
      if (result.log && logBytes === undefined) {
        const logResponse = await convexFetch(await presignGet(config, resultSlotKey(run, `log-${index}`)));
        invariant(logResponse.ok, 'R2_VERIFY_FAILED', 'Read the original shard log.');
        logBytes = await readResultSlot(logResponse);
      }
      if (result.log) {
        if (envelope.packed)
          invariant(logBytes !== undefined, 'EVIDENCE_CHANGED', 'Packed log bytes are missing.');
        if (logBytes !== undefined) {
          const bytes = Uint8Array.from(atob(logBytes), c => c.charCodeAt(0));
          invariant(
            bytes.length === result.log.object.size && digest(bytes) === result.log.object.sha256,
            'EVIDENCE_CHANGED',
            'Log bytes differ from the result pin.',
          );
          if (!envelope.packed)
            await storeOutputObject(
              await presignPut(config, outputKey(input.projectId, run.id, result.log.object), {
                digest: result.log.object.sha256,
                size: result.log.object.size,
              }),
              bytes,
            );
        }
        if (!envelope.packed)
          await verifyOutputObject(
            input.projectId,
            directOutput(run, index, result.log, outputSigningKey(run.keyId))[0]!.message,
          );
      }
      const size = new TextEncoder().encode(canonicalPayload(result)).length + 1;
      if (!reportStorage && pageSize + size > resultPageBytes) await flush(false);
      if (envelope.packed && result.log) {
        const bytes = new TextEncoder().encode(body);
        envelopes[index] = { object: { sha256: digest(bytes), size: bytes.length }, fence: run.fence };
      }
      if (!reportStorage) {
        page.push(result);
        pageSize += size;
      }
    }
  }
  if (reportStorage) {
    if (!fromObject && receipts.length < run.counts.completed)
      return { id: run.id, status: run.status, counts: run.counts };
    const headerRun = { ...run, contractReports: folded.reports };
    checkReportHeader(headerRun, 7 * 1024);
    const finalReports =
      hostedCheckTerminal(run) || conclusion !== undefined || receipts.length === run.plan!.shardCount;
    if (finalReports) {
      headerRun.reportPointer = checkReportPointer(folded.reports);
      invariant(
        !run.reportPointer || run.reportPointer.digest === headerRun.reportPointer.digest,
        'EVIDENCE_CHANGED',
        'Final check reports are immutable.',
      );
      if (!run.reportPointer) {
        const body = canonicalPayload(folded.reports);
        await storeOutputObject(
          await presignPut(config, checkReportsKey(headerRun), {
            digest: headerRun.reportPointer.digest,
            size: headerRun.reportPointer.size,
          }),
          body,
        );
      }
    }
    const metadata = {
      testFiles: headerRun.testFiles,
      reportSummary: headerRun.reportSummary,
      ...(finalReports ? { reportPointer: headerRun.reportPointer } : {}),
      pending: folded.pending,
      flakes: canonicalPayload(runFlakes(headerRun) ?? null),
    };
    const durations = Object.fromEntries(
      Object.entries(folded.reports).flatMap(([file, report]) =>
        report.durationMs === undefined ? [] : [[file, report.durationMs]],
      ),
    );
    const timingPages: string[] = [];
    let timingPage: Record<string, number> = {},
      timingBytes = 2;
    for (const file of Object.keys(durations).sort()) {
      const bytes = new TextEncoder().encode(canonicalPayload({ [file]: durations[file]! })).length;
      if (timingBytes + bytes > 768 * 1024) {
        timingPages.push(canonicalPayload(timingPage));
        timingPage = {};
        timingBytes = 2;
      }
      timingPage[file] = durations[file]!;
      timingBytes += bytes;
    }
    timingPages.push(canonicalPayload(timingPage));
    page = receipts;
    const result =
      work.collect === false
        ? { run, final: work.final, timings: work.timings }
        : JSON.parse(
            await ctx.runMutation(reference('projectHostedActionsResults:batch'), {
              ...input,
              results: canonicalPayload(receipts),
              envelopes: canonicalPayload(envelopes),
              coveredShards: fromObject ? run.counts.completed : receipts.length,
              reportHeader: canonicalPayload(metadata),
              reportDigests: canonicalPayload(resultDigests),
              timings: timingPages[0],
              timingFinal: timingPages.length === 1,
              ...(work.collectionToken ? { collectionToken: work.collectionToken } : {}),
              ...(conclusion === undefined ? {} : { conclusion }),
            }),
          );
    settled = result.run;
    if (result.timings)
      for (const [index, durations] of timingPages.slice(work.collect === false ? 0 : 1).entries())
        await ctx.runMutation(reference('projectHostedTestTimings:argumentsPage'), {
          projectId: input.projectId,
          runId: run.id,
          reportDigest: settled.reportPointer!.digest,
          durations,
          final: index === timingPages.length - (work.collect === false ? 1 : 2),
        });
    if (result.final) {
      invariant(
        result.final !== 'prepare',
        'EVIDENCE_CHANGED',
        'Finalize only settled output with complete seals.',
      );
      await commitBatchOutput(ctx, input, settled, result.final);
    }
  } else await flush(true);
  // Legacy inboxes are scratch. Packed objects back the retained output pins and remain under
  // the existing output cleanup path; terminal replay must never delete that backing object.
  if (work.collect !== false && (hostedCheckTerminal(settled) || settled.actions?.verdictPending)) {
    await cleanupInbox(settled, packed);
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
