// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import type { ExchangeObjectReader } from './projectExchangeReader';
import { recordExchange } from './projectWorkRecordExchange';
import { prepareRecordReturn, preservesParsedWorkBytes } from '../src/work-return-context';
import { recordIdentity, recordMap } from '../src/work-exchange-records';
import { validateWorkDelta, supportsWorkDelta, WORK_DELTA_BYTES } from '../src/work-exchange-delta';
import { metadataRequest } from '../src/work-metadata';
import {
  hostedCommandSchema,
  hostedEventSchema,
  sourceReturnSchema,
  type HostedEvent,
} from '../src/work-types';
import { invariant } from '../src/errors';
import { returnChanges } from './coordinationReturnChanges';
import { returnProgress, recordReturnCursor } from './projectSourceReturnProgress';
import { readOwnerDerived } from './projectOwnerDerived';
type Input = {
  projectId: Id<'hostedProjects'>;
  backupId: Id<'projectBackups'>;
  expectedBackupId: Id<'projectBackups'>;
  revision: number;
  operationId: string;
  ownerDerived?: { sha256: string; size: number };
};
export async function recordReturn(
  ctx: ActionCtx,
  input: Input,
  owner: string,
  reader: ExchangeObjectReader,
  backup: Doc<'projectBackups'>,
  prior: Doc<'projectBackups'>,
  priorAt?: string,
  actionStarted = Date.now(),
): Promise<
  | {
      receipt:
        | (Doc<'projectWorkEvents'> & { accounting?: import('./projectSourceReturnStep').ReturnAccounting })
        | null;
    }
  | undefined
> {
  const skip = (reason: string) => {
    console.log('source-return record skip', { reason, revision: input.revision });
    invariant(
      backup.validatedWorkRecords !== 1 || prior.validatedWorkRecords !== 1,
      'WORK_RETURN_DELTA_UNAVAILABLE',
      `Record source return is unavailable (${reason}). The uploaded checkpoint remains available.`,
    );
    return undefined;
  };
  if (backup.validatedWorkRecords !== 1) return skip('candidate-records-unvalidated');
  if (prior.validatedWorkRecords !== 1) return skip('previous-records-unvalidated');
  const project = await ctx.runQuery(internal.projectWork.get, { projectId: input.projectId, owner });
  invariant(
    project.work?.backupId === input.expectedBackupId && project.work.revision === input.revision,
    'WORK_STALE',
    'Hosted source or Work changed before record-delta preparation.',
  );
  const candidate = await recordExchange(backup, owner, reader, 32 * 1024 * 1024, 1000),
    previous = await recordExchange(prior, owner, reader, 8 * 1024 * 1024, 1000);
  if (!candidate) return skip('candidate-catalog-unavailable');
  if (!previous) return skip('previous-catalog-unavailable');
  if (!candidate.root.delta) return skip('delta-missing');
  if (candidate.root.delta.size > WORK_DELTA_BYTES) return skip('delta-over-budget');
  if (!preservesParsedWorkBytes(previous.records)) return skip('previous-parsed-bytes-differ');
  if (!preservesParsedWorkBytes(candidate.records)) return skip('candidate-parsed-bytes-differ');
  const raw = JSON.parse((await candidate.read(candidate.root.delta)).toString('utf8'));
  if (raw?.base?.root !== previous.root.records.sha256) return skip('delta-base-root-differs');
  // Old retries without an explicit journal pin retain the full compatibility path.
  if (raw?.base?.journalRevision !== input.revision) return skip('delta-journal-revision-differs');
  const delta = validateWorkDelta(previous.records, candidate.records, raw, {
    root: previous.root.records.sha256,
    revision: input.revision,
  });
  if (!supportsWorkDelta(previous.records, candidate.records)) return skip('delta-layout-unsupported');
  const events: HostedEvent[] = [];
  let cursor: string | null = null;
  do {
    const page: { page: Doc<'projectWorkEvents'>[]; isDone: boolean; continueCursor: string } =
      await ctx.runQuery(internal.projectWork.events, {
        projectId: input.projectId,
        owner,
        initialRevision: previous.records.revision,
        revision: input.revision,
        paginationOpts: { cursor, numItems: 100, maximumBytesRead: 500000, maximumRowsRead: 100 },
      });
    for (const item of page.page)
      events.push(
        hostedEventSchema.parse({
          projectKey: project.key,
          archiveSha256: prior.digest,
          id: item.operationId,
          actor: item.actor,
          at: item.at,
          request: item.request,
          previousRevision: item.previousRevision,
          command: hostedCommandSchema.parse(JSON.parse(item.command)),
          ...(item.automatic ? { automatic: item.automatic } : {}),
        }),
      );
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  if (
    events.some(
      event =>
        event.command.action === 'put-planning-item' || event.command.action === 'comment-planning-item',
    )
  )
    return skip('planning-journal-events');
  const prepared = await prepareRecordReturn(
    previous.records,
    candidate.records,
    delta,
    events,
    candidate.manifest,
    input.revision,
    prior.digest,
    candidate.read,
    candidate.readMany,
  );
  if (!prepared) return skip('context-over-budget');
  const { context, validated } = prepared;
  const command = sourceReturnSchema.parse({
    action: 'source-return',
    archiveSha256: backup.digest,
    workSha256: candidate.records.work.sha256,
    previousArchiveSha256: prior.digest,
    previousRevision: input.revision,
  });
  const request = metadataRequest(command),
    at = priorAt ?? new Date().toISOString();
  invariant(
    !recordMap(candidate.records).has(recordIdentity('hostedEvents', input.operationId)),
    'INVALID_WORK_JOURNAL',
    'Source-return operation already appears in retained Work.',
  );
  context.current.hostedEvents.push(
    hostedEventSchema.parse({
      projectKey: project.key,
      archiveSha256: backup.digest,
      id: input.operationId,
      actor: owner,
      at,
      request,
      previousRevision: context.current.revision,
      command,
    }),
  );
  context.current.revision++;
  candidate.releaseBodies();
  previous.releaseBodies();
  const final = {
    projectId: input.projectId,
    owner,
    backupId: input.backupId,
    expectedBackupId: input.expectedBackupId,
    expectedRevision: input.revision,
    localRevision: candidate.manifest.revision,
    operationId: input.operationId,
    request,
    command: JSON.stringify(command),
    at,
    changes: [] as Awaited<ReturnType<typeof returnChanges>>,
  };
  const generation: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
    internal.projectWorkIndexStore.current,
    { projectId: input.projectId, owner },
  );
  console.log('work-record return prepared', {
    recordsValidated: validated.validated,
    recordsRead: context.recordsRead,
    revision: input.revision,
  });
  if (!generation) return skip('index-unavailable');
  if (generation.backupId !== input.expectedBackupId || generation.revision !== input.revision)
    return skip('index-changed');
  const snapshot = { data: context.current, manifest: candidate.manifest, backup };
  const beforeSnapshot = { data: context.previous, manifest: previous.manifest, backup: prior };
  const computationalCursor = recordReturnCursor(snapshot, beforeSnapshot, generation, final);
  input.ownerDerived ??= backup.ownerDerived;
  const ownerDerived = await readOwnerDerived(
    input.ownerDerived,
    async () => (await reader.read(input.projectId, owner, [input.ownerDerived!]))[0]!,
    pins => reader.read(input.projectId, owner, pins),
  );
  final.changes = await returnChanges(
    reader,
    input.projectId,
    owner,
    context.previous,
    context.current,
    candidate.manifest,
    ownerDerived as import('../src/owner-derived').OwnerDerived,
  );
  const partitionId = await ctx.runMutation(internal.projectReturnIndexStage.begin, {
    projectId: input.projectId,
    owner,
    generationId: generation._id,
    revision: input.revision,
    backupId: input.backupId,
    localRevision: candidate.manifest.revision,
    metadata: '{}',
    operationId: input.operationId,
    at,
    progress: true,
  });
  invariant(partitionId, 'WORK_STALE', 'Hosted Work changed during record-delta preparation.');
  const stage: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
    internal.projectReturnIndexStage.resume,
    {
      projectId: input.projectId,
      owner,
      backupId: input.backupId,
      revision: candidate.manifest.revision + 1,
      operationId: input.operationId,
    },
  );
  invariant(stage, 'WORK_STALE', 'Record-delta staging changed.');
  return {
    receipt: await returnProgress(
      ctx,
      stage,
      input,
      owner,
      {
        snapshot: { data: context.current, manifest: candidate.manifest, backup },
        previous: { data: context.previous, manifest: previous.manifest, backup: prior },
        final,
        generationId: generation._id,
        generation,
        ownerDerived,
        partial: true,
        metadataOnly: true,
        cursor: computationalCursor,
      },
      actionStarted,
    ),
  };
}
