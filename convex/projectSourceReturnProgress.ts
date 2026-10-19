// SPDX-License-Identifier: Apache-2.0
'use node';
import {
  prepareDelta,
  cachedParents,
  deltaFits,
  derivedCollections as derived,
} from './projectSourceReturnDelta';
export { RETURN_BUDGET } from './projectSourceReturnStep';
import { installOwnerDerived } from './projectOwnerDerived';
import { exchangeObjectReader } from './projectExchangeReader';
import { advance, RETURN_BUDGET, type Cursor, type ReturnAccounting } from './projectSourceReturnStep';
import { storeReturnJson, readReturnJson, deleteReturnJson } from './projectSourceReturnCursor';
import { storageMeter } from './storageMeter';
import { checkReturnBudget } from './projectSourceReturnBudget';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import type { IndexEntry } from '../src/work-hosted-index';
import { workSourcePins } from '../src/work-archive-metadata';
import { viewIndexEntries } from '../src/view-hosted-index';
type Snapshot = Cursor['snapshot'];
type Final = Cursor['final'];
export async function returnProgress(
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
    generationId: Id<'projectWorkGenerations'>;
    previous?: Snapshot;
    ownerDerived?: unknown;
    generation?: Doc<'projectWorkGenerations'>;
    partial?: boolean;
  },
): Promise<(Doc<'projectWorkEvents'> & { accounting?: ReturnAccounting }) | null> {
  const started = Date.now();
  let c: Cursor;
  if (stage.returnCursor) {
    c = await readReturnJson<Cursor>(
      ctx,
      stage.returnCursor,
      'The original source-return cursor is unavailable.',
    );
    if (c.snapshotRef)
      c.snapshot = await readReturnJson<Cursor['snapshot']>(
        ctx,
        c.snapshotRef,
        'The original source-return snapshot is unavailable.',
      );
  } else {
    invariant(initial, 'WORK_STALE', 'Resume the original return preparation.');
    const { data } = initial.snapshot;
    c = {
      snapshot: initial.snapshot,
      final: initial.final,
      generationId: initial.generationId,
      phase: 'parents',
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
      head: 0,
      view: 0,
      states: [],
      positions: [],
      rows: [],
    };
    if (initial.previous && initial.generation) {
      const plan = prepareDelta(initial.previous, initial.snapshot, initial.generation, initial.partial);
      c.delta = plan.delta;
      c.metadata = plan.metadata;
      c.rows = plan.entries.filter(row => row.collection !== 'lanes' && row.collection !== 'views');
      c.diffstats = {
        records: plan.entries.filter(row => row.collection === 'lanes' || row.collection === 'views'),
        index: 0,
        cache: [],
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
      // A newly selected historical State can add an ancestor that old pair
      // indexes did not cover. Fill its parents rather than infer a negative.
      const historicalSelection = c.heads.some(head => priorPins.has(head) && !priorHeads.has(head));
      c.delta.stopParents = historicalSelection ? [] : [...priorHeads];
      c.pending = c.pending.filter(head => historicalSelection || !priorPins.has(head));
      c.parents = await cachedParents(ctx, initial.snapshot, owner, c.generationId, c.pending);
      const known = new Set(c.parents.map(([head]) => head));
      c.pending = [...new Set([...c.pending.filter(head => !known.has(head)), ...(c.delta.trees ?? [])])];
      c.heads = c.heads.filter(head => !priorHeads.has(head));
      // Summary-only changes (acceptance and supersession) retain
      // the immutable file provenance already selected under this generation.
      for (const index of c.delta.summaries) {
        const view = data.views[index]!;
        const [old] = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
          projectId: input.projectId,
          owner,
          generationId: c.generationId,
          keys: [{ collection: 'viewDetails', key: view.id }],
        });
        if (!old) {
          c.delta.views.push(index);
          continue;
        }
        let prior = JSON.parse(old.value);
        if (prior.payloadKey) {
          const chunks: string[] = [];
          let cursor: string | null = null;
          do {
            const page: { values: string[]; cursor: string | null } = await ctx.runQuery(
              internal.projectWorkIndexStore.payload,
              {
                projectId: input.projectId,
                owner,
                generationId: c.generationId,
                collection: 'viewDetails',
                parent: prior.payloadKey,
                cursor,
              },
            );
            chunks.push(...page.values);
            cursor = page.cursor;
          } while (cursor !== null);
          invariant(chunks.length === prior.payloadParts, 'WORK_STALE', 'View provenance summary changed.');
          prior = JSON.parse(chunks.join(''));
        }
        const rows = viewIndexEntries(data, undefined, {
          index,
          positions: new Map(),
          cachedProvenance: {
            fileCount: prior.fileCount ?? null,
            provenanceAvailable: prior.provenanceAvailable === true,
          },
        });
        c.rows.push(...rows);
      }
    }
  }
  if (initial?.ownerDerived && !stage.returnCursor) await installOwnerDerived(ctx, c, initial.ownerDerived);
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
  if (stage.status !== 'ready') {
    checkReturnBudget(accounting(step));
    let batch = stage.nextBatch;
    const actionStarted = Date.now();
    // Reuse unchanged State bytes within this action, with current authority and
    // storage checks on every use and a fixed byte bound across all history.
    const reader = exchangeObjectReader(ctx, true, RETURN_BUDGET.sourceBytes);
    let committedAt = actionStarted,
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
        reader,
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
      if (c.phase !== phase || !c.phaseStarted) c.phaseStarted = Date.now();
      if (c.delta) {
        const rows = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
          projectId: input.projectId,
          owner,
          generationId: c.generationId,
          keys: result.entries.map(({ collection, key }) => ({ collection, key })),
        });
        for (const [index, row] of result.entries.entries()) {
          const existing = c.delta.entries.findIndex(
            e => e.collection === row.collection && e.key === row.key,
          );
          const old = rows[index] ?? c.delta.entries[existing];
          if (rows[index] && existing < 0) {
            c.delta.readBytes += Buffer.byteLength(JSON.stringify(rows[index])) + 2048;
            if (!row.collection.endsWith(':payload')) {
              const payloadKey = JSON.parse(rows[index]!.value).payloadKey;
              if (payloadKey && JSON.parse(row.value).payloadKey !== payloadKey)
                c.delta.payloadReplacements++;
            }
          }
          if (old) {
            if (row.collection !== 'viewFiles') row.position = old.position;
          } else {
            const position = c.delta.positions[row.collection] ?? 0;
            c.delta.positions[row.collection] = position + 1;
            if (
              row.collection !== 'viewFiles' &&
              !row.collection.endsWith(':payload') &&
              !row.collection.startsWith('sourceTree')
            )
              row.position = position;
            if (
              derived.includes(row.collection) ||
              row.collection === 'diffstats' ||
              (c.delta.partial && row.collection === 'sourcePins') ||
              row.collection.startsWith('sourceStateParent') ||
              row.collection.startsWith('sourceAncestry')
            )
              c.metadata!.counts[row.collection] = (c.metadata!.counts[row.collection] ?? 0) + 1;
          }
          if (existing >= 0) c.delta.entries[existing] = row;
          else c.delta.entries.push(row);
        }
        result.entries = [];
        if (!deltaFits(c.delta, Buffer.byteLength(JSON.stringify(c.final)))) {
          if (c.delta.partial) {
            // This cursor contains touched records only. Keep the verified
            // checkpoint and let the existing index reader rebuild from its
            // complete record root rather than publish a partial projection.
            return await ctx.runMutation(internal.projectWork.returnSource, c.final);
          }
          // Large deltas use the existing full private partition, never a capacity denial.
          delete c.delta;
          delete c.diffstats;
          c.phase = 'parents';
          c.parents = [];
          c.pending = workSourcePins(c.snapshot.data);
          c.head = 0;
          c.view = 0;
          c.rows = [];
          c.positions = [];
          delete c.metadata;
          c.heads = [
            ...new Set([
              ...c.snapshot.data.lanes.map(l => l.head),
              ...c.snapshot.data.channelMoves.map(m => m.head),
              ...(c.snapshot.data.hostedChannelMoves ?? []).map(m => m.head),
              ...c.snapshot.data.views.flatMap(v => (v.head ? [v.head] : [])),
              ...c.snapshot.data.runs.map(r => r.head),
            ]),
          ];
          result.last = false;
        }
      }
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
      const done =
        c.phase === 'done'
          ? 1
          : c.phase === 'views'
            ? c.view
            : c.phase === 'ancestry'
              ? c.head
              : c.phase === 'diffstats'
                ? (c.diffstats?.index ?? 0)
                : c.parents.length;
      const total =
        c.phase === 'done'
          ? 1
          : c.phase === 'views'
            ? (c.delta?.views.length ?? c.snapshot.data.views.length)
            : c.phase === 'ancestry'
              ? c.heads.length
              : c.phase === 'diffstats'
                ? (c.diffstats?.records.length ?? 0)
                : done + c.pending.length;
      const elapsedMs = Date.now() - Date.parse(stage.returnAt ?? new Date(started).toISOString());
      c.accounting = accounting(step + 1);
      const progress = JSON.stringify({
        ...c.accounting,
        phase: c.phase,
        step: step + 1,
        done,
        total,
        elapsedMs,
        etaSeconds:
          done > 0
            ? Math.ceil(((Date.now() - c.phaseStarted!) / 1000 / done) * Math.max(0, total - done))
            : null,
      });
      // Immutable Work/manifest metadata is stored once, outside the advancing
      // cursor. Legacy cursors with an embedded snapshot upgrade on their next
      // successful step without changing the operation or original timestamp.
      const freshSnapshot = !c.snapshotRef;
      const snapshot = c.snapshotRef ?? (await storeReturnJson(ctx, c.snapshot));
      c.snapshotRef = snapshot;
      const position = { ...c, snapshot: undefined };
      const cursor = await storeReturnJson(ctx, position);
      const committed = await ctx.runMutation(internal.projectReturnIndexStage.batch, {
        projectId: input.projectId,
        owner,
        generationId: c.generationId,
        revision: input.revision,
        partitionId: stage._id,
        batch,
        step,
        progress,
        cursor,
        snapshot,
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
        await deleteReturnJson(ctx, cursor);
        if (freshSnapshot) await deleteReturnJson(ctx, snapshot);
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
      if (result.last) break;
      checkReturnBudget(c.accounting);
      if (
        Date.now() - actionStarted >= RETURN_BUDGET.actionMs ||
        step - (stage.returnStep ?? 0) >= RETURN_BUDGET.actionSteps
      )
        return null;
    }
  }
  const receipt = await ctx.runMutation(internal.projectWork.returnSource, {
    ...c.final,
    projection: {
      generationId: c.generationId,
      ...(c.delta ? { deltaPartitionId: stage._id } : { partitionId: stage._id }),
      metadata: JSON.stringify(c.metadata),
      entries: c.delta?.entries ?? [],
      removed: c.delta?.removed ?? [],
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
