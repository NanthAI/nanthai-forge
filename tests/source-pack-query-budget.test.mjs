// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { getFunctionName } from 'convex/server';
const commits = await import(moduleUrl('../convex/projectObjectCommit.ts'));

test('a public batch of one hundred upload packs bounds expanded member lookups and commits every verified member', async t => {
  const f = recordsFixture();
  const { projectId } = await f.setup();
  const r2 = fakeSourceR2(t);
  const objects = [],
    selected = [];
  for (let pack = 0; pack < 100; pack++) {
    const parts = Array.from({ length: 100 }, (_, member) => Buffer.from(`pack-${pack}/member-${member}\n`));
    const members = parts.map(bytes => ({ digest: digest(bytes), size: bytes.length }));
    const bytes = Buffer.concat(parts),
      sha256 = digest(bytes),
      key = `v1/p/${projectId}/o/${sha256}`;
    r2.objects.set(`/synthetic/${key}`, bytes);
    const id = await f.ctx.db.insert('projectObjects', {
      projectId,
      digest: sha256,
      size: bytes.length,
      nonce: 'synthetic',
      removed: false,
      location: 'r2',
      r2Key: key,
      packMembers: members,
    });
    objects.push({ id });
    selected.push(...members);
  }
  const ctx = {
    runQuery: (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectObjectCommit:pendingRows');
      return f.call('pending rows', commits.pendingRows, args);
    },
    runMutation: (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectObjectCommit:markCommitted');
      return f.call('mark committed', commits.markCommitted, args);
    },
  };
  const result = await commits.commitObjects(ctx, 'owner', objects);
  assert.equal(result.length, 10100);
  const stored = new Map([...f.tables.projectObjects.values()].map(row => [row.digest, row]));
  for (const pin of selected) assert(stored.get(pin.digest)?.r2Committed);
  assert(objects.every(({ id }) => f.tables.projectObjects.get(id).r2Committed));
  assert.equal(f.tables.projectObjects.size, 10100);
  assert(f.counts.every(row => row.ranges < 4096 && row.documents < 4096));
  t.diagnostic(
    JSON.stringify({
      packs: objects.length,
      members: selected.length,
      calls: f.counts.length,
      maxQueries: Math.max(...f.counts.map(row => row.ranges)),
      maxDocuments: Math.max(...f.counts.map(row => row.documents)),
    }),
  );
});
