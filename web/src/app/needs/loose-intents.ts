// SPDX-License-Identifier: Apache-2.0
// Loose ends: open Intents with no linked Item (Item fc1831eb). The group is read on request, one bounded page at a
// time (projectLooseEnds:read with the Intent cursor); the owner tidies picked rows in batches of 25 through
// projectLooseEndIntents:setAside, one retry-safe mutation per batch that skips any Intent that gained a save, an Item
// or a change since the page was read. Undo reopens each at the version the receipt returned
// (projectHostedLifecycle:transition). Nothing here deletes. Pure data and calls; the screen owns the state.
import { ConvexError } from 'convex/values';

/** Mirrors `looseEndIntentCursor` (src/hosted-lifecycle.ts); a test keeps the two equal. */
export const INTENT_CURSOR = 'forge-loose-ends-intents-v1:';
/** The reader and the batch both take at most this many Intents. */
export const INTENT_BATCH = 25;
const REASON = 'Set aside from Loose ends: open Intent with no linked Item';

/** What the reader pins for one Intent (projectLooseEndIntents readLooseEndIntents `selection`). */
export type IntentPin = {
  projectId: string;
  intentId: string;
  version: number;
  laneRevision: number;
  observedAt: number;
};
export type IntentRow = {
  selection: IntentPin;
  status: string;
  title: string;
  /** ISO time of the last Intent, Lane or save activity; null when the bounded child read could not tell. */
  lastActivityAt: string | null;
  reason: string;
};

/** An Undo row: the version the set-aside receipt returned, and the operation id every attempt of its reopen reuses. */
export type UndoPin = { intentId: string; version: number; operationId: string };

/** One mutation: the exact request and its operation id, replayed unchanged when its outcome is unknown. */
export type IntentBatch = { operationId: string; request: string; ids: string[] };
export type IntentTidy = (args: { operationId: string; request: string }) => Promise<string>;
export type IntentReopen = (args: { request: string }) => Promise<string>;

export function intentBatches(epoch: number, pins: IntentPin[]): IntentBatch[] {
  const batches: IntentBatch[] = [];
  for (let i = 0; i < pins.length; i += INTENT_BATCH) {
    const chunk = pins.slice(i, i + INTENT_BATCH);
    batches.push({
      operationId: crypto.randomUUID(),
      request: JSON.stringify({ authorityEpoch: epoch, reason: REASON, intents: chunk }),
      ids: chunk.map(pin => pin.intentId),
    });
  }
  return batches;
}

type TidyReply = { results: { intentId: string; result: string; version?: number }[] };

/** Run batches one after another. A batch whose call failed outright marks its rows `failed` and is returned to be
 * replayed as it was; every other row carries the word the server gave it. */
export async function tidyIntents(call: IntentTidy, batches: IntentBatch[]) {
  const results: Record<string, string> = {};
  const versions: Record<string, number> = {};
  const failed: IntentBatch[] = [];
  for (const batch of batches) {
    try {
      const reply = JSON.parse(
        await call({ operationId: batch.operationId, request: batch.request }),
      ) as TidyReply;
      for (const entry of reply.results) {
        results[entry.intentId] = entry.result;
        if (entry.version !== undefined) versions[entry.intentId] = entry.version;
      }
    } catch {
      for (const id of batch.ids) results[id] = 'failed';
      failed.push(batch);
    }
  }
  return { results, versions, failed };
}

/** Undo: reopen Intents still set aside at the version their receipt returned. One changed since is `changed`. */
export async function reopenIntents(call: IntentReopen, epoch: number, pins: UndoPin[]) {
  const results: Record<string, 'reopened' | 'changed' | 'failed'> = {};
  for (const pin of pins) {
    try {
      await call({
        request: JSON.stringify({
          operationId: pin.operationId,
          authorityEpoch: epoch,
          action: 'reopen',
          reason: '',
          target: { kind: 'intent', intentId: pin.intentId, version: pin.version, cascade: false },
        }),
      });
      results[pin.intentId] = 'reopened';
    } catch (error) {
      const code =
        error instanceof ConvexError ? (error.data as { code?: string } | undefined)?.code : undefined;
      results[pin.intentId] = code === 'WORK_STALE' ? 'changed' : 'failed';
    }
  }
  return results;
}

/** What the batch said about one Intent, in words. A failed call is the only kind retry repeats. */
export function intentWord(result: string) {
  switch (result) {
    case 'set-aside':
      return { word: 'Set aside', done: true, retry: false };
    case 'reopened':
      return { word: 'Brought back', done: false, retry: false };
    case 'saved-since-selection':
      return { word: 'Skipped: it was saved meanwhile', done: false, retry: false };
    case 'intent-changed':
    case 'lane-changed':
      return { word: 'Skipped: it changed meanwhile', done: false, retry: false };
    case 'item-linked':
      return { word: 'Skipped: it has an Item now', done: false, retry: false };
    case 'item-link-not-reported':
      return { word: 'Skipped: its Item link is not reported', done: false, retry: false };
    case 'child-review-required':
      return { word: 'Skipped: it has many Lanes to review first', done: false, retry: false };
    case 'not-open':
    case 'not-found':
      return { word: 'Skipped: it is already closed', done: false, retry: false };
    case 'failed':
      return { word: 'Could not set aside', done: false, retry: true };
    default:
      return { word: `Skipped (${result})`, done: false, retry: false };
  }
}
