// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { load, source } from './projectWorkLoad';
import { replayReturnJournal } from './projectSourceReturnJournal';
import { longActionExpired } from '../src/long-action';
import type { ExchangeObjectReader } from './projectExchangeReader';
import { readReturnMetadata, storeReturnMetadata } from './projectSourceReturnMetadata';
import {
  readCandidateRecords,
  hydrateIntents,
  projectIntentRecords,
  type IntentRecords,
} from './projectSourceReturnRecords';
import type { MetadataRef } from './projectSourceReturnMetadata';
import { readReturnJson, storeReturnJson } from './projectSourceReturnCursor';
import { storageMeter } from './storageMeter';
import type { ReturnAccounting } from './projectSourceReturnStep';
import {
  sourceReturnChunks,
  validateSourceReturnChunk,
  type ReturnValidationChunk,
} from '../src/work-source-return-chunks';
import { invariant } from '../src/errors';

export const PREPARE_BUDGET = { workBytes: 16 * 1024 * 1024, chunks: 8, actionMs: 15000 };
type Input = {
  projectId: Id<'hostedProjects'>;
  backupId: Id<'projectBackups'>;
  expectedBackupId: Id<'projectBackups'>;
  revision: number;
  operationId: string;
};
type Current = Awaited<ReturnType<typeof load>>;
type Candidate = Awaited<ReturnType<typeof source>>;
type Position = {
  input: Input;
  generationId?: Id<'projectWorkGenerations'>;
  phase: 'journal' | 'source' | 'validate';
  current: Current;
  before: { lanes: { id: string; head: string }[] };
  chunks: Id<'_storage'>[];
  offset: number;
  candidate?: Id<'_storage'>;
  candidateRef?: MetadataRef;
  records?: IntentRecords;
  accounting?: ReturnAccounting;
};
async function workSize(reader: ExchangeObjectReader, backup: Doc<'projectBackups'>, owner: string) {
  // Owner metadata publications already use the metadata-only preparation path.
  if (backup.transport !== 'objects' || backup.metadataPublication) return 0;
  const [bytes] = await reader.read(backup.projectId, owner, [
    {
      sha256: backup.objectManifest?.digest ?? backup.digest,
      size: backup.objectManifest?.size ?? backup.size,
    },
  ]);
  const root = JSON.parse(bytes!.toString('utf8'));
  return root.kind === 'forge-native-exchange'
    ? root.work.size
    : (root.files?.find((file: { path: string }) => file.path === 'work.json')?.size ?? 0);
}
/** Large compatibility returns retain one full Work at a time. Source loading,
 * candidate loading and chunk validation happen in distinct invocations. The
 * existing small return and record-delta paths keep their incremental projection. */
export async function prepareLargeReturn(
  ctx: ActionCtx,
  input: Input,
  owner: string,
  reader: ExchangeObjectReader,
  backup: Doc<'projectBackups'>,
  prior: Doc<'projectBackups'>,
  stage: Doc<'projectWorkGenerations'> | null,
  actionStarted = Date.now(),
) {
  const pins: Input = {
    projectId: input.projectId,
    backupId: input.backupId,
    expectedBackupId: input.expectedBackupId,
    revision: input.revision,
    operationId: input.operationId,
  };
  if (
    !stage?.returnPrepareCursor &&
    (backup.transport !== 'objects' ||
      backup.preview.format !== 'native' ||
      (input.revision - prior.preview.revision < 100 &&
        Math.max(await workSize(reader, backup, owner), await workSize(reader, prior, owner)) <
          PREPARE_BUDGET.workBytes))
  )
    return;
  const project: Doc<'hostedProjects'> = await ctx.runQuery(internal.projectWork.get, {
    projectId: input.projectId,
    owner,
  });
  invariant(
    project.work?.backupId === input.expectedBackupId && project.work.revision === input.revision,
    'WORK_STALE',
    'Hosted source or Work changed during return preparation.',
  );
  let position: Position;
  if (stage?.returnPrepareCursor) {
    position = await readReturnMetadata(ctx, input.projectId, owner, JSON.parse(stage.returnPrepareCursor));
    invariant(
      JSON.stringify(position.input) === JSON.stringify(pins),
      'WORK_OPERATION_CHANGED',
      'Resume the original source-return preparation.',
    );
  } else {
    const generation: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
      internal.projectWorkIndexStore.current,
      {
        projectId: input.projectId,
        owner,
      },
    );
    // Absence of a derived index is never a new source-return precondition.
    if (
      (generation &&
        (generation.backupId !== input.expectedBackupId || generation.revision !== input.revision)) ||
      (!generation && input.revision - prior.preview.revision < 100)
    )
      return;
    const current: Current = {
      ...(await source(ctx, input.expectedBackupId, owner, reader, true)),
      project,
      events: [],
    };
    console.log('source-return prepare load done', { reason: 'durable-current', revision: input.revision });
    invariant(
      current.backup._id === input.expectedBackupId &&
        current.data.revision === project.work!.initialRevision,
      'WORK_STALE',
      'Hosted source or Work changed during return preparation.',
    );
    const partitionId: Id<'projectWorkGenerations'> | null = await ctx.runMutation(
      internal.projectReturnIndexStage.begin,
      {
        projectId: input.projectId,
        owner,
        generationId: generation?._id,
        revision: input.revision,
        backupId: input.backupId,
        localRevision: backup.preview.revision,
        metadata: '{}',
        operationId: input.operationId,
        at: stage?.returnAt ?? new Date().toISOString(),
        progress: true,
      },
    );
    invariant(partitionId, 'WORK_STALE', 'Hosted Work changed during return preparation.');
    stage = await ctx.runQuery(internal.projectReturnIndexStage.resume, {
      projectId: input.projectId,
      owner,
      backupId: input.backupId,
      revision: backup.preview.revision + 1,
      operationId: input.operationId,
    });
    invariant(stage, 'WORK_STALE', 'Source-return staging changed.');
    const chunks: Id<'_storage'>[] = [];

    position = {
      input: pins,
      generationId: generation?._id,
      phase: 'journal',
      chunks,
      offset: 0,
      before: { lanes: current.data.lanes.map(({ id, head }) => ({ id, head })) },
      current: { ...current, publication: undefined, events: [] },
    };
  }
  invariant(stage, 'WORK_STALE', 'Source-return staging changed.');
  const save = async () => {
    const meter = storageMeter(ctx),
      prior = position.accounting;
    position.accounting = {
      storageReads: (prior?.storageReads ?? 0) + meter.reads,
      storageBytes: (prior?.storageBytes ?? 0) + meter.bytes,
      steps: prior?.steps ?? 0,
      invocations: (prior?.invocations ?? 0) + 1,
    };
    const ref = await storeReturnMetadata(ctx, input.projectId, owner, stage!._id, position);
    await ctx.runMutation(internal.projectReturnIndexStage.prepare, {
      projectId: input.projectId,
      owner,
      generationId: position.generationId,
      revision: input.revision,
      partitionId: stage!._id,
      operationId: input.operationId,
      expectedBackupId: input.expectedBackupId,
      expectedCursor: stage!.returnPrepareCursor,
      cursor: JSON.stringify({
        ...ref,
        blobs: [...position.chunks, ...(position.candidate ? [position.candidate] : [])],
        cleanup: [
          ...(position.candidateRef ? [position.candidateRef.key] : []),
          ...(position.records?.refs.map(r => r.ref.key) ?? []),
          ...(position.records?.output?.map(r => r.key) ?? []),
        ],
      }),
      progress: JSON.stringify({
        phase: position.phase === 'journal' ? 'journal' : 'preparing',
        step:
          position.phase === 'journal'
            ? position.current.data.revision
            : position.phase === 'source'
              ? 1
              : 2 + (position.candidateRef ? 1 : 0) + position.offset + (position.records?.projected ?? 0),
        done:
          position.phase === 'journal'
            ? position.current.data.revision - position.current.project.work!.initialRevision
            : position.offset + (position.records?.projected ?? 0),
        total:
          position.phase === 'journal'
            ? input.revision - position.current.project.work!.initialRevision
            : position.chunks.length + (position.records?.refs.length ?? 0),
        elapsedMs: 0,
        etaSeconds: null,
      }),
    });
    return { pending: true as const };
  };
  if (!stage.returnPrepareCursor) return save();
  if (position.phase === 'journal') {
    const complete = await replayReturnJournal(ctx, position.current, owner, actionStarted);
    if (!complete) return save();
    for (const chunk of sourceReturnChunks(position.current.data))
      position.chunks.push(await storeReturnJson(ctx, chunk));
    position.before = { lanes: position.current.data.lanes.map(({ id, head }) => ({ id, head })) };
    position.current.data = sourceReturnChunks(position.current.data).next().value!.data;
    position.phase = 'source';
    return save();
  }
  if (position.phase === 'source') {
    const candidate = await source(ctx, input.backupId, owner, reader, true);
    console.log('source-return prepare source done', {
      reason: 'durable-candidate',
      revision: input.revision,
    });
    position.candidate = await storeReturnJson(ctx, candidate);
    position.phase = 'validate';
    return save();
  }
  invariant(position.candidate, 'WORK_STALE', 'Resume the original candidate preparation.');
  let candidate: Candidate;
  if (position.candidateRef && position.records) {
    candidate = await readReturnMetadata(ctx, input.projectId, owner, position.candidateRef);
  } else {
    const decoded = await readCandidateRecords(ctx, input.projectId, owner, stage._id, position.candidate);
    candidate = decoded.candidate;
    position.records = decoded.records;
    position.candidateRef = await storeReturnMetadata(ctx, input.projectId, owner, stage._id, candidate);
    // Commit the bounded record layout before post-prepare work. A crash no
    // longer decodes the legacy full snapshot again, and the next action starts
    // with only the compact context and immutable record pages.
    return save();
  }
  const started = Date.now(),
    end = Math.min(position.chunks.length, position.offset + PREPARE_BUDGET.chunks);
  while (position.offset < end) {
    const chunk = await readReturnJson<ReturnValidationChunk>(
      ctx,
      position.chunks[position.offset]!,
      'The original retained-history chunk is unavailable.',
    );
    const intents =
      chunk.collection === 'intents'
        ? await hydrateIntents(
            ctx,
            input.projectId,
            owner,
            position.records!,
            new Set(chunk.data.intents.map(i => i.id)),
          )
        : candidate.data.intents;
    validateSourceReturnChunk(chunk, { ...candidate.data, intents }, candidate.manifest);
    position.offset++;
    if (Date.now() - started >= PREPARE_BUDGET.actionMs || longActionExpired(actionStarted)) break;
  }
  if (position.offset < position.chunks.length) return save();
  if ((position.records!.projected ?? 0) < position.records!.refs.length) {
    const records = position.records!;
    await projectIntentRecords(ctx, input.projectId, owner, records, candidate.data, async rows => {
      let batch: import('../src/work-hosted-index').IndexEntry[] = [],
        bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        (records.output ??= []).push(
          await storeReturnMetadata(ctx, input.projectId, owner, stage!._id, batch),
        );
        batch = [];
        bytes = 0;
      };
      for (const row of rows) {
        const size = Buffer.byteLength(JSON.stringify(row));
        if (batch.length && (batch.length >= 100 || bytes + size > 256 * 1024)) await flush();
        batch.push(row);
        bytes += size;
        const counts = (records.counts ??= {});
        counts[row.collection] = (counts[row.collection] ?? 0) + 1;
      }
      await flush();
    });
    return save();
  }
  console.log('source-return prepare validation done', { reason: 'durable-chunks', chunks: position.offset });
  return {
    pending: false as const,
    current: position.current,
    before: position.before,
    candidate,
    records: position.records,
    accounting: position.accounting,
  };
}
