// SPDX-License-Identifier: Apache-2.0
'use node';
import { getArchiveObject } from './projectLandingCapsuleObject';
import { decodeArchiveBytes } from '../src/landing-capsule-bytes';
import { readJournalSegment, type JournalIndex } from '../src/journal-segment';
import { invariant } from '../src/errors';
const objectKey = (projectId: string, index: JournalIndex) =>
  `v1/p/${projectId}/journal-segments/${index.pointer.sha256}`;
export async function getJournalSegment(projectId: string, index: JournalIndex) {
  const body = await getArchiveObject(objectKey(projectId, index), index.pointer);
  invariant(body, 'SOURCE_UNAVAILABLE', 'Selected journal segment is unavailable.');
  return readJournalSegment(decodeArchiveBytes(body, index.pointer), index.pointer, projectId, index);
}
