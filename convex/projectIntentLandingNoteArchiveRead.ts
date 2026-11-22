// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import { getLandingCapsule } from './projectLandingCapsuleObject';
import {
  landingNoteOrder,
  type ArchivedNotePin,
  type HotLandingNote,
  type LoadedLandingNote,
} from './projectIntentLandingNoteArchive';
import { invariant } from '../src/errors';

/** Keep complete-object verification in the capsule reader. Only selected note rows
 * cross back into the authorizing query, even when a capsule contains other history. */
export async function loadArchivedLandingNotes(projectId: Id<'hostedProjects'>, pins: ArchivedNotePin[]) {
  const grouped = new Map<string, ArchivedNotePin[]>();
  for (const pin of pins) {
    const group = grouped.get(pin.submissionId) ?? [];
    group.push(pin);
    grouped.set(pin.submissionId, group);
  }
  const selections = [...grouped.values()];
  const loaded: LoadedLandingNote[] = [];
  for (let index = 0; index < selections.length;) {
    const batch = [];
    let rawBytes = 0;
    while (index < selections.length && batch.length < 8) {
      const group = selections[index]!;
      const bytes = group[0]!.pointer.rawSize;
      if (batch.length && rawBytes + bytes > 8 * 1024 * 1024) break;
      batch.push(group);
      rawBytes += bytes;
      index++;
    }
    const rows = await Promise.all(
      batch.map(async group => {
        const { submissionId, pointer } = group[0]!;
        invariant(
          group.every(pin => pin.pointer.sha256 === pointer.sha256),
          'EVIDENCE_CHANGED',
          'Landing note references disagree about their capsule.',
        );
        const capsule = await getLandingCapsule(projectId, submissionId, pointer);
        const notes = new Map(
          (capsule?.tables.projectIntentLandingNotes ?? []).map(text => {
            const row = JSON.parse(text) as HotLandingNote;
            return [landingNoteOrder(row), row];
          }),
        );
        return group.map(({ key, intentId }) => {
          const row = notes.get(key);
          invariant(
            row?.intentId === intentId,
            'EVIDENCE_CHANGED',
            'The selected note differs from its verified capsule.',
          );
          return { key, intentId, submissionId, sha256: pointer.sha256, row };
        });
      }),
    );
    loaded.push(...rows.flat());
  }
  return loaded;
}
