// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { backupFreshness, main } from '../scripts/hosted-backup-freshness.mjs';
import { r2Client } from '../scripts/lib/hosted-backup-r2.mjs';

const prefix = 'hosted/synthetic/';
const deployment = 'synthetic';
const id = '11111111-1111-4111-8111-111111111111';
const time = '2026-10-19T03:00:00.000Z';
const key = `${prefix}${time.replaceAll(':', '-')}-${id}/manifest.json`;
const manifest = { format: 1, operationId: id, time, deployment, size: 100, sha256: 'a'.repeat(64) };
function fixture(keys = [key]) {
  const calls = { pages: 0, manifest: 0, head: 0 };
  const client = {
    async *pages(selected) {
      assert.equal(selected, prefix);
      calls.pages++;
      yield keys;
    },
    async manifest(selected) {
      assert.equal(selected, key);
      calls.manifest++;
      return { ...manifest };
    },
    async head(selected) {
      assert.equal(selected, key.replace('manifest.json', 'snapshot.zip'));
      calls.head++;
      return { size: 100, sha256: 'a'.repeat(64) };
    },
  };
  return { client, calls, prefix, deployment, now: new Date('2026-10-26T03:00:00.000Z') };
}

test('remote completed manifest freshness survives empty runner state; eight days is inclusive', async () => {
  const f = fixture();
  assert.deepEqual(await backupFreshness(f), { operation: 'backup-freshness', ageDays: 7, overdue: false });
  assert.deepEqual(f.calls, { pages: 1, manifest: 1, head: 1 });
  f.now = new Date('2026-10-27T03:00:00.000Z');
  assert.equal((await backupFreshness(f)).overdue, false);
  f.now = new Date(f.now.getTime() + 1);
  assert.equal((await backupFreshness(f)).overdue, true);
});

test('missing backups and incomplete uploads are overdue; only exact prefix manifests count', async () => {
  const f = fixture([key.replace('manifest.json', 'snapshot.zip'), 'other/' + key, prefix + 'manifest.json']);
  assert.deepEqual(await backupFreshness(f), { operation: 'backup-freshness', ageDays: null, overdue: true });
  assert.deepEqual(f.calls, { pages: 1, manifest: 0, head: 0 });
});

test('newest completed key is selected across pages without reading every manifest', async () => {
  const f = fixture();
  f.client.pages = async function* () {
    yield [key.replace('2026-10-19', '2026-10-12')];
    yield [key, key.replace('2026-10-19', '2026-10-05')];
  };
  assert.equal((await backupFreshness(f)).ageDays, 7);
  assert.equal(f.calls.manifest, 1);
});

test('wrong deployment, inconsistent manifests, future times and missing ZIP fail closed', async () => {
  for (const change of [
    { format: 2 },
    { deployment: 'other' },
    { operationId: 'other' },
    { time: 'invalid' },
    { time: '2026-10-20T03:00:00.000Z' },
    { size: 0 },
    { size: -1 },
    { sha256: 'invalid' },
  ]) {
    const f = fixture();
    f.client.manifest = async () => ({ ...manifest, ...change });
    await assert.rejects(backupFreshness(f), { code: 'BACKUP_STATE_INVALID' });
  }
  const future = fixture();
  future.now = new Date('2026-10-18T03:00:00.000Z');
  await assert.rejects(backupFreshness(future), { code: 'BACKUP_STATE_INVALID' });
  for (const head of [null, { size: 99 }, { size: 100, sha256: 'b'.repeat(64) }]) {
    const f = fixture();
    f.client.head = async () => head;
    await assert.rejects(backupFreshness(f), { code: 'BACKUP_CHECKSUM_MISMATCH' });
  }
  for (const bad of ['', '../escape/', 'no-trailing-slash'])
    await assert.rejects(backupFreshness({ ...fixture(), prefix: bad }), { code: 'ARGUMENT_INVALID' });
});

test('CLI reports age and nonzero outcomes without provider or credential output', async t => {
  const logs = [],
    errors = [];
  t.mock.method(console, 'log', line => logs.push(JSON.parse(line)));
  t.mock.method(console, 'error', line => errors.push(line));
  const env = { HOSTED_DURABILITY_R2_PREFIX: prefix, HOSTED_DURABILITY_DEPLOYMENT: deployment };
  assert.equal(await main(env, fixture()), 0);
  assert.equal(logs[0].ageDays, 7);
  assert.equal(await main(env, { ...fixture(), now: new Date('2026-10-28T03:00:00.000Z') }), 2);
  assert.equal(await main(env, fixture([])), 2);
  const broken = fixture();
  broken.client.pages = async function* () {
    throw new Error('SYNTHETIC_SECRET signed URL');
  };
  assert.equal(await main(env, broken), 1);
  assert.deepEqual(errors, [JSON.stringify({ error: { code: 'BACKUP_FRESHNESS_FAILED' } })]);
});

for (const objects of [32000, 64000])
  test(`dogfood ${objects}-object prefix needs only pages plus one manifest/HEAD`, async () => {
    const counts = { list: 0, manifest: 0, head: 0 };
    const env = {
      R2_ACCOUNT_ID: 'synthetic',
      R2_BUCKET: 'fake',
      R2_ACCESS_KEY_ID: 'fake',
      R2_SECRET_ACCESS_KEY: 'fake',
    };
    const started = performance.now();
    const client = r2Client(env, async (url, init) => {
      const u = new URL(url);
      if (u.searchParams.has('list-type')) {
        counts.list++;
        assert.equal(u.searchParams.get('max-keys'), '1000');
        const page = Number(u.searchParams.get('continuation-token') ?? 0);
        const keys = Array.from({ length: 1000 }, (_, i) =>
          page === objects / 1000 - 1 && i === 999
            ? key
            : `${prefix}incomplete-${page * 1000 + i}/snapshot.zip`,
        );
        return new Response(
          `<IsTruncated>${page < objects / 1000 - 1}</IsTruncated>` +
            (page < objects / 1000 - 1 ? `<NextContinuationToken>${page + 1}</NextContinuationToken>` : '') +
            keys.map(k => `<Contents><Key>${encodeURIComponent(k)}</Key></Contents>`).join(''),
        );
      }
      if (init.method === 'HEAD') {
        counts.head++;
        return new Response(null, {
          headers: { 'content-length': '100', 'x-amz-meta-sha256': manifest.sha256 },
        });
      }
      counts.manifest++;
      return new Response(JSON.stringify(manifest));
    });
    assert.equal((await backupFreshness({ ...fixture(), client })).overdue, false);
    assert.deepEqual(counts, { list: objects / 1000, manifest: 1, head: 1 });
    assert(
      process.resourceUsage().maxRSS * 1024 < 256 * 1024 * 1024,
      'freshness peak RSS stays below 256 MiB',
    );
    console.log(
      JSON.stringify({
        objects,
        r2Calls: objects / 1000 + 2,
        convexCalls: 0,
        wallMs: Math.round(performance.now() - started),
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
  });
