// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import { journalRunArgs } from './projectJournalMaintenance';
import { encodeArchiveBytes, decodeArchiveBytes } from '../src/landing-capsule-bytes';
import { putArchiveObject } from './projectLandingCapsuleObject';
import { canonicalPayload } from '../src/hosted-source-operation';
import { journalTablePins, readJournalSegment, type JournalSegment } from '../src/journal-segment';
import { digest } from '../src/state/hash';
import { ForgeError, invariant } from '../src/errors';
import { encodePlannedJournal } from './projectJournalArchivePlan';
import { deleteR2Object } from './r2Operations';
import { r2Config } from './r2';
import { journalObjectKey } from './projectJournalObject';
/** One bounded physical page: one capture and one publish mutation. Event/operator continuations
 * drain the finite eligible frontier; there is no periodic wake and disabled/idle costs zero. */
export const pack = internalAction({
  args: {
    ...journalRunArgs,
    retry: v.optional(v.number()),
    claim: v.optional(v.string()),
    discardExpired: v.optional(v.literal(true)),
  },
  returns: v.string(),
  handler: async (ctx, { discardExpired, ...input }) => {
    if (!discardExpired && process.env.FORGE_JOURNAL_SEGMENTS !== '1')
      return canonicalPayload({ kept: 'disabled' });
    const started = performance.now(),
      { retry = 0, claim = crypto.randomUUID(), ...request } = input;
    // A scheduled retry retains the page identity and its claim. Success starts
    // the next page with a fresh retry budget; idle projects schedule nothing.
    const resume = async (reason: 'claimed' | 'conflict' | 'stale-capture', retryAt?: number) => {
      const delay = retryAt === undefined ? 250 * 2 ** retry : Math.max(0, retryAt - Date.now());
      const backoff = delay + Math.floor(Math.random() * 250);
      await ctx.scheduler.runAfter(backoff, makeFunctionReference<'action'>('projectJournalRun:pack'), {
        ...request,
        claim,
        retry: retry + 1,
      });
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
        planned = !!capture.pending.planned;
        for (const text of capture.texts as string[]) {
          const segment = JSON.parse(text) as JournalSegment;
          const encoded = planned
            ? encodePlannedJournal(text, segment)
            : encodeArchiveBytes(text, segment.through, journalTablePins(segment.tables));
          const stored = await putArchiveObject(
            journalObjectKey(input.projectId, encoded.pointer.sha256),
            encoded,
          );
          const verified = readJournalSegment(
            decodeArchiveBytes(stored, encoded.pointer),
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
      if (result.next)
        await ctx.scheduler.runAfter(
          0,
          makeFunctionReference<'action'>('projectJournalRun:pack'),
          result.next,
        );
      const metrics = {
        mutations: capture.texts ? 2 : 1,
        segments: pointers.length,
        compressedBytes: pointers.reduce((n, pointer) => n + pointer.size, 0),
        rawBytes: pointers.reduce((n, pointer) => n + pointer.rawSize, 0),
        wallMs: performance.now() - started,
        sampledRss: process.memoryUsage().rss,
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
  },
});
