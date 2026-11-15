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
import { invariant } from '../src/errors';
/** One bounded physical page: one capture and one publish mutation. Event/operator continuations
 * drain the finite eligible frontier; there is no periodic wake and disabled/idle costs zero. */
export const pack = internalAction({
  args: { ...journalRunArgs, retry: v.optional(v.number()), claim: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    if (process.env.FORGE_JOURNAL_SEGMENTS !== '1') return canonicalPayload({ kept: 'disabled' });
    const started = performance.now(),
      { retry = 0, claim = crypto.randomUUID(), ...request } = input;
    // A scheduled retry retains the page identity and its claim. Success starts
    // the next page with a fresh retry budget; idle projects schedule nothing.
    const resume = async (reason: 'claimed' | 'conflict', retryAt?: number) => {
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
    try {
      const raw = await ctx.runMutation(makeFunctionReference<'mutation'>('projectJournalCapture:page'), {
        ...request,
        claim,
      });
      const capture = JSON.parse(raw);
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
        for (const text of capture.texts as string[]) {
          const segment = JSON.parse(text) as JournalSegment;
          const encoded = encodeArchiveBytes(text, segment.through, journalTablePins(segment.tables));
          const stored = await putArchiveObject(
            `v1/p/${input.projectId}/journal-segments/${encoded.pointer.sha256}`,
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
        error && typeof error === 'object' && 'data' in error
          ? (error.data as { code?: string } | null)?.code
          : undefined;
      const conflict =
        code === 'HOSTED_CONFLICT' ||
        (error instanceof Error &&
          /Documents read from or written to|OptimisticConcurrencyControl|OCC conflict|write conflicts?/i.test(
            error.message,
          ));
      if (!conflict || retry >= 4) throw error;
      return resume('conflict');
    }
  },
});
