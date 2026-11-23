// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, type ObjectType } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import { journalRunArgs } from './projectJournalMaintenance';
import { putArchiveObject } from './projectLandingCapsuleObject';
import { canonicalPayload } from '../src/hosted-source-operation';
import { readJournalSegment, type JournalSegment } from '../src/journal-segment';
import { digest } from '../src/state/hash';
import { ForgeError, invariant } from '../src/errors';
import { decodeJournalBytes, encodePlannedJournal, journalObjectKey } from './projectJournalArchivePlan';
import { deleteR2Object } from './r2Operations';
import { r2Config } from './r2';
export const journalPackArgs = {
  ...journalRunArgs,
  retry: v.optional(v.number()),
  claim: v.optional(v.string()),
  discardExpired: v.optional(v.literal(true)),
};
/** The S1 pattern (b149b16b): one packer body runs in the V8 runtime; a page whose captured text exceeds
 * this bound continues in Node under the same claim. Pages are bounded at about 48 KB of selected rows
 * plus one fragment of at most 384 KB, so dogfood pages stay in V8. */
export const journalV8RawBytes = 1024 * 1024;
type Runtime = 'v8' | 'node';
const packName = 'projectJournalRun:pack',
  nodePackName = 'projectJournalRunNode:pack';
const rss = () =>
  (globalThis as { process?: { memoryUsage?: () => { rss: number } } }).process?.memoryUsage?.().rss ?? null;
/** One bounded physical page: one capture and one publish mutation. Event/operator continuations
 * drain the finite eligible frontier; there is no periodic wake and disabled/idle costs zero. */
export async function packJournal(
  ctx: Pick<ActionCtx, 'runMutation' | 'scheduler'>,
  { discardExpired, ...input }: ObjectType<typeof journalPackArgs>,
  runtime: Runtime,
) {
  if (!discardExpired && process.env.FORGE_JOURNAL_SEGMENTS !== '1')
    return canonicalPayload({ kept: 'disabled' });
  const started = Date.now(),
    { retry = 0, claim = crypto.randomUUID(), ...request } = input;
  // A scheduled retry retains the page identity and its claim. Success starts
  // the next page with a fresh retry budget; idle projects schedule nothing.
  const resume = async (reason: 'claimed' | 'conflict' | 'stale-capture', retryAt?: number) => {
    const delay = retryAt === undefined ? 250 * 2 ** retry : Math.max(0, retryAt - Date.now());
    const backoff = delay + Math.floor(Math.random() * 250);
    // A retried Node page stays in Node rather than recapturing in V8 first.
    await ctx.scheduler.runAfter(
      backoff,
      makeFunctionReference<'action'>(runtime === 'node' ? nodePackName : packName),
      {
        ...request,
        claim,
        retry: retry + 1,
      },
    );
    console.log(
      `FORGE_JOURNAL_RETRY ${JSON.stringify({
        projectId: input.projectId,
        operationId: input.operationId,
        phase: input.phase ?? 0,
        part: input.part ?? 0,
        reason,
        retry: retry + 1,
        delayMs: backoff,
      })}`,
    );
    return canonicalPayload({ deferred: reason, retry: retry + 1 });
  };
  const capturePage = makeFunctionReference<'mutation'>('projectJournalCapture:page');
  const control = { ...request, claim, ...(discardExpired ? { discardExpired } : {}) };
  let planned = false;
  try {
    const raw = await ctx.runMutation(capturePage, control);
    let capture = JSON.parse(raw);
    const discarded = capture.discard as string[] | undefined;
    if (discarded) {
      planned = true;
      for (const key of discarded) await deleteR2Object(r2Config(), journalObjectKey(input.projectId, key));
      capture = JSON.parse(await ctx.runMutation(capturePage, { ...control, discarded }));
    }
    if (discardExpired) return canonicalPayload(capture);
    if (capture.deferred) {
      invariant(
        retry < 4,
        'WORK_STALE',
        'Journal capture remained claimed after four resumptions. Retry the original operation.',
      );
      return resume('claimed', capture.retryAt);
    }
    let result = capture;
    const pointers = [],
      hashes = [];
    if (capture.texts) {
      const texts = capture.texts as string[];
      const rawBytes = texts.reduce((n, text) => n + new TextEncoder().encode(text).length, 0);
      if (runtime === 'v8' && rawBytes > journalV8RawBytes) {
        // The capture holds this claim; the Node run recaptures the same page under it.
        await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>(nodePackName), {
          ...request,
          claim,
          retry,
        });
        return canonicalPayload({ continuing: 'node', rawBytes });
      }
      planned = !!capture.pending.planned;
      for (const text of texts) {
        const segment = JSON.parse(text) as JournalSegment;
        // The capture pins planned bytes with this same codec, so both paths share one content pin.
        const encoded = encodePlannedJournal(text, segment);
        const stored = await putArchiveObject(
          journalObjectKey(input.projectId, encoded.pointer.sha256),
          encoded,
        );
        const verified = readJournalSegment(
          decodeJournalBytes(stored, encoded.pointer),
          encoded.pointer,
          input.projectId,
          segment,
        );
        invariant(
          canonicalPayload(verified) === text,
          'EVIDENCE_CHANGED',
          'Stored journal differs from captured source.',
        );
        pointers.push(encoded.pointer);
        hashes.push(digest(text));
      }
      result = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectJournalPublish:page'), {
          ...request,
          claim,
          pointers,
          hashes,
        }),
      );
    }
    if (result.deferred) {
      invariant(
        retry < 4,
        'WORK_STALE',
        'Journal publication remained claimed after four resumptions. Retry the original operation.',
      );
      return resume('claimed', result.retryAt);
    }
    if (result.staleCapture) {
      invariant(retry < 4, 'WORK_STALE', 'Journal capture changed after four resumptions.');
      return resume('stale-capture');
    }
    if (result.next) await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>(packName), result.next);
    const sampledRss = rss();
    const metrics = {
      runtime,
      mutations: capture.texts ? 2 : 1,
      segments: pointers.length,
      compressedBytes: pointers.reduce((n, pointer) => n + pointer.size, 0),
      rawBytes: pointers.reduce((n, pointer) => n + pointer.rawSize, 0),
      wallMs: Date.now() - started,
      ...(sampledRss === null ? {} : { sampledRss }),
    };
    console.log(
      `FORGE_JOURNAL_SEGMENT ${JSON.stringify({ projectId: input.projectId, operationId: input.operationId, phase: input.phase ?? 0, archived: result.archived ?? 0, ...(result.archived ? { undo: 'Restore original journal rows from the recovery export.' } : {}), ...metrics })}`,
    );
    return canonicalPayload({ ...result, metrics });
  } catch (error) {
    const code =
      error instanceof ForgeError
        ? error.code
        : error && typeof error === 'object' && 'data' in error
          ? (error.data as { code?: string } | null)?.code
          : undefined;
    const conflict =
      code === 'HOSTED_CONFLICT' ||
      (error instanceof Error &&
        /Documents read from or written to|OptimisticConcurrencyControl|OCC conflict|write conflicts?/i.test(
          error.message,
        ));
    if (discardExpired || retry >= 4) throw error;
    if (planned && (code === 'WORK_STALE' || code === 'R2_DELETE_FAILED')) return resume('stale-capture');
    if (!conflict) throw error;
    return resume('conflict');
  }
}

export const pack = internalAction({
  args: journalPackArgs,
  returns: v.string(),
  handler: (ctx, input) => packJournal(ctx, input, 'v8'),
});
