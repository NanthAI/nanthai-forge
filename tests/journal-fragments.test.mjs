// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { journalFragmentTexts, joinJournalFragments } from '../dist/journal-fragments.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { encodeArchiveBytes, decodeArchiveBytes } from '../dist/landing-capsule-bytes.js';
import { journalTablePins, readJournalSegment, JOURNAL_PAGE_BYTES } from '../dist/journal-segment.js';

test('existing large Unicode rows travel in bounded verified fragments and reassemble exact canonical source bytes', () => {
  const row = canonicalPayload({ _id: 'original', projectId: 'project', value: '𐐷漢字\\"'.repeat(60000) });
  const segment = {
    protocol: 1,
    kind: 'forge-journal-segment',
    projectId: 'project',
    scope: 'record:job:old',
    from: 0,
    through: 0,
    tables: { projectHostedRecordBodies: [row] },
  };
  const texts = journalFragmentTexts(segment);
  assert(texts.length > 1);
  const read = texts.map(text => {
    const physical = JSON.parse(text);
    assert(Buffer.byteLength(physical.tables.projectHostedRecordBodies[0]) <= JOURNAL_PAGE_BYTES);
    const encoded = encodeArchiveBytes(text, 0, journalTablePins(physical.tables));
    return readJournalSegment(
      decodeArchiveBytes(encoded.body, encoded.pointer),
      encoded.pointer,
      'project',
      segment,
    );
  });
  assert.deepEqual(joinJournalFragments(read), segment);
  assert.throws(
    () => joinJournalFragments(read.slice(1)),
    error => error.code === 'EVIDENCE_CHANGED',
  );
  assert.throws(
    () => joinJournalFragments([...read].reverse()),
    error => error.code === 'EVIDENCE_CHANGED',
  );
  const changed = structuredClone(read),
    first = JSON.parse(changed[0].tables.projectHostedRecordBodies[0]);
  first.journalFragment.text += 'changed';
  changed[0].tables.projectHostedRecordBodies[0] = canonicalPayload(first);
  assert.throws(
    () => joinJournalFragments(changed),
    error => error.code === 'EVIDENCE_CHANGED',
  );
});
