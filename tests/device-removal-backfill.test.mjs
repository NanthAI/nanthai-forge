// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';

const { run } = await import(moduleUrl('../convex/deviceRemovalBackfill.ts'));

test('removed-device backfill refuses other deployments before reading or writing credentials', async t => {
  const previous = process.env.CONVEX_CLOUD_URL;
  process.env.CONVEX_CLOUD_URL = 'https://other-deployment.convex.cloud';
  t.after(() => {
    if (previous === undefined) delete process.env.CONVEX_CLOUD_URL;
    else process.env.CONVEX_CLOUD_URL = previous;
  });
  await assert.rejects(
    run._handler(
      {
        get db() {
          assert.fail('Accessed credentials outside the approved deployment');
        },
      },
      { cursor: null },
    ),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
});

test('removed-device backfill clears only removed key/code fields in bounded pages and is safe to replay', async t => {
  const previous = process.env.CONVEX_CLOUD_URL;
  process.env.CONVEX_CLOUD_URL = 'https://benevolent-wildebeest-974.convex.cloud';
  t.after(() => {
    if (previous === undefined) delete process.env.CONVEX_CLOUD_URL;
    else process.env.CONVEX_CLOUD_URL = previous;
  });
  for (const total of [1200, 2400]) {
    const s = state();
    const rows = s.tables.cliCredentials;
    for (let i = 0; i < total; i++) {
      const id = `fixture-${i}`;
      rows.set(id, {
        _id: id,
        _creationTime: i + 1,
        owner: 'owner',
        credentialId: id,
        issuedAt: 1,
        expiresAt: 2,
        name: 'Fixture',
        scope: 'cli',
        tokenHash: 'fixture',
        revoked: i % 3 !== 0,
        ...(i % 3 === 2 ? { removed: true } : {}),
        ...(i % 3 !== 2 || i % 2 === 0 ? { deviceKey: 'fixture-public-key' } : {}),
        ...(i % 3 !== 2 || i % 12 === 2 || i % 12 === 5 ? { deviceCode: 'fixture-code' } : {}),
      });
    }
    const before = structuredClone(rows);
    const first = await run._handler(s.ctx, { cursor: null });
    assert.equal(first.scanned, 100);
    assert.equal(first.cleared, 25);
    const replay = await run._handler(s.ctx, { cursor: null });
    assert.deepEqual(replay, { ...first, cleared: 0 });
    let page = first,
      pages = 1,
      scanned = first.scanned,
      cleared = first.cleared;
    while (!page.isDone) {
      page = await run._handler(s.ctx, { cursor: page.continueCursor });
      assert(page.scanned > 0 && page.scanned <= 100);
      pages++;
      scanned += page.scanned;
      cleared += page.cleared;
    }
    assert.equal(pages, Math.ceil(total / 100));
    assert.equal(scanned, total);
    assert.equal(cleared, total / 4);
    for (const row of before.values()) {
      if (row.removed) {
        delete row.deviceKey;
        delete row.deviceCode;
      }
      assert.deepEqual(rows.get(row._id), row);
    }
  }
});
