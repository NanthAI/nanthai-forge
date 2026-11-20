// SPDX-License-Identifier: Apache-2.0
'use node';
import { joinJournalFragments } from '../src/journal-fragments';
import { getArchiveObject } from './projectLandingCapsuleObject';
import { decodeArchiveBytes } from '../src/landing-capsule-bytes';
import { readJournalSegment, type JournalIndex } from '../src/journal-segment';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
export const journalObjectKey = (projectId: string, sha256: string) =>
  `v1/p/${projectId}/journal-segments/${sha256}`;
export async function getJournalSegment(projectId: string, index: JournalIndex, signal?: AbortSignal) {
  const selected = [];
  for (const pointer of [index.pointer, ...(index.parts ?? [])]) {
    const body = await getArchiveObject(journalObjectKey(projectId, pointer.sha256), pointer, false, signal);
    invariant(body, 'SOURCE_UNAVAILABLE', 'Selected journal segment is unavailable.');
    selected.push(readJournalSegment(decodeArchiveBytes(body, pointer), pointer, projectId, index));
  }
  const segment = index.parts ? joinJournalFragments(selected) : selected[0]!;
  invariant(
    !index.rewritten || digest(canonicalPayload(segment)) === index.rewritten,
    'EVIDENCE_CHANGED',
    'Rewritten journal bytes differ from the logical pin.',
  );
  return segment;
}

/** A private read transports the selected physical pin with the decoded rows, including after a rewrite. */
export async function loadJournalSegment(projectId: string, index: JournalIndex) {
  return canonicalPayload({
    sha256: index.pointer.sha256,
    segment: await getJournalSegment(projectId, index),
  });
}
