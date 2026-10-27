// SPDX-License-Identifier: Apache-2.0
import { parseWork } from '../src/work-unified-types';
import { commandValues } from './projectWorkCommandRows';
import type { Doc } from './_generated/dataModel';
import { type HostedEvent, type WorkData } from '../src/work-types';
import { applyHostedEvent } from '../src/work-metadata';
import { indexedRecord, intentHeader, type IndexEntry, type IndexMetadata } from '../src/work-hosted-index';
import type { hostedAcceptance } from './projectAcceptance';

type Command = Exclude<HostedEvent['command'], { action: 'source-return' }>;
export function commandKeys(command: Command, input: { operationId: string }) {
  const keys: { collection: string; key: string }[] = [],
    add = (collection: string, key: string) => keys.push({ collection, key });
  add('events', input.operationId);
  if (command.action === 'intent') {
    add('intents', input.operationId);
    add('sourcePins', command.base);
    if (command.baseChannel) {
      add('channelMoves', command.baseChannel.acceptanceId);
      add('sourcePins', `refs/forge/channels/${command.baseChannel.name}:${command.base}`);
    }
    if (command.hostedBase) add('hostedChannels', command.hostedBase.name);
  } else if (command.action === 'note' || command.action === 'intent-status') {
    add('intents', command.intentId);
    add('intentAliases', command.intentId);
    if (command.action === 'note' && command.anchor) add('views', command.anchor.viewId);
  } else if (command.action === 'accept-hosted-channel') {
    if (command.acceptanceId) add('channelMoves', command.acceptanceId);
    add('views', command.viewId);
    add('hostedChannels', command.channel);
    add('sourcePins', command.head);
    if (command.acceptanceId)
      add('sourcePins', `refs/forge/channel-moves/${command.acceptanceId}:${command.head}`);
    add('sourcePins', `refs/forge/views/${command.viewId}:${command.head}`);
  } else {
    add('planningItems', command.itemId);
    add('intents', command.itemId);
    add('intentAliases', command.itemId);
    add('initiatives', command.itemId);
    add('planningVersions', command.operationId);
    add('planningComments', command.operationId);
    if (command.action === 'put-planning-item') {
      for (const id of command.intentIds) {
        add('intents', id);
        add('intentAliases', id);
      }
      if (command.initiativeId) {
        add('planningItems', command.initiativeId);
        add('initiatives', command.initiativeId);
      }
    }
  }
  return keys;
}
/** Alias lookups remain scoped to this command; original commands and hashes are unchanged. */
export async function commandAliasRows(
  rows: (IndexEntry | null)[],
  lookup: (collection: string, key: string) => Promise<IndexEntry | null>,
) {
  for (const row of [...rows]) {
    if (row?.collection !== 'intentAliases') continue;
    const alias = JSON.parse(row.value);
    if (!rows.some(item => item?.collection === 'intents' && item.key === alias.intentId))
      rows.push(await lookup('intents', alias.intentId));
  }
}
export function commandProjection(
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  backup: Doc<'projectBackups'>,
  input: { operationId: string; revision: number },
  owner: string,
  command: Command,
  request: string,
  rows: (IndexEntry | null)[],
  acceptance?: Awaited<ReturnType<typeof hostedAcceptance>>,
  retainedEvent?: HostedEvent,
) {
  const generationId = generation._id;
  const metadata = JSON.parse(generation.metadata) as IndexMetadata;
  const unique = [
    ...new Map(
      rows.filter((row): row is IndexEntry => !!row).map(row => [`${row.collection}:${row.key}`, row]),
    ).values(),
  ];
  const values = (collection: string) => commandValues(unique, collection);
  const data = parseWork(
    {
      schema: metadata.schema,
      ...(metadata.intentMergeReceipt ? { intentMergeReceipt: metadata.intentMergeReceipt } : {}),
      revision: input.revision,
      ...(metadata.sourceKind === 'native' ? { nativeHead: metadata.sourceHead } : {}),
      intents: [],
      lanes: [],
      views: [],
    },
    true,
  );
  // Reducer inputs include selected headers and required attributes; retained histories stay separate.
  data.intents = values('intents');
  Object.assign(data, { intentAliases: values('intentAliases'), initiatives: values('initiatives') });
  data.views = values('views');
  data.channelMoves = values('channelMoves');
  data.hostedChannelMoves = values('hostedChannels');
  data.hostedEvents = values('events');
  data.planningItems = [...values('planningVersions'), ...values('planningItems')];
  data.planningComments = values('planningComments');
  const at = retainedEvent?.at ?? new Date().toISOString(),
    event: HostedEvent = retainedEvent ?? {
      projectKey: project.key,
      archiveSha256: backup.digest,
      id: input.operationId,
      actor: owner,
      at,
      request,
      previousRevision: input.revision,
      command,
      ...(acceptance?.automatic ? { automatic: acceptance.automatic } : {}),
    };
  const targetId =
    'intentId' in command
      ? (values('intentAliases').find(alias => alias.aliasId === command.intentId)?.intentId ??
        command.intentId)
      : undefined;
  const oldIntent =
    command.action === 'note' || command.action === 'intent-status'
      ? JSON.parse(unique.find(row => row.collection === 'intents' && row.key === targetId)?.value ?? 'null')
      : null;
  const beforeIntents = new Map(data.intents.map(intent => [intent.id, JSON.stringify(intent)]));
  const beforeInitiatives = new Map(values('initiatives').map(item => [item.id, JSON.stringify(item)]));
  const beforePlanning = data.planningItems.length,
    beforeComments = data.planningComments.length;
  applyHostedEvent(data, event, oldIntent ? { noteIndex: oldIntent.noteCount ?? 0 } : {});
  const entries: IndexEntry[] = [],
    counts = { ...metadata.counts };
  function update(collection: string, key: string, parent: string, value: unknown, summary: unknown = value) {
    const old = unique.find(row => row.collection === collection && row.key === key),
      position = old?.position ?? counts[collection] ?? 0;
    entries.push(...indexedRecord(collection, key, parent, position, value, summary));
    if (!old) counts[collection] = position + 1;
  }
  function attributes(intent: WorkData['intents'][number]) {
    const value: Record<string, unknown> = {
      ...intent,
      notes: [],
      ...(intent.lifecycle ? { lifecycle: [] } : {}),
    };
    delete value.noteCount;
    delete value.lifecycleCount;
    return value;
  }
  if (command.action === 'intent')
    update(
      'intents',
      event.id,
      '',
      data.intents.find(intent => intent.id === event.id)!,
      intentHeader(data.intents.find(intent => intent.id === event.id)!),
    );
  else if (command.action === 'note' || command.action === 'intent-status') {
    const intent = data.intents.find(intent => intent.id === targetId)!;
    const header = {
      ...oldIntent,
      status: intent.status,
      ...(intent.lifecycle ? { lifecycle: [], lifecycleCount: oldIntent.lifecycleCount ?? 0 } : {}),
    };
    if (command.action === 'note') {
      header.noteCount = (oldIntent.noteCount ?? 0) + 1;
      update('notes', `${intent.id}:${oldIntent.noteCount ?? 0}`, intent.id, {
        ...intent.notes[0],
        intentId: intent.id,
        index: oldIntent.noteCount ?? 0,
      });
    } else if (intent.lifecycle?.length) {
      header.lifecycleCount = (oldIntent.lifecycleCount ?? 0) + 1;
      update('lifecycle', `${intent.id}:${oldIntent.lifecycleCount ?? 0}`, intent.id, {
        ...intent.lifecycle[0],
        intentId: intent.id,
        index: oldIntent.lifecycleCount ?? 0,
      });
    }
    if ([16, 18, 20, 22, 24].includes(data.schema))
      update('intents', intent.id, '', attributes(intent), header);
    else {
      // Legacy mutable status/counts leave original large payload chunks unchanged.
      const old = unique.find(row => row.collection === 'intents' && row.key === intent.id)!;
      entries.push({ ...old, status: intent.status, value: JSON.stringify(header) });
    }
  } else if (command.action === 'accept-hosted-channel') {
    const move = data.hostedChannelMoves!.at(-1)!;
    update('hostedChannelMoves', move.id, move.channel, move);
    update('hostedChannels', move.channel, '', move);
    update('viewAcceptances', move.id, move.viewId, {
      id: move.id,
      channel: move.channel,
      head: move.head,
      at: move.at,
      actor: move.actor,
    });
  } else {
    if (data.planningItems.length > beforePlanning) {
      const item = data.planningItems.at(-1)!;
      update('planningVersions', item.operationId, item.id, item);
      update('planningItems', item.id, '', item);
    }
    if (data.planningComments.length > beforeComments) {
      const comment = data.planningComments.at(-1)!;
      update('planningComments', comment.id, comment.itemId, comment);
    }
  }
  if (
    [16, 18, 20, 22, 24].includes(data.schema) &&
    (command.action === 'put-planning-item' || command.action === 'comment-planning-item')
  ) {
    for (const intent of data.intents)
      if (beforeIntents.get(intent.id) !== JSON.stringify(intent)) {
        const old = unique.find(row => row.collection === 'intents' && row.key === intent.id);
        const counts = old ? JSON.parse(old.value) : null;
        const lifecycleCount = counts?.lifecycleCount ?? 0;
        for (const [index, entry] of (intent.lifecycle ?? []).entries())
          update('lifecycle', `${intent.id}:${lifecycleCount + index}`, intent.id, {
            ...entry,
            intentId: intent.id,
            index: lifecycleCount + index,
          });
        update('intents', intent.id, '', attributes(intent), {
          ...intentHeader(intent),
          noteCount: counts?.noteCount ?? intent.notes.length,
          lifecycle: [],
          lifecycleCount: lifecycleCount + (intent.lifecycle?.length ?? 0),
        });
        const creator = (intent as Record<string, unknown>).creatorAccountId;
        if (typeof creator === 'string' && !beforeIntents.has(intent.id))
          update('intentAuthorities', `${intent.id}:${creator}`, intent.id, {
            intentId: intent.id,
            accountId: creator,
          });
      }
    for (const item of (data as WorkData & { initiatives: { id: string }[] }).initiatives)
      if (beforeInitiatives.get(item.id) !== JSON.stringify(item)) update('initiatives', item.id, '', item);
  }
  if (command.action === 'intent' && [16, 18, 20, 22, 24].includes(data.schema))
    update('intentAuthorities', `${event.id}:${owner}`, event.id, { intentId: event.id, accountId: owner });
  update('events', event.id, '', event);
  return {
    generationId,
    ...(acceptance ? { acceptance } : {}),
    metadata: JSON.stringify({ ...metadata, schema: data.schema, counts }),
    entries,
    at,
  };
}
