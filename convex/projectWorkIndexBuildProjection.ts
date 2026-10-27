// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  fields,
  family,
  rowsRef,
  lookupRef,
  type Selected,
  type Exchange,
  type Cursor,
} from './projectWorkIndexBuildTypes';
import { partialWork } from '../src/work-exchange-delta';
import { readRecord, type RecordPin } from '../src/work-exchange-records';
import { materializeWork, indexedRecord, type IndexEntry } from '../src/work-hosted-index';
import { workSourcePins } from '../src/work-archive-metadata';
import { invariant } from '../src/errors';
import type { WorkData, WorkView } from '../src/work-types';
import { journalEvent } from './projectWorkLoad';
import { metadataRequest } from '../src/work-metadata';
import { commandKeys, commandAliasRows, commandProjection } from './projectWorkProjection';
import { commandPayloadRows, commandPlanningRows } from './projectWorkCommandRows';
/** Only the selected View's dependency closure is hydrated. Unrelated records,
 * Intent conversations, run output and retained source remain outside memory. */
export async function viewContext(
  ctx: ActionCtx,
  selected: Selected,
  e: Exchange,
  view: WorkView,
  latestId: string,
) {
  const data = partialWork(e.records, [
    { collection: 'views', value: contextView(view) as unknown as Record<string, unknown> },
  ]);
  const catalogs = new Map(
    e.records.fields.flatMap(f => ('records' in f ? [[f.name, f.records] as const] : [])),
  );
  const seen = new Set([view.id]);
  for (let i = 0; i < data.views.length; i++) {
    const selected = data.views[i]!;
    for (const dep of selected.dependencies ?? [])
      if (dep.kind === 'view' && !seen.has(dep.viewId)) {
        seen.add(dep.viewId);
        const pin = catalogs.get('views')?.find(r => r.key === dep.viewId);
        if (pin)
          data.views.push(contextView((await readRecord(pin, e.read, 'views')) as unknown as WorkView));
      }
    for (const input of selected.inputs)
      if (!data.lanes.some(l => l.id === input.laneId)) {
        const pin = catalogs.get('lanes')?.find(r => r.key === input.laneId);
        if (pin)
          data.lanes.push((await readRecord(pin, e.read, 'lanes')) as unknown as WorkData['lanes'][number]);
      }
  }
  const intentIds = new Set([...data.views.map(v => v.intentId), ...data.lanes.map(l => l.intentId)]);
  for (const id of intentIds) {
    const pin = catalogs.get('intents')?.find(r => r.key === id);
    if (pin) {
      const value = await readRecord(pin, e.read, 'intents');
      data.intents.push({
        id: value.id,
        outcome: value.outcome,
        ...(value.testContracts ? { testContracts: value.testContracts } : {}),
      } as WorkData['intents'][number]);
    }
  }
  for (const [collection, scratch] of [
    ['channelMoves', '_buildLocalAcceptance'],
    ['hostedChannelMoves', '_buildHostedAcceptance'],
  ] as const) {
    let offset = 0;
    while (true) {
      const rows = await ctx.runQuery(rowsRef, { ...selected, collection: scratch, parent: view.id, offset });
      for (const row of rows) {
        let value = JSON.parse(row.value);
        if (value.payloadKey) {
          const parts: string[] = [];
          for (let part = 0; part < value.payloadParts; part++) {
            const chunk = await ctx.runQuery(lookupRef, {
              ...selected,
              collection: `${scratch}:payload`,
              key: `${value.payloadKey}:${part}`,
            });
            invariant(chunk, 'WORK_STALE', 'The staged acceptance payload changed.');
            parts.push(chunk.value);
          }
          value = JSON.parse(parts.join(''));
        }
        data[collection]!.push(value);
      }
      if (rows.length < 100) break;
      offset = rows.at(-1)!.position + 1;
    }
  }
  const latestPin = catalogs.get('views')?.find(r => r.key === latestId);
  // Selection stays at index zero. Repeat the actual latest family header at
  // the end so dependency traversal order cannot reverse supersession.
  data.views.push(
    latestId === view.id
      ? contextView(view)
      : latestPin
        ? contextView((await readRecord(latestPin, e.read, 'views')) as unknown as WorkView)
        : contextView(view),
  );
  return data;
}
export function contextView(view: WorkView): WorkView {
  const { id, intentId, base, head, inputs, dependencies, status, at, composedMain } = view;
  return {
    id,
    intentId,
    base,
    head,
    inputs,
    dependencies,
    status,
    at,
    composedMain,
    details: '',
  } as WorkView;
}

export async function projectRecord(
  e: Exchange,
  field: string,
  value: Record<string, unknown>,
  position: number,
  pinMap: Map<string, { sha256: string; size: number }>,
): Promise<IndexEntry[]> {
  const rawFields = e.records.fields.filter((f): f is typeof f & { records: RecordPin[] } => 'records' in f);
  const read = (pin: RecordPin, collection: string) => readRecord(pin, e.read, collection);
  const data = partialWork(e.records, [{ collection: field, value }]);
  // This projection owns one raw record. Native dependency validation belongs
  // to the complete seeded checkpoint, not this deliberately partial context.
  const projectionData = { ...data };
  delete projectionData.nativeHead;
  const projection = materializeWork(
    projectionData,
    { ...e.manifest, files: [] },
    [],
    'objects',
    new Map(),
    true,
  );
  const allowed = new Set(fields[field] ?? []);
  const result = projection.entries.filter(row => allowed.has(row.collection.replace(/:payload$/, '')));
  for (const head of workSourcePins(projectionData))
    if (pinMap.has(head)) {
      result.push(...indexedRecord('sourcePins', head, '', 0, { key: head, head }));
      result.push(...indexedRecord('_buildSource', head, '', 0, { head }));
    }
  if (field === 'views') {
    const view = value as unknown as WorkView;
    result.push(...indexedRecord('_buildFamily', view.id, family(view), position, { id: view.id }));
  }
  if (field === 'landingEntries' && typeof value.viewId === 'string') {
    const viewPin = rawFields.find(f => f.name === 'views')?.records.find(r => r.key === value.viewId);
    if (viewPin) {
      const view = (await read(viewPin, 'views')) as unknown as WorkView;
      for (const input of view.inputs)
        result.push(
          ...indexedRecord('_buildSubmission', `${String(value.id)}:${input.laneId}`, input.laneId, 0, {
            head: input.head,
          }),
        );
    }
  }
  if ((field === 'channelMoves' && value.status === 'accepted') || field === 'hostedChannelMoves')
    result.push(
      ...indexedRecord(
        field === 'channelMoves' ? '_buildLocalAcceptance' : '_buildHostedAcceptance',
        String(value.id),
        String(value.viewId),
        0,
        value,
      ),
    );
  if (field === 'channelMoves' && value.status === 'accepted' && pinMap.has(String(value.head)))
    result.push(
      ...indexedRecord('channels', String(value.channel), '', 0, { name: value.channel, head: value.head }),
    );
  if (field === 'hostedChannelMoves')
    result.push(...indexedRecord('hostedChannels', String(value.channel), '', 0, value));
  return result;
}

export async function replayStep(
  ctx: ActionCtx,
  selected: Selected,
  e: Exchange,
  backup: Doc<'projectBackups'>,
  generation: Doc<'projectWorkGenerations'>,
  project: Doc<'hostedProjects'>,
  c: Cursor,
): Promise<{ entries: IndexEntry[]; metadata?: string }> {
  const page: { page: Doc<'projectWorkEvents'>[]; isDone: boolean; continueCursor: string } =
    await ctx.runQuery(internal.projectWork.events, {
      projectId: selected.projectId,
      owner: selected.owner,
      initialRevision: project.work!.initialRevision,
      revision: project.work!.revision,
      paginationOpts: {
        cursor: c.journalCursor ?? null,
        numItems: 1,
        maximumBytesRead: 500000,
        maximumRowsRead: 1,
      },
    });
  const row = page.page[0];
  if (!row) {
    invariant(
      c.replayRevision === project.work!.revision,
      'INVALID_WORK_JOURNAL',
      'Hosted Work operation coverage is incomplete.',
    );
    c.phase = 'cleanup';
    c.cleanup = 0;
    return { entries: [] };
  }
  const event = journalEvent(project.key, backup.digest, row);
  invariant(
    event.request === metadataRequest(event.command),
    'INVALID_WORK_JOURNAL',
    'The retained journal request differs from its command.',
  );
  invariant(
    event.previousRevision === c.replayRevision,
    'INVALID_WORK_JOURNAL',
    'Resume the exact journal revision.',
  );
  c.replayRevision = event.previousRevision + 1;
  c.journalCursor = page.continueCursor;
  if (page.isDone) {
    invariant(
      c.replayRevision === project.work!.revision,
      'INVALID_WORK_JOURNAL',
      'Hosted Work operation coverage is incomplete.',
    );
    c.phase = 'cleanup';
    c.cleanup = 0;
  }
  if (event.command.action === 'source-return') {
    invariant(
      event.command.workSha256 === e.records.work.sha256 && event.command.archiveSha256 === backup.digest,
      'INVALID_WORK_JOURNAL',
      'Returned source differs from its pinned record checkpoint.',
    );
    const duplicate = await ctx.runQuery(lookupRef, { ...selected, collection: 'events', key: event.id });
    invariant(
      !duplicate,
      'INVALID_WORK_JOURNAL',
      'The returned source event is already present in its base.',
    );
    return {
      entries: indexedRecord('events', event.id, '', 0, event),
      ...(event.automatic && JSON.parse(generation.metadata).schema < 16
        ? { metadata: JSON.stringify({ ...JSON.parse(generation.metadata), schema: 11 }) }
        : {}),
    };
  }
  const lookup = (collection: string, key: string) =>
    ctx.runQuery(lookupRef, { ...selected, collection, key });
  const rows = await Promise.all(
    commandKeys(event.command, { operationId: event.id }).map(key => lookup(key.collection, key.key)),
  );
  await commandAliasRows(rows, lookup);
  const batchLookup = (keys: { collection: string; key: string }[]) =>
    Promise.all(keys.map(key => lookup(key.collection, key.key)));
  if ([16, 18, 20].includes(JSON.parse(generation.metadata).schema)) {
    await commandPayloadRows(rows, batchLookup);
    await commandPlanningRows(rows, event.command, batchLookup);
  }
  const projection = commandProjection(
    project,
    { ...generation, revision: event.previousRevision },
    backup,
    { operationId: event.id, revision: event.previousRevision },
    event.actor,
    event.command,
    event.request,
    rows,
    undefined,
    event,
  );
  return { entries: projection.entries, metadata: projection.metadata };
}
