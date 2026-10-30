// SPDX-License-Identifier: Apache-2.0
'use node';
import { ConvexError } from 'convex/values';
import { indexReadContext, indexTransient } from './projectWorkIndexRetry';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  resume,
  stepRef,
  readPageRef,
  putPageRef,
  scratch,
  type Identity,
  type Selected,
  type Cursor,
} from './projectWorkIndexBuildTypes';
import { buildContext } from './projectWorkIndexBuildContext';
import { buildProgress } from './projectWorkIndexBuildProgress';
import { projectStep } from './projectWorkIndexBuildStep';
import { replayStep } from './projectWorkIndexBuildProjection';
import { exchangeObjectReader } from './projectExchangeReader';
import { recordExchange } from './projectWorkRecordExchange';
import { partialWork } from '../src/work-exchange-delta';
import { materializeWork, indexBatches, type IndexEntry, type IndexMetadata } from '../src/work-hosted-index';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
/** Server-held record bodies are independently pinned and validated by seed.
 * Each durable step consumes a bounded record or source State page. No complete Work
 * object, projection, or historical State file map survives in the action. */
export async function buildRecordIndex(ctx: ActionCtx, input: Identity) {
  ctx = indexReadContext(ctx);
  const existing: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
    internal.projectWorkIndexStore.current,
    input,
  );
  if (existing) return existing._id;
  const project: Doc<'hostedProjects'> = await ctx.runQuery(internal.projectWork.get, input);
  if (!project.work || project.work.intentMigration) return;
  const { backup }: { backup: Doc<'projectBackups'> } = await ctx.runQuery(internal.projectBackups.get, {
    id: project.work.backupId,
    owner: input.owner,
  });
  if (backup.transport !== 'objects' || backup.preview.format !== 'native') return;
  // Small/legacy snapshots retain their exact historical projection layout.
  // The record path removes the whole-Work action for large native seeds.
  const reader = exchangeObjectReader(ctx, false, 0);
  const exchange = await recordExchange(backup, input.owner, reader);
  if (!exchange || exchange.records.work.size < 2 * 1024 * 1024) return;
  invariant(
    exchange.records.revision === project.work.initialRevision &&
      digest(exchange.manifestBytes) === backup.preview.manifestDigest,
    'INVALID_WORK_JOURNAL',
    'Hosted Work base differs from its source record catalog.',
  );
  let generation = await ctx.runQuery(resume, input);
  if (!generation) {
    const intents = exchange.records.fields.find(f => f.name === 'intents');
    const defaultIntentId =
      intents && 'records' in intents
        ? ([...intents.records].reverse().find(r => r.status === 'active')?.key ??
          intents.records.at(-1)?.key)
        : undefined;
    const skeleton = partialWork(exchange.records, []);
    const metadata: IndexMetadata = {
      schema: skeleton.schema,
      sourceHead: exchange.manifest.head,
      sourceKind: 'native',
      sourceTransport: 'objects',
      initialRevision: exchange.records.revision,
      ...(defaultIntentId ? { defaultIntentId } : {}),
      ...((skeleton as Record<string, unknown>).intentMergeReceipt
        ? { intentMergeReceipt: (skeleton as Record<string, unknown>).intentMergeReceipt }
        : {}),
      counts: Object.fromEntries(
        Object.keys(
          materializeWork(skeleton, { ...exchange.manifest, files: [] }, [], 'objects', new Map(), true)
            .metadata.counts,
        ).map(name => [name, 0]),
      ),
    };
    const cursor: Cursor = { phase: 'settings', field: 0, record: 0, source: 0 };
    generation = await ctx.runMutation(internal.projectWorkIndexStore.begin, {
      ...input,
      backupId: backup._id,
      revision: project.work.revision,
      initialRevision: project.work.initialRevision,
      metadata: JSON.stringify(metadata),
      cursor: JSON.stringify(cursor),
    });
    if (!generation) return { pending: true as const, progress: JSON.stringify({ phase: 'index', step: 0 }) };
    generation = await ctx.runQuery(resume, input);
  }
  invariant(generation?.ensureCursor, 'WORK_STALE', 'Resume this snapshot’s index build.');
  const selected: Selected = { ...input, generationId: generation._id };
  const context = buildContext(ctx, selected, exchange);
  const started = Date.now();
  // Both a work window and a step window: tests and very fast local storage do
  // not turn a single action into an unbounded loop.
  for (let steps = 0; steps < 20 && Date.now() - started < 10_000; steps++) {
    if (generation.status === 'failed') throw new ConvexError(JSON.parse(generation.ensureRetry!));
    const durableGeneration = generation;
    const expected: string = generation.ensureCursor!;
    try {
      let cursor = JSON.parse(expected!) as Cursor;
      if (cursor.phase === 'done') {
        const metadata = JSON.parse(generation.metadata) as IndexMetadata;
        for (const name of scratch) delete metadata.counts[name];
        if (
          await ctx.runMutation(internal.projectWorkIndexStore.publish, {
            ...selected,
            batches: generation.nextBatch,
            metadata: JSON.stringify(metadata),
          })
        )
          return generation._id;
        return {
          pending: true as const,
          progress: buildProgress(generation, exchange),
        };
      }
      let metadata: string | undefined;
      const cleanup = cursor.phase === 'cleanup' ? scratch[cursor.cleanup ?? 0] : undefined;
      let entries: IndexEntry[] = [];
      if (cursor.output) {
        const output = cursor.output;
        const body: string = await ctx.runQuery(readPageRef, {
          ...selected,
          key: output.key,
          position: output.part,
        });
        entries = JSON.parse(body) as IndexEntry[];
        if (output.part + 1 === output.parts) metadata = output.metadata;
        cursor =
          output.part + 1 === output.parts
            ? output.after
            : { ...cursor, output: { ...output, part: output.part + 1 } };
      } else {
        const after = structuredClone(cursor);
        after.filesTotal ??= JSON.parse(generation.metadata).counts.viewFiles ?? 0;
        if (cursor.phase === 'journal') {
          const projected = await replayStep(ctx, selected, exchange, backup, generation, project, after);
          entries = projected.entries;
          metadata = projected.metadata;
        } else entries = await projectStep(ctx, selected, exchange, backup, after, context);
        const batches = indexBatches(entries, { rows: 500, bytes: 500000 });
        if (batches.length > 1) {
          // Stage one independently readable RPC page at a time. Cursor+rows are
          // published together below, so a lost reply never repeats completed IO.
          const key = crypto.randomUUID();
          for (const [position, batch] of batches.entries())
            await ctx.runMutation(putPageRef, {
              ...selected,
              key,
              position,
              body: JSON.stringify(batch),
            });
          cursor = {
            ...cursor,
            output: { key, part: 0, parts: batches.length, after, ...(metadata ? { metadata } : {}) },
          };
          entries = [];
          metadata = undefined;
        } else cursor = after;
      }
      const committed: Doc<'projectWorkGenerations'> | null = await ctx.runMutation(stepRef, {
        ...selected,
        expected,
        cursor: JSON.stringify(cursor),
        entries,
        ...(cleanup ? { cleanup } : {}),
        ...(metadata ? { metadata } : {}),
      });
      generation = committed ?? (await ctx.runQuery(resume, input));
      invariant(generation?.ensureCursor, 'WORK_STALE', 'The snapshot changed during index preparation.');
    } catch (error) {
      if (!indexTransient(error)) throw error;
      const detail =
        error instanceof ConvexError ? (error.data as { pin?: { sha256: string; size: number } }) : {};
      const saved = await ctx.runMutation(internal.projectWorkIndexBuildFailure.pending, {
        ...selected,
        expected,
        expectedBatch: durableGeneration.nextBatch,
        operationId: crypto.randomUUID(),
        ...(detail.pin ? { pin: detail.pin } : {}),
      });
      if (saved?.status === 'failed') throw new ConvexError(JSON.parse(saved.ensureRetry!));
      return {
        pending: true as const,
        progress: JSON.stringify({
          ...JSON.parse(buildProgress(saved ?? durableGeneration, exchange)),
          retryable: true,
        }),
      };
    }
  }
  return {
    pending: true as const,
    progress: buildProgress(generation, exchange),
  };
}
