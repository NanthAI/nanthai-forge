// SPDX-License-Identifier: Apache-2.0
import { handoffSummary, latestHandoff } from './agent-handoff-types.js';
import { sourceTreeEntries } from './source-tree-index.js';
import { stateParentEntries } from './source-state-parent-index.js';
import { viewReadModels } from './view-read-model.js';
import { viewIndexEntries } from './view-hosted-index.js';
import type { ProvenanceFile } from './view-provenance-plan.js';
import { hostedAncestry } from './work-hosted-ancestry.js';
import { digest } from './portable-hash.js';
import { laneSummary, viewSummary, runSummary } from './work-hosted-summary.js';
import type { WorkData, HostedEvent } from './work-types.js';
import { archiveSource, archiveChannels, type sourceManifestSchema } from './work-archive-metadata.js';
import { currentPlanning } from './work-planning-state.js';
import { hostedChannels } from './work-metadata.js';
import type { z } from 'zod';
export type IndexEntry = {
  activityAt?: number;
  actor?: string;
  status?: string;
  collection: string;
  key: string;
  parent: string;
  position: number;
  value: string;
};
export type IndexMetadata = {
  schema: WorkData['schema'];
  intentMergeReceipt?: unknown;
  sourceHead: string;
  sourceKind: 'native' | 'git';
  counts: Record<string, number>;
  /** Changes only with immutable owner records; older indexes omit it. */
  decisionVersion?: string;
  defaultIntentId?: string | undefined;
  initialRevision: number;
  sourceTransport?: 'objects';
};
export function activityFields(collection: string, value: unknown): { activityAt?: number } {
  const row = value as { lastCheckpointAt?: string; startedAt?: string; endedAt?: string };
  const at =
    collection === 'lanes'
      ? Date.parse(row.lastCheckpointAt ?? '')
      : collection === 'runs'
        ? Math.max(Date.parse(row.startedAt ?? ''), Date.parse(row.endedAt ?? row.startedAt ?? ''))
        : NaN;
  return Number.isFinite(at) ? { activityAt: at } : {};
}
export function indexActivity(entry: Pick<IndexEntry, 'collection' | 'value'>) {
  return entry.collection === 'lanes' || entry.collection === 'runs'
    ? { activityAt: activityFields(entry.collection, JSON.parse(entry.value)).activityAt }
    : {};
}
const json = (value: unknown) => JSON.stringify(value);
export function intentHeader(intent: WorkData['intents'][number]) {
  const { id, outcome, constraints, base, status, createdAt, baseChannel, hostedBase } = intent;
  return {
    id,
    outcome,
    constraints,
    base,
    status,
    createdAt,
    ...Object.fromEntries(
      Object.entries(intent).filter(([key]) => ['creatorAccountId', 'assigneeAccountIds'].includes(key)),
    ),
    ...(baseChannel ? { baseChannel } : {}),
    ...(hostedBase ? { hostedBase } : {}),
    notes: [],
    handoffs: [...new Set(intent.notes.flatMap(note => (note.handoff ? [note.handoff.laneId] : [])))].flatMap(
      laneId => {
        const summary = handoffSummary(latestHandoff(intent.notes, laneId));
        return summary ? [summary] : [];
      },
    ),
    noteCount: intent.notes.length,
    ...(intent.lifecycle ? { lifecycle: [], lifecycleCount: intent.lifecycle.length } : {}),
  };
}
/** Payload chunks preserve large/unknown attributes without putting them in reactive summaries. */
export function indexedRecord(
  collection: string,
  key: string,
  parent: string,
  position: number,
  value: unknown,
  summary: unknown = value,
): IndexEntry[] {
  const payload = json(value),
    header = json(summary),
    entries: IndexEntry[] = [
      {
        ...activityFields(collection, summary),
        collection,
        key,
        parent,
        position,
        value: header,
        ...(typeof (summary as { actor?: unknown })?.actor === 'string' &&
        (summary as { actor: string }).actor.length <= 200
          ? { actor: (summary as { actor: string }).actor }
          : {}),
        ...(collection === 'intents' ? { status: (summary as { status: string }).status } : {}),
      },
    ];
  const sameFields =
    value !== null &&
    summary !== null &&
    typeof value === 'object' &&
    typeof summary === 'object' &&
    Object.keys(value).length === Object.keys(summary).length &&
    Object.entries(value).every(
      ([key, field]) => JSON.stringify(field) === JSON.stringify((summary as Record<string, unknown>)[key]),
    );
  const reserved =
    typeof value === 'object' &&
    value !== null &&
    ['payload', 'payloadKey', 'payloadParts'].some(key => Object.hasOwn(value, key));
  if (reserved || (header !== payload && !sameFields) || payload.length > 32000) {
    if (header.length > 32000) {
      const object =
        typeof summary === 'object' && summary !== null ? (summary as Record<string, unknown>) : {};
      const keys = [
        'id',
        'operationId',
        'request',
        'version',
        'previousVersion',
        'kind',
        'outcome',
        'constraints',
        'noteCount',
        'lifecycleCount',
        'title',
        'body',
        'text',
        'authorLabel',
        'status',
        'at',
        'createdAt',
        'provenance',
        'itemId',
        'initiativeId',
        'intentId',
        'viewId',
        'channel',
        'head',
        'base',
        'name',
        'acceptanceId',
        'previousId',
        'archiveSha256',
        'actor',
        'projectKey',
      ];
      const small = Object.fromEntries(
        keys
          .filter(name => Object.hasOwn(object, name))
          .map(name => {
            const value = object[name];
            return [
              name,
              typeof value === 'string'
                ? value.length > 8000
                  ? ''
                  : value
                : typeof value === 'number' || typeof value === 'boolean' || value === null
                  ? value
                  : null,
            ];
          }),
      );
      entries[0]!.value = json({
        ...small,
        id: key,
        payload: true,
        ...(collection === 'intents'
          ? {
              notes: [],
              noteCount: object.noteCount ?? 0,
              ...(Object.hasOwn(object, 'lifecycle')
                ? { lifecycle: [], lifecycleCount: object.lifecycleCount ?? 0 }
                : {}),
            }
          : {}),
      });
    }
    const payloadKey = `${key}:${digest(payload)}`,
      chunks: string[] = [];
    for (let offset = 0; offset < payload.length;) {
      let end = Math.min(offset + 32000, payload.length);
      if (end < payload.length && /[\uD800-\uDBFF]/.test(payload[end - 1]!)) end--;
      chunks.push(payload.slice(offset, end));
      offset = end;
    }
    entries[0]!.value = json({ ...JSON.parse(entries[0]!.value), payloadKey, payloadParts: chunks.length });
    chunks.forEach((value, part) =>
      entries.push({
        collection: `${collection}:payload`,
        key: `${payloadKey}:${part}`,
        parent: payloadKey,
        position: part,
        value,
      }),
    );
  }
  return entries;
}
export function* workIndexRows(
  data: WorkData,
  manifest: z.infer<typeof sourceManifestSchema>,
  _events: HostedEvent[],
  sourceTransport?: 'objects',
  sourceParents: ReadonlyMap<string, readonly string[]> & {
    files?: ReadonlyMap<string, readonly ProvenanceFile[]>;
  } = new Map(),
  deferDerived = false,
  omitIntentRows = false,
) {
  const counts: Record<string, number> = {};
  const channels = archiveChannels(manifest, data),
    hosted = hostedChannels(data);
  const mainHead =
    hosted.find(c => c.channel === 'main')?.head ?? channels.find(c => c.name === 'main')?.head ?? null;
  const ancestry = hostedAncestry(data, sourceParents, { defer: deferDerived });
  const mainSummary = (head?: string) => ancestry.main(head, mainHead);
  function* add<T>(
    collection: string,
    values: T[],
    key: (value: T, index: number) => string,
    parent: (value: T) => string = () => '',
    summary?: (value: T) => unknown,
  ) {
    counts[collection] = values.length;
    for (const [index, value] of values.entries())
      yield* indexedRecord(
        collection,
        key(value, index),
        parent(value),
        index,
        value,
        summary?.(value) ?? value,
      );
  }
  counts.intents = data.intents.length;
  for (const [position, intent] of (omitIntentRows ? [] : data.intents).entries()) {
    const header = intentHeader(intent),
      attributes = { ...intent, notes: [], ...(intent.lifecycle ? { lifecycle: [] } : {}) };
    const hasExtraAttributes = Object.keys(attributes).some(key => !Object.hasOwn(header, key));
    yield* indexedRecord(
      'intents',
      intent.id,
      '',
      position,
      hasExtraAttributes ? attributes : header,
      header,
    );
  }
  yield* add(
    'landingEntries',
    data.landingEntries ?? [],
    value => value.id,
    value => value.channel,
  );
  yield* add(
    'landingBatches',
    data.landingBatches ?? [],
    value => value.id,
    value => value.channel,
  );
  const unified = data as WorkData & {
    initiatives?: { id: string }[];
    intentAliases?: { aliasId: string; intentId: string }[];
  };
  yield* add('initiatives', unified.initiatives ?? [], value => value.id);
  yield* add('intentAliases', unified.intentAliases ?? [], value => value.aliasId);
  yield* add(
    'intentAuthorities',
    (omitIntentRows ? [] : data.intents).flatMap(intent => {
      const accounts = intent as typeof intent & { creatorAccountId?: string; assigneeAccountIds?: string[] };
      return [
        ...new Set([
          ...(accounts.creatorAccountId ? [accounts.creatorAccountId] : []),
          ...(accounts.assigneeAccountIds ?? []),
        ]),
      ].map(accountId => ({ intentId: intent.id, accountId }));
    }),
    value => `${value.intentId}:${value.accountId}`,
    value => value.intentId,
  );
  yield* add('automaticActions', data.automaticActions ?? [], value => value.id);
  yield* add('policyChanges', data.policyChanges ?? [], value => value.id);
  yield* add(
    'decisions',
    data.decisions ?? [],
    value => value.id,
    value => (value.target.kind === 'intent' ? value.target.intentId : ''),
  );
  yield* add(
    'checkpoints',
    data.lanes.flatMap(lane =>
      lane.checkpoints.map((checkpoint, index) => ({ ...checkpoint, laneId: lane.id, index })),
    ),
    value => `${value.laneId}:${value.index}`,
    value => value.laneId,
  );
  yield* add(
    'lanes',
    data.lanes,
    v => v.id,
    v => v.intentId,
    v =>
      laneSummary(
        v,
        ancestry.lane(v.head, mainHead),
        (data.landingEntries ?? []).flatMap(
          entry =>
            data.views
              .find(view => view.id === entry.viewId)
              ?.inputs.filter(pin => pin.laneId === v.id)
              .map(pin => pin.head) ?? [],
        ),
      ),
  );
  const viewModels = new Map(viewReadModels(data).map(view => [view.viewId, view]));
  yield* add(
    'views',
    data.views,
    v => v.id,
    v => v.intentId,
    v => ({
      ...viewSummary(v, mainSummary(v.head)),
      viewStatus: viewModels.get(v.id)!.status,
      supersededBy: viewModels.get(v.id)!.supersededBy,
      inputs: viewModels.get(v.id)!.inputs,
    }),
  );
  yield* add(
    'checks',
    data.checks,
    v => v.id,
    () => '',
    v => ({ id: v.id, name: v.name, definition: v.definition }),
  );
  yield* add(
    'runs',
    data.runs,
    v => v.id,
    v => v.viewId,
    v => runSummary(v, mainSummary(v.head)),
  );
  yield* add('planningItems', currentPlanning(data), v => v.id);
  yield* add(
    'planningVersions',
    data.planningItems,
    v => v.operationId,
    v => v.id,
  );
  yield* add(
    'planningComments',
    data.planningComments,
    v => v.id,
    v => v.itemId,
  );
  yield* add(
    'channelMoves',
    data.channelMoves,
    v => v.id,
    v => v.channel,
  );
  yield* add(
    'hostedChannelMoves',
    data.hostedChannelMoves ?? [],
    v => v.id,
    v => v.channel,
  );
  yield* add('hostedChannels', hosted, v => v.channel);
  yield* add('channels', channels, v => v.name);
  yield* add('githubAutoPush', data.githubAutoPush ? [data.githubAutoPush] : [], v => v.id);
  yield* add(
    'githubSync',
    data.githubSync ? [{ id: 'github', ...data.githubSync }] : [],
    v => v.id,
    () => '',
    binding => {
      const last = binding.commits[binding.pushed - 1];
      return {
        id: binding.id,
        repository: binding.repository,
        branch: binding.branch,
        adoptedCommit: binding.adoptedCommit,
        commits: last ? [last] : [],
        pushed: last ? 1 : 0,
        ...(binding.pushedAt ? { pushedAt: binding.pushedAt } : {}),
      };
    },
  );
  yield* add(
    'githubRepositories',
    [
      ...new Set(
        (omitIntentRows ? [] : data.intents).flatMap(intent =>
          intent.external ? [intent.external.repository] : [],
        ),
      ),
    ].map(repository => ({ id: repository, repository })),
    v => v.id,
  );
  // Imported and later hosted history remain addressable; the original event table is authoritative.
  yield* add('events', data.hostedEvents, v => v.id);
  const notes = (omitIntentRows ? [] : data.intents).flatMap(intent =>
    intent.notes.map((note, index) => ({ ...note, intentId: intent.id, index })),
  );
  yield* add(
    'notes',
    notes,
    v => `${v.intentId}:${v.index}`,
    v => v.intentId,
  );
  const lifecycle = (omitIntentRows ? [] : data.intents).flatMap(intent =>
    (intent.lifecycle ?? []).map((entry, index) => ({ ...entry, intentId: intent.id, index })),
  );
  yield* add(
    'lifecycle',
    lifecycle,
    v => `${v.intentId}:${v.index}`,
    v => v.intentId,
  );
  const source = archiveSource(manifest, data);
  const pins =
    'states' in source
      ? source.states.map(head => ({ key: head, head }))
      : [
          { key: source.head, head: source.head },
          ...source.refs.flatMap(pin => [
            { key: pin.head, head: pin.head },
            { key: `${pin.ref}:${pin.head}`, head: pin.head },
          ]),
        ];
  yield* add('sourcePins', [...new Map(pins.map(pin => [pin.key, pin])).values()], v => v.key);
  yield* add(
    'sourceAncestry',
    ancestry.pairs,
    v => v.key,
    v => v.head,
  );
  yield* add('sourceAncestryHeads', ancestry.complete, v => v.head);
  if (manifest.kind === 'forge-native-work-backup') {
    let chunks = 0;
    for (const [head, parents] of sourceParents) {
      const rows = stateParentEntries(head, parents);
      yield* rows;
      chunks += rows.length - 1;
    }
    counts.sourceStateParents = sourceParents.size;
    counts.sourceStateParentChunks = chunks;
  }
  const derived = deferDerived ? [] : viewIndexEntries(data, sourceParents.files);
  yield* derived;
  for (const name of ['viewDetails', 'viewFiles', 'laneViews', 'viewAcceptances'])
    counts[name] = derived.filter(entry => entry.collection === name).length;
  yield* add(
    'sourceBlobs',
    manifest.files
      .filter(file => /^objects\/[a-f0-9]{64}$/.test(file.path))
      .map(file => ({ sha256: file.sha256, size: file.size })),
    file => file.sha256,
  );
  if (manifest.kind === 'forge-native-work-backup' && sourceParents.files) {
    const heads = new Set([
      manifest.head,
      channels.find(c => c.name === 'main')?.head,
      hosted.find(c => c.channel === 'main')?.head,
    ]);
    for (const head of heads) {
      const files = head && sourceParents.files.get(head);
      if (head && files) yield* sourceTreeEntries(head, files);
    }
  }
  const metadata: IndexMetadata = {
    schema: data.schema,
    ...((data as Record<string, unknown>).intentMergeReceipt
      ? { intentMergeReceipt: (data as Record<string, unknown>).intentMergeReceipt }
      : {}),
    sourceHead: manifest.head,
    sourceKind: manifest.kind === 'forge-native-work-backup' ? 'native' : 'git',
    counts,
    ...(data.decisions ? { decisionVersion: digest(json(data.decisions)) } : {}),
    defaultIntentId:
      [...data.intents].reverse().find(intent => intent.status === 'active')?.id ?? data.intents.at(-1)?.id,
    initialRevision: manifest.revision,
    ...(sourceTransport ? { sourceTransport } : {}),
  };
  return metadata;
}
export function materializeWork(...args: Parameters<typeof workIndexRows>) {
  const entries: IndexEntry[] = [],
    rows = workIndexRows(...args);
  let next = rows.next();
  while (!next.done) {
    entries.push(next.value);
    next = rows.next();
  }
  return { entries, metadata: next.value };
}
/** Batches bound RPC/document work, not retained history or a user's capability. */
export function indexBatches(entries: IndexEntry[], limits = { rows: 100, bytes: 500000 }) {
  const batches: IndexEntry[][] = [];
  let batch: IndexEntry[] = [],
    bytes = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(json(entry));
    if (batch.length && (batch.length >= limits.rows || bytes + size > limits.bytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Select only the next RPC batch; do not serialize or partition the entire
 * remaining queue on every durable step. */
export function firstIndexBatch(entries: IndexEntry[], limits = { rows: 100, bytes: 500000 }) {
  const batch: IndexEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (batch.length >= limits.rows) break;
    const size = Buffer.byteLength(json(entry));
    if (batch.length && bytes + size > limits.bytes) break;
    batch.push(entry);
    bytes += size;
  }
  return batch;
}
