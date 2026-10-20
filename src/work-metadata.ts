// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { isUnifiedWork, parseWork } from './work-unified-types.js';
import { unifyIntent, resolveIntentId, noteConversation } from './work-intent-local.js';
import { hostedIntentMigrationSchema } from './work-hosted-intents.js';
import { validateAnchorView } from './work-source-anchor.js';
import { intentLifecycle } from './work-lifecycle.js';
import type { IntentMetadataCommand } from './work-intent-types.js';
import { applyPlanningMetadata, planningRequest } from './work-planning-state.js';
import { digest, digestChunks } from './portable-hash.js';
import { jsonChunks } from './json-chunks.js';
import { invariant } from './errors.js';
import { retainedSource, type ArchiveSource } from './work-archive-metadata.js';
import {
  hostedEventSchema,
  hostedCommandSchema,
  type MetadataCommand,
  type WorkData,
  type HostedEvent,
} from './work-types.js';

export function applyIntentMetadata(
  data: WorkData,
  command: IntentMetadataCommand,
  context: { id: string; at: string; noteIndex?: number },
) {
  if (command.action === 'intent') {
    invariant(
      !data.intents.some(item => item.id === context.id),
      'WORK_OPERATION_CHANGED',
      'This Intent identity already exists. Original work remains available.',
    );

    const intent = {
      id: context.id,
      outcome: command.outcome,
      constraints: command.constraints,
      base: command.base,
      status: 'active' as const,
      notes: [],
      createdAt: context.at,
      ...(command.baseChannel ? { baseChannel: command.baseChannel } : {}),
      ...(command.hostedBase ? { hostedBase: command.hostedBase } : {}),
    };
    const stored = isUnifiedWork(data) ? unifyIntent(intent) : intent;
    data.intents.push(stored);
    return stored;
  }
  const targetId = resolveIntentId(
    (data as WorkData & { intentAliases?: { aliasId: string; intentId: string }[] }).intentAliases,
    command.intentId,
  );
  const intent = data.intents.find(item => item.id === targetId);
  invariant(intent, 'NOT_FOUND', 'Intent not found.');
  if (isUnifiedWork(data)) Object.assign(intent, unifyIntent(intent));
  if (command.action === 'intent-status') {
    if (isUnifiedWork(data) && command.status === 'ready') {
      (intent.lifecycle ??= []).push({ from: intent.status, to: 'ready', at: context.at });
      intent.status = 'active';
    } else intentLifecycle(data, intent, command.status, context.at);
  } else {
    if (command.anchor) {
      validateAnchorView(
        data.views.find(view => view.id === command.anchor!.viewId),
        targetId,
        command.anchor,
      );
      data.schema = Math.max(data.schema, 9) as WorkData['schema'];
    }
    const noteIndex = context.noteIndex ?? intent.notes.length;
    intent.notes.push({
      text: command.text,
      kind: command.kind,
      at: context.at,
      ...(command.anchor ? { anchor: command.anchor } : {}),
    });
    if (isUnifiedWork(data)) {
      const unified = intent as typeof intent & { conversation: ReturnType<typeof noteConversation>[] };
      unified.conversation.push(noteConversation(intent.id, noteIndex));
    }
  }
  return intent;
}
export function validateMetadataSource(data: WorkData, command: MetadataCommand, source: ArchiveSource) {
  if (command.action !== 'intent') return;
  invariant(
    retainedSource(source, command.base),
    'SOURCE_UNAVAILABLE',
    'Select source pinned in this project’s original archive.',
  );
  const channel = command.baseChannel;
  if (channel)
    invariant(
      channel.head === command.base &&
        retainedSource(source, command.base, `refs/forge/channels/${channel.name}`) &&
        data.channelMoves.some(
          move =>
            move.id === channel.acceptanceId &&
            move.channel === channel.name &&
            move.head === command.base &&
            move.status === 'accepted',
        ),
      'SOURCE_UNAVAILABLE',
      'This Channel acceptance differs from the pinned source archive.',
    );
  const hosted = command.hostedBase;
  if (hosted)
    invariant(
      hostedChannels(data).some(
        move =>
          move.channel === hosted.name &&
          move.id === hosted.acceptanceId &&
          move.head === hosted.head &&
          move.head === command.base,
      ),
      'CHANNEL_CHANGED',
      'Select the current hosted Channel receipt. Existing Intents retain their original source.',
    );
}
export const metadataRequest = (command: HostedEvent['command']) => {
  const parsed = hostedCommandSchema.parse(command);
  return parsed.action === 'put-planning-item' || parsed.action === 'comment-planning-item'
    ? planningRequest(parsed)
    : digest(JSON.stringify(parsed));
};
export function hostedChannels(data: WorkData) {
  return [...new Map((data.hostedChannelMoves ?? []).map(move => [move.channel, move])).values()];
}
export function validateHostedChannel(
  data: WorkData,
  command: Extract<HostedEvent['command'], { action: 'accept-hosted-channel' }>,
  source: ArchiveSource,
) {
  const acceptance = data.channelMoves.find(move => move.id === command.acceptanceId),
    view = data.views.find(item => item.id === command.viewId);
  invariant(
    (!command.acceptanceId ||
      (acceptance?.status === 'accepted' &&
        acceptance.head === command.head &&
        acceptance.viewId === command.viewId)) &&
      view?.status === 'clean' &&
      view.head === command.head &&
      (!command.acceptanceId ||
        retainedSource(source, command.head, `refs/forge/channel-moves/${command.acceptanceId}`)) &&
      retainedSource(source, command.head, `refs/forge/views/${command.viewId}`),
    'SOURCE_UNAVAILABLE',
    'Select a retained local acceptance and clean Candidate from this source checkpoint.',
  );
  invariant(
    (hostedChannels(data).find(move => move.channel === command.channel)?.id ?? null) === command.previousId,
    'CHANNEL_CHANGED',
    'The hosted Channel selection changed. Its earlier receipts and source remain available.',
  );
}
export const workBytes = (data: WorkData) => JSON.stringify(data, null, 2);
export const workDigest = (data: WorkData) => digestChunks(jsonChunks(data, 2));
export function parseWorkBytes(bytes: Uint8Array): WorkData {
  const raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  // Preserve uninterpreted fields in an imported journal; validation is not permission to discard them.
  return { ...parseWork(raw), ...raw };
}
export function applyHostedEvent(data: WorkData, event: HostedEvent, options: { noteIndex?: number } = {}) {
  event = hostedEventSchema.parse(event);
  // Legacy journal digests retain their original replay format; schema 16 never downgrades.
  if (event.automatic && data.schema < 16) data.schema = 11;
  invariant(
    data.revision === event.previousRevision &&
      !data.hostedEvents.some(item => item.id === event.id) &&
      metadataRequest(event.command) === event.request,
    'INVALID_WORK_JOURNAL',
    'Hosted Work operation lineage differs from its original inputs.',
  );
  const planningIntentId =
    event.command.action === 'put-planning-item' && event.command.kind === 'issue'
      ? resolveIntentId(
          (data as WorkData & { intentAliases?: { aliasId: string; intentId: string }[] }).intentAliases,
          event.command.itemId,
        )
      : undefined;
  const creatingId =
    event.command.action === 'intent'
      ? event.id
      : planningIntentId && !data.intents.some(intent => intent.id === planningIntentId)
        ? planningIntentId
        : undefined;
  if (event.command.action === 'source-return') {
    const actual = workDigest(data);
    invariant(
      event.archiveSha256 === event.command.archiveSha256 &&
        actual === event.command.workSha256 &&
        data.revision >= event.command.previousRevision,
      'INVALID_WORK_JOURNAL',
      `Returned source/Work differs from its original checkpoint: event ${event.id}, revision ${event.previousRevision + 1}, action ${event.command.action}, expected Work ${event.command.workSha256.slice(0, 12)}, actual ${actual.slice(0, 12)}.`,
    );
  } else if (event.command.action === 'accept-hosted-channel') {
    const command = event.command;
    invariant(
      event.archiveSha256 === command.archiveSha256 &&
        (hostedChannels(data).find(move => move.channel === command.channel)?.id ?? null) ===
          command.previousId,
      'INVALID_WORK_JOURNAL',
      'Hosted Channel source or original selection differs from its operation.',
    );
    (data.hostedChannelMoves ??= []).push({
      channel: command.channel,
      ...(command.acceptanceId ? { acceptanceId: command.acceptanceId } : {}),
      viewId: command.viewId,
      head: command.head,
      previousId: command.previousId,
      archiveSha256: command.archiveSha256,
      id: event.id,
      actor: event.actor,
      at: event.at,
      projectKey: event.projectKey,
      provenance: 'signed-in-owner-selection',
      ...(event.automatic ? { automatic: event.automatic } : {}),
    });
  } else if (
    event.command.action === 'put-planning-item' ||
    event.command.action === 'comment-planning-item'
  ) {
    invariant(
      event.command.operationId === event.id,
      'INVALID_WORK_JOURNAL',
      'Planning identity differs from its original hosted operation.',
    );
    applyPlanningMetadata(data, event.command, event.at);
  } else applyIntentMetadata(data, event.command, { id: event.id, at: event.at, ...options });
  if (isUnifiedWork(data) && creatingId) {
    const created = data.intents.find(intent => intent.id === creatingId);
    if (created) (created as Record<string, unknown>).creatorAccountId = event.actor;
  }
  data.hostedEvents.push(event);
  data.revision++;
}
export function validateWorkSize(data: WorkData) {
  parseWork(data);
}
export const hostedJournalSchema = z.object({
  schema: z.literal(1),
  kind: z.literal('forge-hosted-work-journal'),
  intentMigration: hostedIntentMigrationSchema.optional(),
  projectKey: z.uuid(),
  name: z.string(),
  base: z.object({
    archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    workSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  events: z.array(hostedEventSchema),
  revision: z.number().safe().nonnegative(),
  workSha256: z.string().regex(/^[0-9a-f]{64}$/),
  coverage: z.string(),
});
