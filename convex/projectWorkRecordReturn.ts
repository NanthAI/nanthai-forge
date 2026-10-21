// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import type { ExchangeObjectReader } from './projectExchangeReader';
import { recordExchange } from './projectWorkRecordExchange';
import { workDeltaContext } from '../src/work-exchange-context';
import { recordBytes, recordIdentity, recordMap } from '../src/work-exchange-records';
import {
  validateWorkDelta,
  validateChangedRecords,
  channelMetadataChanges,
  supportsWorkDelta,
  WORK_DELTA_BYTES,
} from '../src/work-exchange-delta';
import { applyHostedEvent, metadataRequest, parseWorkBytes } from '../src/work-metadata';
import {
  hostedCommandSchema,
  hostedEventSchema,
  sourceReturnSchema,
  type HostedEvent,
} from '../src/work-types';
import { validateSourceReturn } from '../src/work-source-return';
import { invariant } from '../src/errors';
import { digest } from '../src/hash';
import { returnChanges } from './coordinationReturnChanges';
import { returnProgress } from './projectSourceReturnProgress';
import { readOwnerDerived } from './projectOwnerDerived';
type Input = {
  projectId: Id<'hostedProjects'>;
  backupId: Id<'projectBackups'>;
  expectedBackupId: Id<'projectBackups'>;
  revision: number;
  operationId: string;
  ownerDerived?: { sha256: string; size: number };
};
// Legacy source-return events hash parsed Work. A catalog with a different
// top-level order or absent defaults needs that complete compatibility path;
// its exact portable digest cannot stand in for the journal's parsed digest.
function preservesParsedWorkBytes(root: NonNullable<Awaited<ReturnType<typeof recordExchange>>>['records']) {
  const skeleton = Object.fromEntries(
    root.fields.map(field => [field.name, 'records' in field ? [] : field.value]),
  );
  const parsed = parseWorkBytes(Buffer.from(JSON.stringify(skeleton)));
  return JSON.stringify(Object.keys(parsed)) === JSON.stringify(root.fields.map(field => field.name));
}
export async function recordReturn(
  ctx: ActionCtx,
  input: Input,
  owner: string,
  reader: ExchangeObjectReader,
  backup: Doc<'projectBackups'>,
  prior: Doc<'projectBackups'>,
  priorAt?: string,
) {
  const skip = (reason: string) => {
    console.log('source-return record skip', { reason, revision: input.revision });
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
  const candidate = await recordExchange(backup, owner, reader),
    previous = await recordExchange(prior, owner, reader);
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
  const extra: string[] = [];
  for (const event of events) {
    const command = event.command;
    if ('intentId' in command) extra.push(recordIdentity('intents', command.intentId));
    if ('anchor' in command && command.anchor) extra.push(recordIdentity('views', command.anchor.viewId));
    if (command.action === 'accept-hosted-channel')
      for (const field of previous.records.fields)
        if (field.name === 'hostedChannelMoves' && 'records' in field)
          for (const record of field.records) extra.push(recordIdentity(field.name, record.key));
  }
  const metadataOnly = await channelMetadataChanges(
    previous.records,
    candidate.records,
    delta.changes,
    candidate.read,
  );
  const context = await workDeltaContext(
    previous.records,
    candidate.records,
    delta,
    candidate.read,
    extra,
    metadataOnly,
  );
  if (!context) return skip('context-over-budget');
  const pins = new Set(
    candidate.manifest.files.filter(pin => pin.path === `objects/${pin.sha256}`).map(pin => pin.sha256),
  );
  const validated = await validateChangedRecords(
    previous.records,
    candidate.records,
    delta.changes,
    candidate.read,
    pins,
    metadataOnly,
  );
  // Authenticate the complete hosted history by ordered hashes without loading it.
  const oldEvents = previous.records.fields.find(f => f.name === 'hostedEvents'),
    nextEvents = candidate.records.fields.find(f => f.name === 'hostedEvents');
  const expected = oldEvents && 'records' in oldEvents ? oldEvents.records.map(r => [r.key, r.sha256]) : [];
  for (const event of events) {
    invariant(
      event.previousRevision === context.previous.revision &&
        metadataRequest(event.command) === event.request,
      'INVALID_WORK_JOURNAL',
      'Hosted record journal is not contiguous.',
    );
    expected.push([event.id, digest(recordBytes(event))]);
    if (event.command.action === 'source-return') {
      invariant(
        event.command.workSha256 === previous.records.work.sha256 &&
          event.command.archiveSha256 === prior.digest,
        'INVALID_WORK_JOURNAL',
        'Hosted source-return event differs from its original Work pin.',
      );
      context.previous.hostedEvents.push(event);
      context.previous.revision++;
    } else {
      // Prefix identity was checked against immutable record descriptors above.
      context.previous.hostedEvents = context.previous.hostedEvents.filter(e => e.id !== event.id);
      applyHostedEvent(context.previous, event);
    }
  }
  invariant(
    context.previous.revision === input.revision &&
      nextEvents &&
      'records' in nextEvents &&
      expected.every(
        ([id, sha], i) => nextEvents.records[i]?.key === id && nextEvents.records[i]?.sha256 === sha,
      ),
    'INVALID_WORK_JOURNAL',
    'Returned record delta omits or rewrites hosted history.',
  );
  const oldMoves = previous.records.fields.find(f => f.name === 'hostedChannelMoves'),
    nextMoves = candidate.records.fields.find(f => f.name === 'hostedChannelMoves');
  const expectedMoves = new Map(
    oldMoves && 'records' in oldMoves ? oldMoves.records.map(r => [r.key, r.sha256]) : [],
  );
  for (const move of context.previous.hostedChannelMoves ?? [])
    expectedMoves.set(move.id, digest(recordBytes(move)));
  invariant(
    (nextMoves && 'records' in nextMoves ? nextMoves.records.length : 0) === expectedMoves.size &&
      (!nextMoves ||
        !('records' in nextMoves) ||
        nextMoves.records.every(r => expectedMoves.get(r.key) === r.sha256)),
    'INVALID_WORK_JOURNAL',
    'Returned record delta changes hosted Channel receipts.',
  );
  validateSourceReturn(
    { ...context.previous, hostedEvents: [], hostedChannelMoves: [] },
    { ...context.current, hostedEvents: [], hostedChannelMoves: [] },
    candidate.manifest,
  );
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
  input.ownerDerived ??= backup.ownerDerived;
  const ownerDerived = await readOwnerDerived(
    input.ownerDerived,
    async () => (await reader.read(input.projectId, owner, [input.ownerDerived!]))[0]!,
    pins => reader.read(input.projectId, owner, pins),
  );
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
    changes: await returnChanges(
      reader,
      input.projectId,
      owner,
      context.previous,
      context.current,
      candidate.manifest,
      ownerDerived as import('../src/owner-derived').OwnerDerived,
    ),
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
    receipt: await returnProgress(ctx, stage, input, owner, {
      snapshot: { data: context.current, manifest: candidate.manifest, backup },
      previous: { data: context.previous, manifest: previous.manifest, backup: prior },
      final,
      generationId: generation._id,
      generation,
      ownerDerived,
      partial: true,
      metadataOnly: true,
    }),
  };
}
