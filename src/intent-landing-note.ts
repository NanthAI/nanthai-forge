// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Pure: runs in the Convex non-Node runtime and in test fixtures.
import { digest } from './state/hash.js';

/** Lanes named per note; a receipt usually carries one Lane of an Intent, a cohort a few. */
export const LANDING_NOTE_LANES = 5;
/** System notes an Item read returns, newest first, across its Intent chain. */
export const LANDING_NOTES_PER_ITEM = 50;
/** The author label of every system comment: no person or agent wrote it. */
export const SYSTEM_COMMENT_AUTHOR = 'Forge';

export type LandingNote = {
  intentId: string;
  receiptId: string;
  kind: 'landed' | 'reverted';
  at: string;
  laneIds: string[];
  commit: string;
  sequence: number;
  actor: string;
  agentRun?: string | undefined;
  agentClient?: string | undefined;
  landedBy?: { by: 'queue' | 'agent' | 'person'; review: 'person' | 'none' } | undefined;
  viaLaneId?: string | undefined;
  revertOf?: string | undefined;
};

/** A stable comment id per note (kind, receipt, Intent), shaped as a UUID so readers treat it like any
 * comment id; a replayed landing derives the same id. */
export function landingNoteId(note: Pick<LandingNote, 'kind' | 'receiptId' | 'intentId'>) {
  const hex = digest(JSON.stringify(['landing-note', note.kind, note.receiptId, note.intentId])).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const short = (id: string) => id.slice(0, 8);
const lanes = (ids: string[]) =>
  ids.length === 1 ? `Lane ${short(ids[0]!)}` : `Lanes ${ids.map(short).join(', ')}`;

/** One line naming the receipt facts; no person is named in the text (the structured `actor` is mapped
 * to a handle per viewer by the public identity rule, or removed). */
export function landingNoteText(note: LandingNote) {
  if (note.kind === 'reverted')
    return (
      `Reverted: receipt ${short(note.revertOf ?? '')} (${lanes(note.laneIds)}) is off main; revert receipt ` +
      `${short(note.receiptId)}, commit ${short(note.commit)}, main #${note.sequence}.`
    );
  const by = note.landedBy?.by;
  const landed =
    by === 'queue'
      ? `Landed by the queue${note.agentRun ? ' (submitted by an agent run)' : ''}`
      : by === 'agent'
        ? 'Landed by its agent run'
        : by === 'person'
          ? 'Landed by a person'
          : 'Landed';
  const accepted =
    note.landedBy?.review === 'person'
      ? ' A person accepted it.'
      : note.landedBy
        ? ' Project policy accepted it after its check passed.'
        : '';
  const via = note.viaLaneId ? ` through Lane ${short(note.viaLaneId)}` : '';
  return (
    `${landed}: ${lanes(note.laneIds)}${via}, receipt ${short(note.receiptId)}, ` +
    `commit ${short(note.commit)}, main #${note.sequence}.${accepted}`
  );
}

/** The note as a planning comment row value: the comment fields every reader already draws, plus
 * `system: true` and the structured `landing` facts. `actor` is the submitter (`account` or
 * `account/agent`), mapped to a public handle per viewer; no other `landing` key is a person key. */
function noteComment(note: LandingNote) {
  return {
    id: landingNoteId(note),
    authorLabel: SYSTEM_COMMENT_AUTHOR,
    system: true as const,
    text: landingNoteText(note),
    at: note.at,
    provenance: 'forge-receipt' as const,
    landing: {
      kind: note.kind,
      receiptId: note.receiptId,
      intentId: note.intentId,
      laneIds: note.laneIds,
      commit: note.commit,
      sequence: note.sequence,
      actor: note.agentRun ? `${note.actor}/${note.agentRun}` : note.actor,
      ...(note.agentClient ? { agentClient: note.agentClient } : {}),
      // `landedBy`, never `by`: `by` is a person key the identity mapper would resolve as a handle (66f9ed38).
      ...(note.landedBy
        ? {
            landedBy: note.landedBy.by,
            accepted: note.landedBy.review === 'person' ? ('person' as const) : ('policy' as const),
            review: note.landedBy.review,
          }
        : {}),
      ...(note.viaLaneId ? { viaLaneId: note.viaLaneId } : {}),
      ...(note.revertOf ? { revertOf: note.revertOf } : {}),
    },
  };
}

export function landingNoteComment(itemId: string, note: LandingNote) {
  return { itemId, ...noteComment(note) };
}

/** A receipt can appear on several Items. The export keeps one note per Intent. */
export function landingNoteExport(note: LandingNote) {
  return { intentId: note.intentId, ...noteComment(note) };
}
