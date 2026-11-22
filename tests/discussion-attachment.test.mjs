// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { getDocumentSize } from 'convex/values';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
import { projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { pinOf, setup } from './r2-harness.mjs';

const { default: http } = await import(moduleUrl('../convex/http.ts'));
const { resolve } = await import(moduleUrl('../convex/discussionAttachmentRead.ts'));
const itemId = '00000000-0000-4000-8000-000000000001';
const commentId = '00000000-0000-4000-8000-000000000002';
const otherCommentId = '00000000-0000-4000-8000-000000000003';
const otherItemId = '00000000-0000-4000-8000-000000000004';
const attachmentId = 'attachment';
const path = '/discussion/attachment';

async function fixture(t, { bytes = Buffer.from('<script>window.active = true</script>') } = {}) {
  const { s, fake } = await setup(t);
  const endpoint = process.env.R2_ENDPOINT;
  process.env.R2_ENDPOINT = `https://${fake.host}`;
  t.after(() => {
    if (endpoint === undefined) delete process.env.R2_ENDPOINT;
    else process.env.R2_ENDPOINT = endpoint;
  });
  const project = projectRow({
    _id: 'project',
    name: 'synthetic',
    revision: 1,
    visibility: 'public',
    workStore: 'records',
    work: { generationId: 'current', backupId: 'backup', operationId: 'op', initialRevision: 1, revision: 1 },
  });
  s.tables.hostedProjects.set(project._id, project);
  s.tables.projectWorkGenerations.set('current', {
    _id: 'current',
    projectId: project._id,
    backupId: 'backup',
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
  });
  const item = { id: itemId, status: 'open', kind: 'issue' };
  const root = {
    _id: 'root',
    generationId: 'current',
    collection: 'planningSearch',
    key: itemId,
    value: JSON.stringify(item),
  };
  s.tables.projectPlanningRecords.set(root._id, root);
  const itemRecord = { ...root, _id: 'item', collection: 'planningItems' };
  const itemHead = {
    _id: 'head-item',
    projectId: project._id,
    kind: 'issue',
    key: itemId,
    status: item.status,
    value: root.value,
  };
  s.tables.projectPlanningRecords.set(itemRecord._id, itemRecord);
  s.tables.projectHostedRecordHeads.set(itemHead._id, itemHead);
  const addComment = (id, projectId = project._id) =>
    s.tables.projectHostedRecordHeads.set(`head-${projectId}-${id}`, {
      _id: `head-${projectId}-${id}`,
      projectId,
      kind: 'comment',
      key: id,
      parent: itemId,
      status: 'comment',
    });
  addComment(commentId);
  s.tables.projectPlanningRecords.set('legacy-comment', {
    _id: 'legacy-comment',
    generationId: 'current',
    collection: 'planningComments',
    key: commentId,
    parent: itemId,
  });
  const namespace = `v1/p/${project._id}/discussion/${itemId}/${commentId}`;
  const pin = pinOf(bytes);
  const artifact = {
    _id: attachmentId,
    namespace,
    r2Key: `${namespace}/a/${pin.digest}`,
    ...pin,
    contentType: 'text/html; charset=utf-8',
    committed: true,
    removed: false,
  };
  s.tables.artifactBlobs.set(attachmentId, artifact);
  const key = fake.key(artifact.r2Key);
  fake.objects.set(key, bytes);
  const member = { _id: 'membership', projectId: project._id, reader: 'reader' };
  s.tables.projectReaders.set(member._id, member);

  const stats = { calls: 0, lookups: 0, documents: 0, dbBytes: 0 };
  function measured(row) {
    stats.lookups++;
    if (row) {
      stats.documents++;
      stats.dbBytes += getDocumentSize(row);
    }
    return row;
  }
  const db = {
    ...s.ctx.db,
    get: async id => measured(await s.ctx.db.get(id)),
    query: table => ({
      withIndex: (...index) => ({
        unique: async () =>
          measured(
            await s.ctx.db
              .query(table)
              .withIndex(...index)
              .unique(),
          ),
      }),
    }),
  };
  for (const write of ['insert', 'patch', 'replace', 'delete']) {
    db[write] = () => assert.fail('A download must make no database writes');
  }
  function download({ viewer = 'owner', select = {}, beforeResolve, method = 'GET' } = {}) {
    const queryString = new URLSearchParams({
      projectId: project._id,
      itemId,
      commentId,
      attachmentId,
      ...select,
    });
    return http.lookup(path, method)[0]._handler(
      {
        runQuery: async (ref, args) => {
          assert.equal(getFunctionName(ref), 'discussionAttachmentRead:resolve');
          stats.calls++;
          beforeResolve?.(stats.calls);
          const auth = {
            getUserIdentity: async () => (typeof viewer === 'string' ? { subject: viewer } : viewer),
          };
          return resolve._handler({ ...s.ctx, db, auth }, args);
        },
      },
      new Request(`https://convex.fixture.invalid${path}?${queryString}`, { method }),
    );
  }
  const setItem = changes => {
    const current = { ...item, ...changes };
    root.value = itemRecord.value = itemHead.value = JSON.stringify(current);
    itemHead.status = current.status;
  };
  return { s, fake, project, artifact, addComment, key, bytes, download, stats, setItem };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-disposition'), null);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  assert.equal(body.code, code);
}

test('a public discussion returns exact HTML bytes with the stored MIME type and forced download headers', async t => {
  const f = await fixture(t);
  const response = await f.download({ viewer: 'visitor' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('content-length'), String(f.bytes.length));
  assert.equal(response.headers.get('content-disposition'), 'attachment');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  assert.deepEqual(
    f.fake.requests.map(r => [r.method, r.status]),
    [['GET', 200]],
  );
});

test('private, deleted, hidden and members-only discussions apply current read authority before R2', async t => {
  const f = await fixture(t);
  await expectError(await f.download({ viewer: null }), 404, 'PROJECT_UNAVAILABLE');
  f.project.visibility = 'private';
  assert.equal((await f.download({ viewer: 'reader' })).status, 200);
  await expectError(await f.download({ viewer: 'visitor' }), 404, 'PROJECT_UNAVAILABLE');
  f.project.visibility = 'public';
  f.project.planVisibility = 'members';
  await expectError(await f.download({ viewer: 'visitor' }), 404, 'NOT_FOUND');
  f.project.planVisibility = 'public';
  f.setItem({ hidden: true });
  await expectError(await f.download({ viewer: 'visitor' }), 404, 'NOT_FOUND');
  assert.equal((await f.download({ viewer: 'reader' })).status, 200);
  f.project.removal = 'deleted';
  await expectError(await f.download(), 404, 'PROJECT_UNAVAILABLE');
  assert.equal(f.fake.requests.length, 2);
});

test('foreign project and comment IDs, detached attachments and foreign keys never reach R2', async t => {
  const f = await fixture(t);
  f.addComment(otherCommentId);
  f.s.tables.hostedProjects.set('other-project', { ...f.project, _id: 'other-project' });
  f.s.tables.projectHostedRecordHeads.set('head-other-item', {
    ...f.s.tables.projectHostedRecordHeads.get('head-item'),
    _id: 'head-other-item',
    projectId: 'other-project',
  });
  f.addComment(commentId, 'other-project');
  await expectError(await f.download({ select: { projectId: 'other-project' } }), 404, 'NOT_FOUND');
  await expectError(await f.download({ select: { itemId: otherItemId } }), 404, 'NOT_FOUND');
  await expectError(await f.download({ select: { commentId: otherCommentId } }), 404, 'NOT_FOUND');
  await expectError(await f.download({ select: { attachmentId: 'unknown-attachment' } }), 404, 'NOT_FOUND');
  f.artifact.committed = false;
  await expectError(await f.download(), 404, 'NOT_FOUND');
  f.artifact.committed = true;
  f.artifact.removed = true;
  await expectError(await f.download(), 404, 'NOT_FOUND');
  f.artifact.removed = false;
  f.artifact.r2Key = f.artifact.r2Key.replace('/project/', '/other-project/');
  await expectError(await f.download(), 404, 'NOT_FOUND');
  assert.deepEqual(f.fake.requests, []);
});

test('revocation while bytes are in flight prevents delivery and future storage reads', async t => {
  const f = await fixture(t);
  f.project.visibility = 'private';
  await expectError(
    await f.download({
      viewer: 'reader',
      beforeResolve(calls) {
        if (calls === 2) {
          assert.equal(f.fake.requests.length, 1);
          f.s.tables.projectReaders.delete('membership');
        }
      },
    }),
    404,
    'PROJECT_UNAVAILABLE',
  );
  await expectError(await f.download({ viewer: 'reader' }), 404, 'PROJECT_UNAVAILABLE');
  assert.equal(f.fake.requests.length, 1);
});

test('a permanent Item tombstone blocks downloads while comment and attachment rows are retained', async t => {
  for (const workStore of ['records', 'journal']) {
    await t.test(workStore, async t => {
      const f = await fixture(t);
      if (workStore === 'journal') delete f.project.workStore;
      f.setItem({ status: 'deleted' });
      assert.equal((await f.download()).status, 200, 'A reversible deletion keeps member access');
      f.setItem({ status: 'deleted', purged: { operationId: 'purge' } });
      await expectError(await f.download(), 404, 'NOT_FOUND');
      assert.equal(f.fake.requests.length, 1);
    });
  }
});

test('HEAD does not resolve metadata or fetch an attachment', async t => {
  const f = await fixture(t);
  const response = await f.download({ method: 'HEAD' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.equal(f.stats.calls, 0);
  assert.equal(f.fake.requests.length, 0);
});

test('an owner’s revoked or project-scoped device cannot use the attachment route as another credential', async t => {
  const f = await fixture(t);
  const viewer = { subject: 'owner', forgeCredential: 'device-key' };
  const device = {
    _id: 'device',
    owner: viewer.subject,
    credentialId: viewer.forgeCredential,
    expiresAt: Number.MAX_SAFE_INTEGER,
    scope: 'cli',
    revoked: false,
    settings: { projects: { kind: 'project', projectId: 'other-project' }, source: 'read' },
  };
  f.s.tables.cliCredentials.set(device._id, device);
  await expectError(await f.download({ viewer }), 403, 'AUTH_SCOPE_DENIED');
  device.revoked = true;
  await expectError(await f.download({ viewer }), 401, 'AUTH_REVOKED');
  assert.deepEqual(f.fake.requests, []);
});

test('R2 failures, short and long reads, and wrong bytes yield only structured errors', async t => {
  const f = await fixture(t);
  f.fake.failGets = 1;
  await expectError(await f.download(), 502, 'R2_OBJECT_UNAVAILABLE');
  for (const data of [f.bytes.subarray(1), Buffer.concat([f.bytes, f.bytes]), Buffer.alloc(f.bytes.length)]) {
    f.fake.objects.set(f.key, data);
    await expectError(await f.download(), 502, 'BLOB_DIGEST_MISMATCH');
  }
  assert.equal(f.fake.requests.length, 4);
  assert.equal(f.stats.calls, 4, 'Only verified bytes reach the release check');
});

test('the journal-backed discussion resolves the same exact comment and fails if its generation loses it', async t => {
  const f = await fixture(t);
  delete f.project.workStore;
  assert.equal((await f.download({ viewer: 'visitor' })).status, 200);
  f.s.tables.projectPlanningRecords.delete('legacy-comment');
  await expectError(await f.download({ viewer: 'visitor' }), 404, 'NOT_FOUND');
  assert.equal(f.fake.requests.length, 1);
});

test('one and two MB downloads do constant metadata work with zero idle calls', async t => {
  for (const size of [1_000_000, 2_000_000]) {
    await t.test(String(size), async t => {
      const f = await fixture(t, { bytes: Buffer.alloc(size, 42) });
      assert.equal(f.stats.calls, 0);
      assert.equal(f.fake.requests.length, 0);
      const started = performance.now();
      const before = process.memoryUsage();
      const response = await f.download({ viewer: 'visitor' });
      assert.equal(response.status, 200);
      const body = Buffer.from(await response.arrayBuffer());
      const after = process.memoryUsage();
      const elapsed = performance.now() - started;
      assert.deepEqual(body, f.bytes);
      assert.equal(f.fake.requests.length, 1);
      assert.deepEqual(
        { calls: f.stats.calls, lookups: f.stats.lookups, documents: f.stats.documents },
        { calls: 2, lookups: 16, documents: 12 },
      );
      t.diagnostic(
        JSON.stringify({
          ...f.stats,
          bytesFromR2: size,
          bytesToClient: body.length,
          wallMs: Math.round(elapsed * 100) / 100,
          rssDeltaBytes: after.rss - before.rss,
          processPeakRssKiB: process.resourceUsage().maxRSS,
        }),
      );
    });
  }
});
