// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Discussion attachment uploads (Item 9a3d6f5f): prepare, the PUT to R2, commit, the comment that names the file,
// the download that follows, and every refusal on the way (a stranger, a wrong size, an unprepared file, a full
// project, an abandoned upload). The R2 bucket is a local stand-in; nothing leaves this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './hosted-planning-fixture.mjs';
import { startFakeR2, fakeR2Config } from './fake-r2.mjs';
import { moduleUrl } from './convex-module.mjs';

const { uploadDiscussionFiles } = await import('../dist/hosted-agent-planning-attach.js');
const upload = await import(moduleUrl('../convex/discussionAttachmentUpload.ts'));
const read = await import(moduleUrl('../convex/discussionAttachmentRead.ts'));
const caps = await import(moduleUrl('../convex/discussionAttachmentCaps.ts'));
const storage = await import(moduleUrl('../convex/artifactStorage.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const workCommand = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const { default: http } = await import(moduleUrl('../convex/http.ts'));
const { ATTACHMENT_LIMITS } = await import(moduleUrl('../src/discussion-attachment-limits.ts'));
const modules = {
  discussionAttachmentUpload: upload,
  discussionAttachmentRead: read,
  discussionAttachmentCaps: caps,
  artifactStorage: storage,
};

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(1000, 7),
]);

async function fixture(t) {
  const fake = await startFakeR2();
  const restore = fake.install();
  const saved = [
    'CONVEX_CLOUD_URL',
    'R2_ACCOUNT_ID',
    'R2_BUCKET',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_ENDPOINT',
  ].map(name => [name, process.env[name]]);
  const names = {
    accountId: 'R2_ACCOUNT_ID',
    bucket: 'R2_BUCKET',
    accessKeyId: 'R2_ACCESS_KEY_ID',
    secretAccessKey: 'R2_SECRET_ACCESS_KEY',
  };
  for (const [field, name] of Object.entries(names)) process.env[name] = fakeR2Config[field];
  process.env.CONVEX_CLOUD_URL = 'https://example.convex.cloud';
  process.env.R2_ENDPOINT = `https://${fake.host}`;
  t.after(async () => {
    restore();
    await fake.close?.();
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const s = await setup(t);
  s.tables.hostedProjects.set('project', {
    ...s.tables.hostedProjects.get('project'),
    visibility: 'private',
  });
  const item = s.item({ title: 'Synthetic Item', body: 'Intro.' });
  await s.send(item);
  const as = subject => {
    s.ctx.auth.getUserIdentity = async () => (subject ? { subject } : null);
  };
  as('owner');
  // Public function names dispatch to the module handlers; the same context carries the caller's sign-in.
  const dispatch = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    const fn = modules[module]?.[name];
    assert.ok(fn, `unexpected call ${module}:${name}`);
    return fn._handler({ ...s.ctx, runQuery: dispatch, runMutation: dispatch, runAction: dispatch }, args);
  };
  const ctx = { ...s.ctx, runQuery: dispatch, runMutation: dispatch, runAction: dispatch };
  const prepare = (commentId, file, patch = {}) =>
    upload.prepare._handler(s.ctx, {
      projectId: 'project',
      itemId: item.itemId,
      commentId,
      name: file.name ?? 'screenshot.png',
      size: file.bytes.length,
      contentType: file.contentType ?? 'image/png',
      digest: sha(file.bytes),
      ...patch,
    });
  const put = async target => {
    const response = await fetch(target.url, { method: 'PUT', headers: target.headers, body: target.body });
    assert.ok(response.ok, `PUT ${response.status}`);
  };
  const commit = (commentId, attachmentId) =>
    upload.commit._handler(ctx, { projectId: 'project', itemId: item.itemId, commentId, attachmentId });
  /** The whole client sequence for one file: prepare, PUT, commit. */
  const send = async (commentId, file, patch) => {
    const prepared = await prepare(commentId, file, patch);
    if (prepared.put) await put({ ...prepared.put, body: file.bytes });
    await commit(commentId, prepared.attachment.id);
    return prepared.attachment;
  };
  const comment = (operationId, attachments, text = 'See attached.') =>
    workCommand.command._handler(s.ctx, {
      projectId: 'project',
      operationId,
      command: JSON.stringify({
        action: 'comment-planning-item',
        operationId,
        itemId: item.itemId,
        text,
        ...(attachments ? { attachments } : {}),
      }),
    });
  const comments = async () => {
    const page = await index.records._handler(s.ctx, {
      projectId: 'project',
      collection: 'planningComments',
      parentId: item.itemId,
      paginationOpts: { numItems: 100, cursor: null },
    });
    return page.page.map(row => JSON.parse(row.value));
  };
  const download = (commentId, attachmentId) =>
    http
      .lookup('/discussion/attachment', 'GET')[0]
      ._handler(
        { ...s.ctx, runQuery: dispatch, runMutation: dispatch },
        new Request(
          `https://convex.fixture.invalid/discussion/attachment?${new URLSearchParams({ projectId: 'project', itemId: item.itemId, commentId, attachmentId })}`,
        ),
      );
  const stored = () =>
    [...s.tables.gitWorkerUsage.values()].find(row => row.scope === 'attachments-stored:project');
  // The CLI's view of the same server: its mutation and action calls reach these handlers.
  const port = {
    address: { projectId: 'project' },
    mutation: async (name, args) => {
      assert.equal(name, 'discussionAttachmentUpload:prepare');
      return upload.prepare._handler(s.ctx, { projectId: 'project', ...args });
    },
    exchange: { client: { action: async (ref, args) => upload.commit._handler(ctx, args) } },
  };
  return { s, fake, port, item, as, prepare, put, commit, send, comment, comments, download, stored, ctx };
}

test('an owner uploads an image, names it in a comment, and reads the same bytes back', async t => {
  const f = await fixture(t);
  const commentId = randomUUID();
  const attachment = await f.send(commentId, { bytes: png });
  assert.deepEqual(
    { ...attachment, id: undefined },
    { id: undefined, name: 'screenshot.png', size: png.length, contentType: 'image/png' },
  );
  await f.comment(commentId, [attachment]);
  const [row] = await f.comments();
  assert.deepEqual(row.attachments, [attachment]);
  const response = await f.download(commentId, attachment.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-disposition'), 'attachment');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(f.stored().bytes, png.length, 'the project allowance counts the file once');
});

test('an unauthorized reader is refused before any R2 read, and so is a stranger trying to upload', async t => {
  const f = await fixture(t);
  const commentId = randomUUID();
  const attachment = await f.send(commentId, { bytes: png });
  await f.comment(commentId, [attachment]);
  f.fake.requests.length = 0;
  f.as('stranger');
  assert.equal((await f.download(commentId, attachment.id)).status, 404);
  assert.deepEqual(f.fake.requests, [], 'a refused reader costs no storage read');
  await assert.rejects(f.prepare(randomUUID(), { bytes: png }), /PROJECT_UNAVAILABLE|unavailable/i);
  f.as(null);
  assert.equal((await f.download(commentId, attachment.id)).status, 404);
});

test('limits: 10 MB per image, 25 MB per file, four files per comment, 1 GB per project; a refusal reserves nothing', async t => {
  const f = await fixture(t);
  const commentId = randomUUID();
  const digest = 'a'.repeat(64);
  const before = f.s.tables.artifactBlobs.size;
  await assert.rejects(
    f.prepare(commentId, { bytes: png }, { size: ATTACHMENT_LIMITS.imageBytes + 1, digest }),
    /at most 10 MB/,
  );
  await assert.rejects(
    f.prepare(
      commentId,
      { bytes: png, contentType: 'application/pdf', name: 'a.pdf' },
      { size: ATTACHMENT_LIMITS.fileBytes + 1, digest },
    ),
    /at most 25 MB/,
  );
  await assert.rejects(f.prepare(commentId, { bytes: png }, { size: 0 }), /exact size/);
  await assert.rejects(f.prepare(commentId, { bytes: png }, { digest: 'xyz' }), /exact size/);
  // A 25 MB PDF and a 10 MB image are within their limits (checked at prepare, nothing uploaded).
  assert.ok(
    (
      await f.prepare(
        commentId,
        { bytes: png, contentType: 'application/pdf', name: 'a.pdf' },
        { size: ATTACHMENT_LIMITS.fileBytes, digest },
      )
    ).put,
  );
  assert.equal(f.s.tables.artifactBlobs.size, before + 1);
  const other = randomUUID();
  for (let n = 0; n < ATTACHMENT_LIMITS.perComment; n++)
    await f.prepare(other, { bytes: Buffer.from(`file ${n}`), contentType: 'text/plain', name: `${n}.txt` });
  await assert.rejects(
    f.prepare(other, { bytes: Buffer.from('one more'), contentType: 'text/plain', name: 'x.txt' }),
    /at most 4 files/,
  );
  const used = f.stored().bytes;
  f.stored().bytes = ATTACHMENT_LIMITS.projectBytes - 10;
  await assert.rejects(f.prepare(randomUUID(), { bytes: png }), /1 GB of discussion attachments/);
  assert.ok(used > 0);
});

test('a comment can name only files committed for that comment; the server sets size and type', async t => {
  const f = await fixture(t);
  const commentId = randomUUID();
  const attachment = await f.send(commentId, { bytes: png });
  // Another comment cannot borrow it.
  await assert.rejects(f.comment(randomUUID(), [attachment]), /uploaded and committed for this comment/);
  // A file prepared and PUT but never committed is refused.
  const pending = await f.prepare(commentId, {
    bytes: Buffer.from('later'),
    contentType: 'text/plain',
    name: 'later.txt',
  });
  await assert.rejects(f.comment(commentId, [pending.attachment]), /committed/);
  // An invented id is refused.
  await assert.rejects(f.comment(commentId, [{ ...attachment, id: 'nope' }]), /committed/);
  // The same file twice is refused; lying about size, type or name changes only what the client typed.
  await assert.rejects(f.comment(commentId, [attachment, attachment]), /committed/);
  await f.comment(commentId, [
    { ...attachment, size: 5, contentType: 'text/html', name: '../../etc/pass‮wd.png' },
  ]);
  const [row] = await f.comments();
  assert.deepEqual(row.attachments, [{ ...attachment, name: 'pass‮wd.png'.replace('‮', '') }]);
});

test('commit refuses bytes that are not the prepared object, and a retried upload is a no-op', async t => {
  const f = await fixture(t);
  const commentId = randomUUID();
  const prepared = await f.prepare(commentId, { bytes: png });
  // Nothing was PUT: R2 has no object, so the commit is refused and the binding stays uncommitted.
  await assert.rejects(f.commit(commentId, prepared.attachment.id), /missing|R2_OBJECT_MISSING/i);
  await f.put({ ...prepared.put, body: png });
  await f.commit(commentId, prepared.attachment.id);
  await f.commit(commentId, prepared.attachment.id);
  // A second prepare of the committed file hands back no upload target.
  assert.equal((await f.prepare(commentId, { bytes: png })).put, undefined);
  assert.equal(f.stored().bytes, png.length, 'a retry is not charged twice');
  // A PUT with other bytes under the signed target is refused by R2 itself (signed length and checksum).
  const other = await f.prepare(commentId, {
    bytes: Buffer.from('abc'),
    contentType: 'text/plain',
    name: 'a.txt',
  });
  const wrong = await fetch(other.put.url, {
    method: 'PUT',
    headers: other.put.headers,
    body: Buffer.from('xyz'),
  });
  assert.ok(!wrong.ok);
});

test('an upload whose comment never arrives is removed and gives its bytes back; a used one stays', async t => {
  const f = await fixture(t);
  const kept = randomUUID();
  const dropped = randomUUID();
  const keptFile = await f.send(kept, { bytes: png });
  const droppedFile = await f.send(dropped, {
    bytes: Buffer.from('abandoned'),
    contentType: 'text/plain',
    name: 'x.txt',
  });
  await f.comment(kept, [keptFile]);
  assert.equal(f.stored().bytes, png.length + 9);
  const sweep = id =>
    upload.sweep._handler(f.s.ctx, {
      projectId: 'project',
      itemId: f.item.itemId,
      commentId: id[0],
      attachmentId: id[1],
    });
  await sweep([kept, keptFile.id]);
  await sweep([dropped, droppedFile.id]);
  assert.equal(f.s.tables.artifactBlobs.get(keptFile.id).removed, false);
  assert.equal(f.s.tables.artifactBlobs.get(droppedFile.id).removed, true);
  assert.equal(f.stored().bytes, png.length, 'the abandoned file no longer counts');
  assert.equal((await f.download(dropped, droppedFile.id)).status, 404);
  await sweep([dropped, droppedFile.id]);
  assert.equal(f.stored().bytes, png.length, 'a second sweep gives nothing back twice');
});

/** Counts the database work of one step: documents read, queries, documents written, scheduled calls, R2 requests. */
async function measured(f, step) {
  const db = f.s.ctx.db,
    original = { ...db };
  const m = { queries: 0, gets: 0, documents: 0, writes: 0, scheduled: 0, r2: 0 };
  db.get = async id => (m.gets++, m.documents++, original.get(id));
  db.query = table => {
    const query = original.query(table);
    const wrap = query2 =>
      new Proxy(query2, {
        get(target, key) {
          const value = target[key];
          if (key === 'withIndex') return (...a) => (m.queries++, wrap(value.apply(target, a)));
          if (key === 'unique') return async () => ((m.documents += 1), value.apply(target));
          if (key === 'take')
            return async n => {
              const rows = await value.call(target, n);
              m.documents += rows.length;
              return rows;
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    return wrap(query);
  };
  for (const write of ['insert', 'patch', 'replace', 'delete'])
    db[write] = async (...a) => (m.writes++, original[write](...a));
  const scheduler = f.s.ctx.scheduler.runAfter;
  f.s.ctx.scheduler.runAfter = async (...a) => (m.scheduled++, scheduler(...a));
  const before = f.fake.requests.length;
  try {
    await step();
  } finally {
    Object.assign(db, original);
    f.s.ctx.scheduler.runAfter = scheduler;
  }
  m.r2 = f.fake.requests.length - before;
  return m;
}

test('measured at 1 KB and 1 MB: calls and database work per upload and per read are the same, idle is zero', async t => {
  const f = await fixture(t);
  const rows = {};
  for (const [label, bytes] of [
    ['1 KB', Buffer.alloc(1024, 1)],
    ['1 MB', Buffer.alloc(1_000_000, 2)],
  ]) {
    const commentId = randomUUID();
    const file = { bytes, contentType: 'image/png', name: 'a.png' };
    let prepared;
    const prepare = await measured(f, async () => (prepared = await f.prepare(commentId, file)));
    await f.put({ ...prepared.put, body: bytes });
    const commit = await measured(f, () => f.commit(commentId, prepared.attachment.id));
    const comment = await measured(f, () => f.comment(commentId, [prepared.attachment]));
    const plain = await measured(f, () => f.comment(randomUUID(), undefined));
    let response;
    const download = await measured(
      f,
      async () => (response = await f.download(commentId, prepared.attachment.id)),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, bytes.length);
    rows[label] = { prepare, commit, comment, plain, download };
    t.diagnostic(`${label} ${JSON.stringify(rows[label])}`);
  }
  // The first download of a UTC day also creates that day's two counter rows (and prunes), whatever the size.
  const { queries: _, ...day1 } = rows['1 KB'].download,
    { queries: __, ...day2 } = rows['1 MB'].download;
  assert.deepEqual({ ...rows['1 KB'], download: day1 }, { ...rows['1 MB'], download: day2 });
  const attached = rows['1 MB'];
  assert.equal(
    attached.comment.gets - attached.plain.gets,
    1,
    'a file adds one binding read to the comment it names',
  );
  const { prepare, commit } = rows['1 MB'];
  assert.equal(prepare.scheduled, 1, 'one clean-up task per new file');
  assert.equal(prepare.r2, 0, 'prepare signs locally and makes no R2 request');
  assert.equal(commit.r2, 1, 'commit is one R2 HEAD');
  // An idle open discussion makes no call: nothing here is polled or scheduled after the last step.
  const idle = await measured(f, async () => {});
  assert.deepEqual(idle, { queries: 0, gets: 0, documents: 0, writes: 0, scheduled: 0, r2: 0 });
});

test('the CLI uploads local files for a comment: bytes stored, names cleaned, limits checked before a byte is read', async t => {
  const f = await fixture(t);
  const dir = join(f.s.directory, 'attachments');
  mkdirSync(dir);
  const shot = join(dir, 'shot.png');
  const notes = join(dir, 'notes.pdf');
  writeFileSync(shot, png);
  writeFileSync(notes, 'plain bytes');
  const commentId = randomUUID();
  const attached = await uploadDiscussionFiles(f.port, f.item.itemId, commentId, [shot, notes]);
  assert.deepEqual(
    attached.map(({ name, size, contentType }) => ({ name, size, contentType })),
    [
      { name: 'shot.png', size: png.length, contentType: 'image/png' },
      { name: 'notes.pdf', size: 11, contentType: 'application/pdf' },
    ],
  );
  await f.comment(commentId, attached);
  for (const [attachment, bytes] of [
    [attached[0], png],
    [attached[1], Buffer.from('plain bytes')],
  ]) {
    const response = await f.download(commentId, attachment.id);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  // A retry of the same comment prepares the same objects again and uploads nothing twice.
  const puts = f.fake.requests.filter(r => r.method === 'PUT').length;
  assert.deepEqual(await uploadDiscussionFiles(f.port, f.item.itemId, commentId, [shot]), [attached[0]]);
  assert.equal(f.fake.requests.filter(r => r.method === 'PUT').length, puts);
  // Refusals name the file and read nothing: a missing path, a folder, a link, an empty file, an over-size image.
  const folder = join(dir, 'folder');
  mkdirSync(folder);
  const link = join(dir, 'link.png');
  symlinkSync(shot, link);
  const empty = join(dir, 'empty.txt');
  writeFileSync(empty, '');
  const big = join(dir, 'big.png');
  writeFileSync(big, '');
  truncateSync(big, ATTACHMENT_LIMITS.imageBytes + 1);
  for (const [path, message] of [
    [join(dir, 'missing.png'), /missing\.png is not a regular file/],
    [folder, /folder is not a regular file/],
    [link, /link\.png is not a regular file/],
    [empty, /empty\.txt must be 1 byte to 25 MB/],
    [big, /big\.png must be 1 byte to 10 MB/],
  ])
    await assert.rejects(uploadDiscussionFiles(f.port, f.item.itemId, randomUUID(), [path]), message);
  await assert.rejects(
    uploadDiscussionFiles(f.port, f.item.itemId, randomUUID(), [shot, shot, shot, shot, shot]),
    /at most 4 files/,
  );
});

test('a file at the 25 MB maximum goes up and comes back byte for byte', async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(ATTACHMENT_LIMITS.fileBytes);
  for (let at = 0; at < bytes.length; at += 4) bytes.writeUInt32LE((at * 2654435761) >>> 0, at);
  const commentId = randomUUID();
  const file = { bytes, contentType: 'application/octet-stream', name: 'max.bin' };
  const began = performance.now();
  const attachment = await f.send(commentId, file);
  const uploaded = performance.now() - began;
  await f.comment(commentId, [attachment]);
  const downloaded = performance.now();
  const response = await f.download(commentId, attachment.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(bytes));
  t.diagnostic(
    `25 MB: upload ${Math.round(uploaded)} ms, download ${Math.round(performance.now() - downloaded)} ms (fixture, loopback)`,
  );
  assert.equal(f.stored().bytes, ATTACHMENT_LIMITS.fileBytes);
});
