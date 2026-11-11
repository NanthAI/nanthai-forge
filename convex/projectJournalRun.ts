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
  args: journalRunArgs,
  returns: v.string(),
  handler: async (ctx, input) => {
    if (process.env.FORGE_JOURNAL_SEGMENTS !== '1') return canonicalPayload({ kept: 'disabled' });
    const started = performance.now(),
      claim = crypto.randomUUID();
    const raw = await ctx.runMutation(makeFunctionReference<'mutation'>('projectJournalCapture:page'), {
      ...input,
      claim,
    });
    const capture = JSON.parse(raw);
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
          ...input,
          claim,
          pointers,
          hashes,
        }),
      );
    }
    if (result.next)
      await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectJournalRun:pack'), result.next);
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
  },
});
