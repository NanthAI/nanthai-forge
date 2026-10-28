// SPDX-License-Identifier: Apache-2.0
import type { WorkRecordRoot } from './work-exchange-records.js';
import type { WorkDelta } from './work-exchange-delta.js';
import type { z } from 'zod';
import type { sourceManifestSchema } from './work-archive-metadata.js';
import type { HostedEvent } from './work-types.js';
import { workDeltaContext } from './work-exchange-context.js';
import { recordBytes, recordIdentity } from './work-exchange-records.js';
import { channelMetadataChanges, validateChangedRecords } from './work-exchange-delta.js';
import { applyHostedEvent, metadataRequest, parseWorkBytes } from './work-metadata.js';
import { validateSourceReturn } from './work-source-return.js';
import { invariant } from './errors.js';
import { digest } from './hash.js';
export async function prepareRecordReturn(
  before: WorkRecordRoot,
  after: WorkRecordRoot,
  delta: WorkDelta,
  events: HostedEvent[],
  manifest: z.infer<typeof sourceManifestSchema>,
  revision: number,
  priorDigest: string,
  read: (pin: { sha256: string; size: number }) => Promise<Buffer>,
  readMany: (pins: { sha256: string; size: number }[]) => Promise<Buffer[]>,
) {
  const extra: string[] = [];
  for (const event of events) {
    const command = event.command;
    if ('intentId' in command) extra.push(recordIdentity('intents', command.intentId));
    if ('anchor' in command && command.anchor) extra.push(recordIdentity('views', command.anchor.viewId));
    // Replay checks only the latest receipt per Channel; the complete retained
    // receipt history is authenticated below by ordered descriptor hashes.
  }
  const metadataOnly = await channelMetadataChanges(before, after, delta.changes, read);
  const context = await workDeltaContext(before, after, delta, read, extra, metadataOnly, {
    maxBytes: 32 * 1024 * 1024,
    readMany,
  });
  if (!context) return;
  const pins = new Set(
    manifest.files.filter(pin => pin.path === `objects/${pin.sha256}`).map(pin => pin.sha256),
  );
  const validated = await validateChangedRecords(
    before,
    after,
    delta.changes,
    read,
    pins,
    metadataOnly,
    context,
  );
  // Authenticate the complete hosted history by ordered hashes without loading it.
  const oldEvents = before.fields.find(f => f.name === 'hostedEvents'),
    nextEvents = after.fields.find(f => f.name === 'hostedEvents');
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
        event.command.workSha256 === before.work.sha256 && event.command.archiveSha256 === priorDigest,
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
    context.previous.revision === revision &&
      nextEvents &&
      'records' in nextEvents &&
      expected.every(
        ([id, sha], i) => nextEvents.records[i]?.key === id && nextEvents.records[i]?.sha256 === sha,
      ),
    'INVALID_WORK_JOURNAL',
    'Returned record delta omits or rewrites hosted history.',
  );
  const oldMoves = before.fields.find(f => f.name === 'hostedChannelMoves'),
    nextMoves = after.fields.find(f => f.name === 'hostedChannelMoves');
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
    manifest,
  );
  return { context, validated: { validated: validated.validated } };
}

/** Journal digests use parsed Work field order, including versioned defaults. */
export function preservesParsedWorkBytes(root: WorkRecordRoot) {
  const skeleton = Object.fromEntries(
    root.fields.map(field => [field.name, 'records' in field ? [] : field.value]),
  );
  const parsed = parseWorkBytes(Buffer.from(JSON.stringify(skeleton)));
  return JSON.stringify(Object.keys(parsed)) === JSON.stringify(root.fields.map(field => field.name));
}
