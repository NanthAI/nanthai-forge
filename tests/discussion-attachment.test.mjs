// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { getDocumentSize } from 'convex/values';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
import { projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { pinOf, setup } from './r2-harness.mjs';

const { default: http } = await import(moduleUrl('../convex/http.ts'));
const { resolve } = await import(moduleUrl('../convex/discussionAttachmentRead.ts'));
const caps = await import(moduleUrl('../convex/discussionAttachmentCaps.ts'));
const { attachmentDownloadCaps } = await import(moduleUrl('../convex/gitServeWorkerStore.ts'));
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

  const stats = { calls: 0, lookups: 0, documents: 0, dbBytes: 0, mutations: 0, capReads: 0, capWrites: 0 };
  // A fixed clock keeps UTC-day keys stable, and lets a test cross 00:00 UTC without waiting.
  // Only the cap mutation sees it: presigned R2 URLs need the real time.
  const clock = { now: Date.parse('2026-11-22T12:00:00Z') };
  s.tables.gitWorkerUsage ??= new Map();
  // Convex runs mutations one at a time: the fixture serializes them the same way, while
  // queries and R2 reads of concurrent downloads still interleave.
  let mutationQueue = Promise.resolve();
  const capDb = {
    ...s.ctx.db,
    query: table => ({
      withIndex: (...index) => {
        const read = s.ctx.db.query(table).withIndex(...index);
        return {
          unique: async () => (stats.capReads++, read.unique()),
          take: async n => (stats.capReads++, read.take(n)),
        };
      },
    }),
  };
  for (const write of ['insert', 'patch', 'delete'])
    capDb[write] = async (...args) => (stats.capWrites++, s.ctx.db[write](...args));
  const runMutation = (ref, args) => {
    const name = getFunctionName(ref);
    const run = mutationQueue.then(() => {
      assert.match(name, /^discussionAttachmentCaps:(reserve|release)$/);
      stats.mutations++;
      // The handler reads the time before its first await.
      const frozen = t.mock.method(Date, 'now', () => clock.now);
      try {
        return caps[name.split(':')[1]]._handler({ ...s.ctx, db: capDb }, args);
      } finally {
        frozen.mock.restore();
      }
    });
    mutationQueue = run.catch(() => {});
    return run;
  };
  const usage = () =>
    Object.fromEntries(
      [...s.tables.gitWorkerUsage.values()].map(row => [`${row.scope}@${row.day}`, [row.packs, row.bytes]]),
    );
  const seedUsage = (scope, bytes, day = '2026-11-22', packs = 1) => {
    for (const [id, row] of s.tables.gitWorkerUsage)
      if (row.scope === scope && row.day === day) s.tables.gitWorkerUsage.delete(id);
    s.tables.gitWorkerUsage.set(`${scope}@${day}`, {
      _id: `${scope}@${day}`,
      _creationTime: 1,
      scope,
      day,
      packs,
      bytes,
    });
  };
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
    db[write] = () => assert.fail('The metadata queries must make no database writes');
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
        runMutation,
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
  return {
    s,
    fake,
    project,
    artifact,
    addComment,
    key,
    bytes,
    download,
    stats,
    setItem,
    clock,
    usage,
    seedUsage,
  };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-disposition'), null);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  assert.equal(body.code, code);
  return body;
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
      // One extra mutation: two indexed reads and two first-use inserts (each insert prunes by one more read).
      assert.deepEqual(
        { mutations: f.stats.mutations, reads: f.stats.capReads, writes: f.stats.capWrites },
        { mutations: 1, reads: 4, writes: 2 },
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

test('the approved 25 MB download delivers its exact byte length and SHA-256', async t => {
  const size = 25_000_000;
  const bytes = Buffer.alloc(size, 42);
  bytes[0] = 0;
  bytes[size - 1] = 255;
  const f = await fixture(t, { bytes });
  const started = performance.now();
  const response = await f.download({ viewer: 'visitor' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(size));
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    hash.update(chunk);
  }
  const sha256 = hash.digest('hex');
  assert.equal(length, size);
  assert.equal(sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(f.stats.calls, 2);
  assert.deepEqual(
    f.fake.requests.map(r => [r.method, r.status]),
    [['GET', 200]],
  );
  t.diagnostic(
    JSON.stringify({
      ...f.stats,
      bytesFromR2: size,
      bytesToClient: length,
      sha256,
      wallMs: Math.round((performance.now() - started) * 100) / 100,
      processPeakRssKiB: process.resourceUsage().maxRSS,
    }),
  );
});

const project = 'attachments:project';
const everyone = 'attachments:*';
const projectCap = attachmentDownloadCaps.project;
const allCap = attachmentDownloadCaps.all;

async function expectLimit(response, scope) {
  const { message } = await expectError(response, 429, 'ATTACHMENT_DOWNLOAD_LIMIT');
  assert.match(message, scope === 'project' ? /this project \(2 GB\)/ : /all projects \(5 GB\)/);
  assert.match(message, /00:00 UTC/);
}

test('a download under both daily caps is charged once to its project and to all projects', async t => {
  const f = await fixture(t);
  assert.equal((await f.download({ viewer: 'visitor' })).status, 200);
  const size = f.bytes.length;
  assert.deepEqual(f.usage(), {
    [`${project}@2026-11-22`]: [1, size],
    [`${everyone}@2026-11-22`]: [1, size],
  });
  f.seedUsage(project, projectCap - size);
  assert.equal((await f.download({ viewer: 'visitor' })).status, 200, 'Bytes up to the cap are allowed');
  assert.equal(f.usage()[`${project}@2026-11-22`][1], projectCap);
});

test('a denied or missing attachment never spends the daily caps', async t => {
  const f = await fixture(t);
  await expectError(await f.download({ viewer: null }), 404, 'PROJECT_UNAVAILABLE');
  await expectError(await f.download({ select: { attachmentId: 'unknown-attachment' } }), 404, 'NOT_FOUND');
  assert.equal(f.stats.mutations, 0);
  assert.deepEqual(f.usage(), {});
});

test('the project cap refuses with its name, the reset time and no R2 read, and refuses nothing else', async t => {
  const f = await fixture(t);
  const size = f.bytes.length;
  f.seedUsage(project, projectCap - size + 1);
  const refused = await f.download({ viewer: 'visitor' });
  await expectLimit(refused, 'project');
  assert.equal(refused.headers.get('retry-after'), String(12 * 3600));
  assert.equal(f.fake.requests.length, 0, 'The cap is checked before R2');
  assert.deepEqual(
    f.usage(),
    { [`${project}@2026-11-22`]: [1, projectCap - size + 1] },
    'A refusal charges nothing',
  );
  // Another project's use does not count against this one.
  f.seedUsage(project, 0);
  f.seedUsage('attachments:other-project', projectCap);
  assert.equal((await f.download({ viewer: 'visitor' })).status, 200);
});

test('the all-projects cap refuses even when this project has room', async t => {
  const f = await fixture(t);
  f.seedUsage(everyone, allCap - f.bytes.length + 1);
  await expectLimit(await f.download({ viewer: 'visitor' }), 'all');
  assert.equal(f.fake.requests.length, 0);
  assert.deepEqual(f.usage(), { [`${everyone}@2026-11-22`]: [1, allCap - f.bytes.length + 1] });
});

test('the caps start over at 00:00 UTC by day key and old day rows are pruned when a new one is written', async t => {
  const f = await fixture(t);
  f.seedUsage(project, projectCap);
  f.seedUsage(everyone, allCap);
  f.seedUsage(project, 5, '2026-11-01');
  f.clock.now = Date.parse('2026-11-22T23:59:59Z');
  const refused = await f.download({ viewer: 'visitor' });
  await expectLimit(refused, 'project');
  assert.equal(refused.headers.get('retry-after'), '1');
  f.clock.now = Date.parse('2026-11-23T00:00:00Z');
  assert.equal((await f.download({ viewer: 'visitor' })).status, 200);
  const size = f.bytes.length;
  assert.deepEqual(f.usage(), {
    [`${project}@2026-11-22`]: [1, projectCap],
    [`${everyone}@2026-11-22`]: [1, allCap],
    [`${project}@2026-11-23`]: [1, size],
    [`${everyone}@2026-11-23`]: [1, size],
  });
  assert.equal(
    f.stats.capWrites,
    3,
    'Two new day rows and the one 22-day-old row deleted; nothing else is touched',
  );
});

test('two downloads racing for the last bytes: one is served and one refused, with a single R2 read', async t => {
  const f = await fixture(t);
  f.seedUsage(project, projectCap - f.bytes.length);
  const responses = await Promise.all([f.download({ viewer: 'visitor' }), f.download({ viewer: 'visitor' })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 429]);
  assert.equal(f.fake.requests.length, 1);
  assert.equal(f.usage()[`${project}@2026-11-22`][1], projectCap);
  assert.equal(f.stats.mutations, 2, 'One reservation per download, no refund');
});

test('a failed, mismatched or revoked read gives its reservation back, so retries are not charged twice', async t => {
  const f = await fixture(t);
  const none = { [`${project}@2026-11-22`]: [0, 0], [`${everyone}@2026-11-22`]: [0, 0] };
  f.fake.failGets = 1;
  await expectError(await f.download({ viewer: 'visitor' }), 502, 'R2_OBJECT_UNAVAILABLE');
  assert.deepEqual(f.usage(), none);
  f.fake.objects.set(f.key, Buffer.alloc(f.bytes.length));
  await expectError(await f.download({ viewer: 'visitor' }), 502, 'BLOB_DIGEST_MISMATCH');
  assert.deepEqual(f.usage(), none);
  f.fake.objects.set(f.key, f.bytes);
  f.project.visibility = 'private';
  const before = f.stats.calls;
  await expectError(
    await f.download({
      viewer: 'reader',
      beforeResolve(calls) {
        if (calls === before + 2) f.s.tables.projectReaders.delete('membership');
      },
    }),
    404,
    'PROJECT_UNAVAILABLE',
  );
  assert.deepEqual(f.usage(), none);
  assert.equal(f.stats.mutations, 6, 'Each failed download is one reservation and one refund');
});

test('a refund after 00:00 UTC returns the bytes to the day that was charged', async t => {
  const f = await fixture(t);
  f.project.visibility = 'private';
  const response = await f.download({
    viewer: 'reader',
    beforeResolve(calls) {
      if (calls !== 2) return;
      f.clock.now = Date.parse('2026-11-23T00:00:01Z');
      f.s.tables.projectReaders.delete('membership');
    },
  });
  await expectError(response, 404, 'PROJECT_UNAVAILABLE');
  assert.deepEqual(f.usage(), {
    [`${project}@2026-11-22`]: [0, 0],
    [`${everyone}@2026-11-22`]: [0, 0],
  });
});
