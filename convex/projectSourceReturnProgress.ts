// SPDX-License-Identifier: Apache-2.0
'use node';
import { digest } from '../src/hash';
import type { IntentRecords } from './projectSourceReturnRecords';
import { prepareDelta } from './projectSourceReturnDelta';
export { RETURN_BUDGET } from './projectSourceReturnStep';
import { installOwnerDerived } from './projectOwnerDerived';
import { CLI_UPGRADE_MESSAGE } from './projectOwnerDerived';
import { storeReturnMetadata, readReturnMetadata, type ReturnRef } from './projectSourceReturnMetadata';
import { prepareOwnerIndexRows } from './projectOwnerIndexRows';
import { advance, RETURN_BUDGET, type Cursor, type ReturnAccounting } from './projectSourceReturnStep';
import { storeReturnJson, readReturnJson, deleteReturnJson } from './projectSourceReturnCursor';
import { storageMeter } from './storageMeter';
import { checkReturnBudget } from './projectSourceReturnBudget';
import { longActionExpired } from '../src/long-action';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant, ForgeError } from '../src/errors';
import { ConvexError } from 'convex/values';
import type { IndexEntry } from '../src/work-hosted-index';
import { workSourcePins } from '../src/work-archive-metadata';
import { prepareFullReturnRows, storeOutputRows } from './projectSourceReturnRows';
import { selectedTreeHeads } from '../src/owner-derived';
type Snapshot = Cursor['snapshot'];
type Final = Cursor['final'];
async function advanceReturnProgress(
  ctx: ActionCtx,
  stage: Doc<'projectWorkGenerations'>,
  input: {
    projectId: Id<'hostedProjects'>;
    expectedBackupId: Id<'projectBackups'>;
    revision: number;
    operationId: string;
  },
  owner: string,
  initial?: {
    snapshot: Snapshot;
    final: Final;
    generationId?: Id<'projectWorkGenerations'>;
    previous?: Snapshot;
    ownerDerived?: unknown;
    generation?: Doc<'projectWorkGenerations'>;
    partial?: boolean;
    metadataOnly?: boolean;
    accounting?: ReturnAccounting;
    records?: IntentRecords;
  },
  actionStarted = Date.now(),
): Promise<(Doc<'projectWorkEvents'> & { accounting?: ReturnAccounting }) | null> {
  const started = Date.now();
  let c: Cursor;
  let preparedRecords = false;
  function read<T>(ref: ReturnRef, message: string): Promise<T> {
    return typeof ref === 'string'
      ? readReturnJson<T>(ctx, ref, message)
      : readReturnMetadata<T>(ctx, input.projectId, owner, ref);
  }
  const resuming = stage.returnCursor || stage.returnMetadataCursor;
  if (resuming) {
    c = await read<Cursor>(
      stage.returnCursor ?? JSON.parse(stage.returnMetadataCursor!),
      'The original source-return cursor is unavailable.',
    );
    if (c.snapshotRef)
      c.snapshot = await read<Cursor['snapshot']>(
        c.snapshotRef,
        'The original source-return snapshot is unavailable.',
      );
    invariant(c.protocol === 3 && c.phase === 'done', 'CLI_UPGRADE_REQUIRED', CLI_UPGRADE_MESSAGE);
  } else {
    invariant(initial, 'WORK_STALE', 'Resume the original return preparation.');
    const { data } = initial.snapshot;
    c = {
      protocol: 3,
      snapshot: initial.snapshot,
      accounting: initial.accounting,
      metadataOnly: initial.metadataOnly,
      final: initial.final,
      generationId: initial.generationId,
      phase: 'done',
      parents: [],
      pending: workSourcePins(data),
      heads: [
        ...new Set([
          ...data.lanes.map(l => l.head),
          ...data.channelMoves.map(m => m.head),
          ...(data.hostedChannelMoves ?? []).map(m => m.head),
          ...data.views.flatMap(v => (v.head ? [v.head] : [])),
          ...data.runs.map(r => r.head),
        ]),
      ],
      rows: [],
    };
    if (initial.previous && initial.generation) {
      const plan = prepareDelta(initial.previous, initial.snapshot, initial.generation, initial.partial);
      c.delta = plan.delta;
      c.metadata = plan.metadata;
      c.rows = plan.entries.filter(row => row.collection !== 'lanes' && row.collection !== 'views');
      c.diffstats = {
        records: plan.entries.filter(row => row.collection === 'lanes' || row.collection === 'views'),
      };
      const priorHeads = new Set([
        ...(initial.previous.data.nativeHead ? [initial.previous.data.nativeHead] : []),
        ...initial.previous.data.lanes.map(l => l.head),
        ...initial.previous.data.channelMoves.map(m => m.head),
        ...(initial.previous.data.hostedChannelMoves ?? []).map(m => m.head),
        ...initial.previous.data.views.flatMap(v => (v.head ? [v.head] : [])),
        ...initial.previous.data.runs.map(r => r.head),
      ]);
      const priorPins = new Set(initial.previous.manifest.files.map(pin => pin.sha256));
      c.pending = c.pending.filter(head => !priorPins.has(head));
      c.delta.stopParents = [...priorPins];
      c.heads = c.heads.filter(head => !priorHeads.has(head));
      c.delta.views = [...new Set([...c.delta.views, ...c.delta.summaries])];
    } else {
      await prepareFullReturnRows(ctx, c, stage._id, initial.records);
      c.delta = {
        entries: [],
        removed: [],
        views: data.views.map((_, i) => i),
        summaries: [],
        positions: {},
        stopParents: [],
        trees: selectedTreeHeads(data),
        readBytes: 0,
        payloadReplacements: 0,
      };
      c.full = true;
    }
    await installOwnerDerived(ctx, c, initial.ownerDerived);
    console.log('source-return owner-derived', { fastPath: true, metadataOnly: true });
    if (c.full) {
      const counts = c.metadata!.counts;
      for (const row of c.rows) counts[row.collection] = (counts[row.collection] ?? 0) + 1;
      c.metadata!.counts = counts;
      delete c.delta;
    }
    await prepareOwnerIndexRows(ctx, c);
    if (c.full && c.outputRefs) {
      preparedRecords = !!initial.records;
      await storeOutputRows(ctx, c, c.snapshot.output ?? [], stage._id);
      c.outputCleanup = c.outputRefs.map(ref => ref.key);
      delete c.snapshot.output;
      // The exact Work remains in its authenticated checkpoint/preparation
      // snapshot. A phase-done continuation only needs immutable output pages.
      c.snapshot.data = {
        ...data,
        ...Object.fromEntries(
          Object.entries(data)
            .filter(([, value]) => Array.isArray(value))
            .map(([key]) => [key, []]),
        ),
      };
    }
  }

  invariant(
    c.final.owner === owner &&
      c.final.projectId === input.projectId &&
      c.final.expectedBackupId === input.expectedBackupId &&
      c.final.expectedRevision === input.revision &&
      c.final.operationId === input.operationId &&
      c.final.backupId === stage.backupId,
    'WORK_OPERATION_CHANGED',
    'Resume the original source, Work and hosted base.',
  );
  // Reads this invocation made so far (including the cursor and snapshot) add to
  // the totals the cursor carried; each commit persists the running total.
  const meter = storageMeter(ctx),
    prior = c.accounting ?? { storageReads: 0, storageBytes: 0, steps: 0, invocations: 0 };
  const accounting = (steps: number): ReturnAccounting => ({
    storageReads: prior.storageReads + meter.reads,
    storageBytes: prior.storageBytes + meter.bytes,
    steps,
    invocations: prior.invocations + 1,
  });
  let step = stage.returnStep ?? 0;
  if (preparedRecords) {
    // Publish only a computational cursor here. The next invocation drains
    // output without holding preparation context or owner display documents.
    const snapshot = await storeReturnMetadata(ctx, input.projectId, owner, stage._id, c.snapshot);
    if (c.outputCleanup) snapshot.cleanup = c.outputCleanup;
    c.snapshotRef = snapshot;
    delete c.outputCleanup;
    c.accounting = accounting(step + 1);
    const cursor = await storeReturnMetadata(ctx, input.projectId, owner, stage._id, {
      ...c,
      snapshot: undefined,
    });
    await ctx.runMutation(internal.projectReturnIndexStage.batch, {
      projectId: input.projectId,
      owner,
      generationId: c.generationId,
      revision: input.revision,
      partitionId: stage._id,
      batch: stage.nextBatch,
      entries: [],
      last: false,
      step,
      metadataCursor: JSON.stringify(cursor),
      metadataSnapshot: JSON.stringify(snapshot),
    });
    return null;
  }
  if (stage.status !== 'ready') {
    let batch = stage.nextBatch;
    const drainStarted = Date.now();
    // Reuse unchanged State bytes within this action, with current authority and
    // storage checks on every use and a fixed byte bound across all history.

    let committedAt = drainStarted,
      items = 0;
    let batchStates = 0,
      batchSourceBytes = 0,
      batchFailures = 0,
      derivedRows = 0,
      pending: IndexEntry[] = [],
      pendingBytes = 0;
    while (true) {
      const phase = c.phase;
      // Full partitions append rows per commit, so several advances share one
      // step budget. Delta rows stay in the cursor; each advance has its own.
      const result = await advance(
        ctx,
        c,
        undefined,
        c.delta
          ? undefined
          : {
              states: batchStates,
              sourceBytes: batchSourceBytes,
              rows: pending.length,
              rowBytes: pendingBytes,
            },
      );
      batchStates += result.states;
      batchSourceBytes += result.sourceBytes;
      batchFailures += result.derivedReadFailures;
      derivedRows += result.entries.length;

      const progressed = result.states > 0 || result.entries.length > 0 || c.phase !== phase;
      if (result.entries.length) {
        pending.push(...result.entries);
        pendingBytes += Buffer.byteLength(JSON.stringify(result.entries));
      }
      items++;
      // Checkpoint many logical items together instead of writing the cursor
      // (and, for delta returns, the entire retained metadata) per item.
      const room =
        !!c.delta ||
        (progressed &&
          batchStates < RETURN_BUDGET.states &&
          batchSourceBytes < RETURN_BUDGET.sourceBytes &&
          pending.length < RETURN_BUDGET.rows &&
          pendingBytes < RETURN_BUDGET.rowBytes);
      if (room && !result.last && items < 64 && Date.now() - committedAt < RETURN_BUDGET.commitMs) continue;
      items = 0;
      committedAt = Date.now();
      const done = 1,
        total = 1;
      const elapsedMs = Date.now() - Date.parse(stage.returnAt ?? new Date(started).toISOString());
      c.accounting = accounting(step + 1);
      const progress = JSON.stringify({
        ...c.accounting,
        phase: c.phase,
        ...(c.rows.length ? { rowsPending: c.rows.length } : {}),
        step: step + 1,
        done,
        total,
        elapsedMs,
        etaSeconds: 0,
      });
      // Immutable Work/manifest metadata is stored once, outside the advancing
      // cursor. Legacy cursors with an embedded snapshot upgrade on their next
      // successful step without changing the operation or original timestamp.
      const freshSnapshot = !c.snapshotRef;
      const store = (value: unknown) =>
        c.metadataOnly
          ? storeReturnMetadata(ctx, input.projectId, owner, stage._id, value)
          : storeReturnJson(ctx, value);
      const snapshot = c.snapshotRef ?? (await store(c.snapshot));
      if (typeof snapshot !== 'string' && c.outputCleanup) {
        snapshot.cleanup = c.outputCleanup;
        delete c.outputCleanup;
      }
      c.snapshotRef = snapshot;
      const position = { ...c, snapshot: undefined };
      const cursor = await store(position);
      const committed = await ctx.runMutation(internal.projectReturnIndexStage.batch, {
        projectId: input.projectId,
        owner,
        generationId: c.generationId,
        revision: input.revision,
        partitionId: stage._id,
        batch,
        step,
        progress,
        ...(typeof cursor === 'string' ? { cursor } : { metadataCursor: JSON.stringify(cursor) }),
        ...(typeof snapshot === 'string' ? { snapshot } : { metadataSnapshot: JSON.stringify(snapshot) }),
        entries: pending,
        last: result.last,
        ...(c.metadata ? { metadata: JSON.stringify(c.metadata) } : {}),
      });
      console.log('source-return step', {
        phase: c.phase,
        step,
        rows: pending.length,
        rowBytes: Buffer.byteLength(JSON.stringify(pending)),
        states: batchStates,
        sourceBytes: batchSourceBytes,
        derivedReadFailures: batchFailures,
        derivedRows,
        elapsedMs: Date.now() - started,
        storageBytes: c.accounting.storageBytes,
        committed,
      });
      if (!committed) {
        if (typeof cursor === 'string') await deleteReturnJson(ctx, cursor);
        if (freshSnapshot && typeof snapshot === 'string') await deleteReturnJson(ctx, snapshot);
        const current = await ctx.runQuery(internal.projectWork.get, { projectId: input.projectId, owner });
        invariant(
          current.work?.backupId === input.expectedBackupId && current.work.revision === input.revision,
          'WORK_STALE',
          'Hosted source or Work changed during return preparation.',
        );
        // A replaced derived index does not change the validated source/Work.
        // Preserve the existing final-publication/rebuild fallback in that case.
        if (current.work.generationId !== c.generationId) {
          const receipt = await ctx.runMutation(internal.projectWork.returnSource, c.final);
          console.log('source-return complete', {
            revision: receipt.revision,
            index: 'rebuild',
            elapsedMs: Date.now() - started,
            ...accounting(step),
          });
          return { ...receipt, accounting: accounting(step) };
        }
      }
      if (!committed) return null;
      batch++;
      step++;
      batchStates = batchSourceBytes = batchFailures = derivedRows = pendingBytes = 0;
      pending = [];
      if (result.last) {
        if (longActionExpired(actionStarted)) return null;
        break;
      }
      if (checkReturnBudget({ storageBytes: meter.bytes, steps: step - (stage.returnStep ?? 0) }))
        return null;
      if (
        longActionExpired(actionStarted) ||
        Date.now() - drainStarted >= RETURN_BUDGET.actionMs ||
        step - (stage.returnStep ?? 0) >= RETURN_BUDGET.actionSteps
      )
        return null;
    }
  }
  // Legacy ready delta cursors also enter this path: their original projection
  // is immutable and the private commit resumes without a new push/return ID.
  const stagedDelta =
    c.delta && (c.delta.entries.length + c.delta.removed.length > 1000 || stage.returnCommitPlan);
  if (stagedDelta && c.delta) {
    invariant(c.generationId, 'WORK_STALE', 'The return baseline is unavailable.');
    const pins = c.delta.removed,
      entries = c.delta.entries;
    const plan = digest(JSON.stringify([c.final, c.metadata, pins, entries]));
    let committed = stage;
    while (!committed.returnCommitDone) {
      const offset = committed.returnCommitOffset ?? 0;
      const removed = pins.slice(offset, offset + 1000);
      const rows = entries.slice(
        Math.max(0, offset - pins.length),
        Math.max(0, offset - pins.length) + 1000 - removed.length,
      );
      committed = await ctx.runMutation(internal.projectReturnCommit.batch, {
        projectId: input.projectId,
        owner,
        generationId: c.generationId,
        partitionId: stage._id,
        expectedBackupId: input.expectedBackupId,
        revision: input.revision,
        operationId: input.operationId,
        plan,
        copy: !committed.returnCommitCopied,
        cursor: committed.returnCommitCursor ?? null,
        offset,
        total: pins.length + entries.length,
        removed,
        entries: rows,
      });
      if (longActionExpired(actionStarted) || Date.now() - started >= RETURN_BUDGET.actionMs) return null;
    }
  }
  const receipt = await ctx.runMutation(internal.projectWork.returnSource, {
    ...c.final,
    projection: {
      generationId: c.generationId,
      ...(c.delta && !stagedDelta ? { deltaPartitionId: stage._id } : { partitionId: stage._id }),
      metadata: JSON.stringify(c.metadata),
      entries: c.delta && !stagedDelta ? c.delta.entries : [],
      removed: c.delta && !stagedDelta ? c.delta.removed : [],
    },
  });
  const total = accounting(step);
  console.log('source-return complete', {
    revision: receipt.revision,
    elapsedMs: Date.now() - started,
    ...total,
  });
  return { ...receipt, accounting: total };
}

/** Concurrent continuations use the same immutable cursor and CAS. A loser
 * observes the winning cursor/receipt instead of reporting a stale operation. */
export async function returnProgress(...args: Parameters<typeof advanceReturnProgress>) {
  const [ctx, stage, input, owner] = args;
  try {
    return await advanceReturnProgress(...args);
  } catch (error) {
    const code =
      error instanceof ForgeError
        ? error.code
        : error instanceof ConvexError && error.data && typeof error.data === 'object'
          ? (error.data as { code?: unknown }).code
          : undefined;
    if (code !== 'WORK_STALE') throw error;
    const current: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
      internal.projectReturnIndexStage.resume,
      {
        projectId: input.projectId,
        owner,
        backupId: stage.backupId,
        revision: stage.revision,
        operationId: input.operationId,
      },
    );
    if (current) {
      const original: Doc<'projectWorkEvents'> | null = await ctx.runQuery(internal.projectWork.find, {
        projectId: input.projectId,
        owner,
        operationId: input.operationId,
      });
      if (original) return original;
      const selected = await ctx.runQuery(internal.projectWork.get, { projectId: input.projectId, owner });
      if (selected.work?.backupId !== input.expectedBackupId || selected.work.revision !== input.revision)
        throw error;
      if (
        current.returnStep !== stage.returnStep ||
        current.returnCursor !== stage.returnCursor ||
        current.returnMetadataCursor !== stage.returnMetadataCursor
      )
        return null;
    }
    throw error;
  }
}
