// SPDX-License-Identifier: Apache-2.0
// Item 2766ef9e: a comment purge's attachment bytes leave R2 for good. A refused delete is retried until it succeeds,
// and an upload in flight across the purge leaves no bytes (convex/artifactStorage.ts, tests/artifact-delete-replay.mjs).
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setup } from './hosted-planning-fixture.mjs';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
import { discussionR2, replayFailedDelete, replayLateUpload } from './artifact-delete-replay.mjs';

const { purgeComment } = await import(moduleUrl('../convex/projectCommentPurge.ts'));
const artifactStorage = await import(moduleUrl('../convex/artifactStorage.ts'));

/** An Item with one comment and an uncommitted attachment reservation per name in `names`. */
async function commented(t, names) {
  const s = await setup(t);
  const item = s.item({ title: 'Kept title', body: 'Kept body' });
  await s.send(item);
  const comment = {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: item.itemId,
    authorLabel: 'agent',
    text: 'Reported comment',
  };
  await s.send(comment);
  const rows = [];
  for (const name of names)
    rows.push(
      await artifactStorage.reserve._handler(s.ctx, {
        namespace: `v1/p/${s.projectId}/discussion/${item.itemId}/${comment.operationId}`,
        digest: digest(name),
        size: name.length,
        contentType: 'text/plain',
      }),
    );
  const purge = () =>
    purgeComment(s.ctx, {
      projectId: s.projectId,
      itemId: item.itemId,
      commentId: comment.operationId,
      operationId: randomUUID(),
    });
  return { s, rows, purge };
}

test('comment purge: a refused R2 delete is retried until it succeeds (Item 2766ef9e)', async t => {
  const { s, rows, purge } = await commented(t, ['first', 'second']);
  for (const row of rows) await artifactStorage.markCommitted._handler(s.ctx, { ref: `r2blob:${row._id}` });
  await replayFailedDelete(t, { s, r2: discussionR2(t), rows, purge });
});

test('comment purge: an upload in flight across the purge leaves no bytes (Item 2766ef9e)', async t => {
  const { s, rows, purge } = await commented(t, ['committing', 'abandoned']);
  const [committing, abandoned] = rows;
  await replayLateUpload(t, { s, r2: discussionR2(t), committing, abandoned, purge });
});
