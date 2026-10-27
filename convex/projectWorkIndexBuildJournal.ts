// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { type Selected, type Exchange, type Cursor } from './projectWorkIndexBuildTypes';
import { indexedRecord, type IndexEntry } from '../src/work-hosted-index';
import { journalEvent } from './projectWorkLoad';
import { metadataRequest } from '../src/work-metadata';
import { buildLookups } from './projectWorkIndexBuildLookup';
import { invariant } from '../src/errors';
import { commandKeys, commandAliasRows, commandProjection } from './projectWorkProjection';
import { commandPayloadRows, commandPlanningRows } from './projectWorkCommandRows';
/** Ordered reducers share one bounded event page and exact-key lookup windows.
 * Overlay reads see preceding events before rows and continuation commit together. */
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
        numItems: 50,
        maximumBytesRead: 500000,
        maximumRowsRead: 50,
      },
    });
  const events = page.page.map(row => journalEvent(project.key, backup.digest, row));
  type Key = { collection: string; key: string };
  const identity = (key: Key) => JSON.stringify([key.collection, key.key]);
  const cache = new Map<string, IndexEntry | null>();
  const entries = new Map<string, IndexEntry>();
  const lookup = async (keys: Key[]) => {
    const missing = [
      ...new Map(keys.filter(key => !cache.has(identity(key))).map(key => [identity(key), key])).values(),
    ];
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100);
      const rows = await buildLookups(ctx, selected, batch);
      batch.forEach((key, i) => cache.set(identity(key), rows[i]!));
    }
    return keys.map(key => cache.get(identity(key))!);
  };
  await lookup(
    events.flatMap(event =>
      event.command.action === 'source-return'
        ? [{ collection: 'events', key: event.id }]
        : commandKeys(event.command, { operationId: event.id }),
    ),
  );
  await lookup(
    [...cache.values()].flatMap(row =>
      row?.collection === 'intentAliases'
        ? [{ collection: 'intents', key: String(JSON.parse(row.value).intentId) }]
        : [],
    ),
  );
  let metadata = generation.metadata;
  for (const event of events) {
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
    let projected: IndexEntry[];
    if (event.command.action === 'source-return') {
      invariant(
        event.command.workSha256 === e.records.work.sha256 && event.command.archiveSha256 === backup.digest,
        'INVALID_WORK_JOURNAL',
        'Returned source differs from its pinned record checkpoint.',
      );
      const [duplicate] = await lookup([{ collection: 'events', key: event.id }]);
      invariant(
        !duplicate,
        'INVALID_WORK_JOURNAL',
        'The returned source event is already present in its base.',
      );
      projected = indexedRecord('events', event.id, '', 0, event);
      if (event.automatic && JSON.parse(metadata).schema < 16)
        metadata = JSON.stringify({ ...JSON.parse(metadata), schema: 11 });
    } else {
      const rows = await lookup(commandKeys(event.command, { operationId: event.id }));
      await commandAliasRows(rows, async (collection, key) => (await lookup([{ collection, key }]))[0]!);
      if ([16, 18, 20].includes(JSON.parse(metadata).schema)) {
        await commandPayloadRows(rows, lookup);
        await commandPlanningRows(rows, event.command, lookup);
      }
      const projection = commandProjection(
        project,
        { ...generation, metadata, revision: event.previousRevision },
        backup,
        { operationId: event.id, revision: event.previousRevision },
        event.actor,
        event.command,
        event.request,
        rows,
        undefined,
        event,
      );
      projected = projection.entries;
      metadata = projection.metadata;
    }
    for (const row of projected) {
      entries.set(identity(row), row);
      cache.set(identity(row), row);
      // Derived hydrated attributes from an earlier event must not mask new payloads.
      cache.delete(identity({ collection: `${row.collection}:attributes`, key: row.key }));
    }
    c.replayRevision = event.previousRevision + 1;
  }
  c.journalCursor = page.continueCursor;
  if (page.isDone || !events.length) {
    invariant(
      c.replayRevision === project.work!.revision,
      'INVALID_WORK_JOURNAL',
      'Hosted Work operation coverage is incomplete.',
    );
    c.phase = 'cleanup';
    c.cleanup = 0;
  }
  return { entries: [...entries.values()], metadata };
}
