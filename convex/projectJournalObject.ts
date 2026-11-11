// SPDX-License-Identifier: Apache-2.0
'use node';
import { joinJournalFragments } from '../src/journal-fragments';
import { getArchiveObject } from './projectLandingCapsuleObject';
import { decodeArchiveBytes } from '../src/landing-capsule-bytes';
import { readJournalSegment, type JournalIndex } from '../src/journal-segment';
import { invariant } from '../src/errors';
const objectKey = (projectId: string, index: JournalIndex) =>
  `v1/p/${projectId}/journal-segments/${index.pointer.sha256}`;
export async function getJournalSegment(projectId: string, index: JournalIndex) {
  const selected = [];
  for (const pointer of [index.pointer, ...(index.parts ?? [])]) {
    const body = await getArchiveObject(objectKey(projectId, { ...index, pointer }), pointer);
    invariant(body, 'SOURCE_UNAVAILABLE', 'Selected journal segment is unavailable.');
    selected.push(readJournalSegment(decodeArchiveBytes(body, pointer), pointer, projectId, index));
  }
  return index.parts ? joinJournalFragments(selected) : selected[0]!;
}
