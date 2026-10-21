// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import { invariant } from './errors.js';
import type { WorkData } from './work-types.js';
import { archiveSource, retainedSource, type sourceManifestSchema } from './work-archive-metadata.js';

// Array.find chooses the first occurrence, including retained extension records
// with repeated IDs. These transient indexes must preserve that choice.
function firstById<T extends { id: string }>(items: readonly T[]) {
  const index = new Map<string, T>();
  for (const item of items) if (!index.has(item.id)) index.set(item.id, item);
  return index;
}
function planningLookup(items: readonly { id: string }[]) {
  const first = firstById(items),
    versions = new Map<string, Map<unknown, { id: string }>>();
  for (const item of items) {
    if (!('version' in item)) continue;
    let index = versions.get(item.id);
    if (!index) {
      index = new Map();
      versions.set(item.id, index);
    }
    if (!index.has(item.version)) index.set(item.version, item);
  }
  return (original: { id: string }) =>
    !('version' in original)
      ? first.get(original.id)
      : // Map uses SameValueZero; the previous strict-equality predicate never
        // matched NaN. Version extensions otherwise retain exact value identity.
        typeof original.version === 'number' && Number.isNaN(original.version)
        ? undefined
        : versions.get(original.id)?.get(original.version);
}

/** Validate retained metadata without rewriting or normalizing either snapshot. */
export function validateSourceReturn(
  current: WorkData,
  candidate: WorkData,
  manifest: z.infer<typeof sourceManifestSchema>,
) {
  invariant(
    ![16, 18, 20].includes(current.schema) || [16, 18, 20].includes(candidate.schema),
    'WORK_UPGRADE_REQUIRED',
    'Unified hosted Intents require a unified format-16, format-18 or format-20 checkpoint; upgrade nforge. Existing Work is preserved.',
  );
  invariant(
    JSON.stringify(candidate.hostedChannelMoves ?? []) === JSON.stringify(current.hostedChannelMoves ?? []),
    'INVALID_WORK_JOURNAL',
    'Return the original hosted Channel receipts. Local checkpoints do not rewrite hosted acceptance.',
  );
  invariant(
    candidate.revision >= current.revision &&
      JSON.stringify(candidate.hostedEvents.slice(0, current.hostedEvents.length)) ===
        JSON.stringify(current.hostedEvents),
    'INVALID_WORK_JOURNAL',
    'Return a local checkpoint containing the current hosted operation history. Both source versions remain available.',
  );
  // This is an owner-selected local checkpoint, not a server-side merge or independently verified execution.
  for (const [key, items] of Object.entries(current)) {
    if (!Array.isArray(items) || key === 'hostedEvents') continue;
    const next = candidate[key as keyof typeof candidate];
    const ids = new Set(Array.isArray(next) ? next.map(item => item?.id) : []);
    invariant(
      Array.isArray(next) && items.every(item => !item?.id || ids.has(item.id)),
      'INVALID_WORK_JOURNAL',
      'The local checkpoint omits retained Work records. Original source and metadata remain available.',
    );
  }
  const intents = firstById(candidate.intents);
  for (const intent of current.intents) {
    const next = intents.get(intent.id)!;
    invariant(
      next.base === intent.base &&
        ([16, 18, 20].includes(current.schema) || next.outcome === intent.outcome) &&
        next.constraints === intent.constraints &&
        next.createdAt === intent.createdAt &&
        next.baseChannel?.name === intent.baseChannel?.name &&
        next.baseChannel?.head === intent.baseChannel?.head &&
        next.baseChannel?.acceptanceId === intent.baseChannel?.acceptanceId &&
        next.hostedBase?.name === intent.hostedBase?.name &&
        next.hostedBase?.head === intent.hostedBase?.head &&
        next.hostedBase?.acceptanceId === intent.hostedBase?.acceptanceId &&
        intent.notes.every((note, index) => {
          const value = next.notes[index];
          return value?.text === note.text && value.kind === note.kind && value.at === note.at;
        }),
      'INVALID_WORK_JOURNAL',
      'The returned checkpoint changed original Intent source or omitted hosted entries.',
    );
  }
  for (const collection of ['planningItems', 'planningComments'] as const) {
    const lookup = planningLookup(candidate[collection]);
    for (const original of current[collection]) {
      const next = lookup(original);
      invariant(
        next && JSON.stringify(next) === JSON.stringify(original),
        'INVALID_WORK_JOURNAL',
        'The returned checkpoint changed or omitted original planning history or discussion.',
      );
    }
  }
  const history = firstById(candidate.historicalWork ?? []);
  for (const historical of current.historicalWork ?? []) {
    const next = history.get(historical.id);
    invariant(
      next && JSON.stringify(next) === JSON.stringify(historical),
      'INVALID_WORK_JOURNAL',
      'The returned checkpoint changed an original historical archive or mapping.',
    );
  }
  const moves = firstById(candidate.channelMoves);
  let source: ReturnType<typeof archiveSource> | undefined;
  for (const move of current.channelMoves.filter(item => item.status === 'accepted')) {
    const next = moves.get(move.id);
    invariant(
      next?.status === 'accepted' &&
        next.head === move.head &&
        next.viewId === move.viewId &&
        next.channel === move.channel &&
        next.previous === move.previous &&
        retainedSource(
          (source ??= archiveSource(manifest, candidate)),
          move.head,
          `refs/forge/channel-moves/${move.id}`,
        ),
      'INVALID_WORK_JOURNAL',
      'The local checkpoint changed a retained original Channel receipt.',
    );
  }
}
