// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributionPage,
  attributionFilter,
  attributionSummary,
} from '../scripts/lib/legacy-storage-attribution.mjs';
const sha256 = 'a'.repeat(64),
  createdAt = Date.UTC(2026, 9, 30, 9);
test('pages table history, filters digest prefixes, never returns source/private body', async () => {
  const filter = attributionFilter([{ digest: sha256, createdAt }]);
  let pages = 0;
  const q = {
    order: () => q,
    paginate: async opts => {
      pages++;
      assert.equal(opts.numItems, 1024);
      assert.equal(opts.maximumBytesRead, 4_000_000);
      return {
        page: [
          { _id: 'row', projectId: 'project', _creationTime: createdAt, privateBody: 'secret ' + sha256 },
        ],
        continueCursor: 'next',
        isDone: false,
      };
    },
  };
  const result = await attributionPage(
    { db: { query: () => q } },
    'projectObjects',
    null,
    filter.prefixes,
    filter.hours,
  );
  assert.equal(pages, 1);
  assert.equal(result.matches[0].sha256, sha256);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(Object.values(result.history)[0], 1);
});
test('history links and size/date patterns remain evidence, never deletion permission', () => {
  const files = [
    { digest: sha256, createdAt, bytes: 5, contentType: 'application/json' },
    { digest: 'b'.repeat(64), createdAt, bytes: 5, contentType: 'application/json' },
  ];
  const s = attributionSummary(files, [{ sha256, project: 'deleted-project', table: 'projectObjects' }]);
  assert.equal(s.digestLinkedFiles, 1);
  assert.equal(s.withoutDigestLink, 1);
  assert.equal(s.bytes, 10);
  assert.equal(s.projects['deleted-project'].files, 1);
  assert.equal(s.commonSizes[0][1].files, 2);
  assert.match(s.interpretation, /not ownership or deletion permission/);
});
