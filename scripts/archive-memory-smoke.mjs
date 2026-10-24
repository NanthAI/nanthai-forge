// SPDX-License-Identifier: Apache-2.0
// Optional private acceptance: no target execution, provider write or committed archive.
// Build first, then: node --max-old-space-size=128 scripts/archive-memory-smoke.mjs /private/export.tar.gz
import assert from 'node:assert/strict';
import { createReadStream, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from '../tests/convex-module.mjs';
const { projectArchiveMetadata } = await import(moduleUrl('../convex/projectArchiveMetadata.ts'));
const returns = await import(moduleUrl('../convex/projectSourceReturn.ts'));
const { digest } = await import('../dist/hash.js');

const path = process.argv[2];
assert.ok(path, 'Pass a private Forge archive path.');
const size = statSync(path).size,
  hash = createHash('sha256');
for await (const bytes of createReadStream(path)) hash.update(bytes);
const archiveSha256 = hash.digest('hex');
let requests = 0,
  streamedBytes = 0,
  currentBytes = 0,
  peakRss = process.memoryUsage().rss;
const sample = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 5);
const server = createServer((request, response) => {
  requests++;
  response.setHeader('content-length', String(size));
  const input = createReadStream(path, { highWaterMark: 64 * 1024 });
  input.on('data', chunk => {
    streamedBytes += chunk.length;
  });
  response.on('close', () => input.destroy());
  input.pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/archive`;
const ctx = {
  auth: { getUserIdentity: async () => ({ subject: 'synthetic-owner' }) },
  storage: {
    get: () => {
      throw Error('Full archive buffering is forbidden in this fixture');
    },
    getMetadata: async () => ({ size, sha256: archiveSha256 }),
    getUrl: async () => url,
  },
};
try {
  const metadata = await projectArchiveMetadata(
    ctx,
    'synthetic-storage',
    size,
    archiveSha256,
    async () => undefined,
  );
  const manifest = JSON.parse(Buffer.from(metadata.manifest)),
    originalWork = JSON.parse(Buffer.from(metadata.work));
  const workFile = manifest.files.find(file => file.path === 'work.json');
  assert.equal(digest(metadata.work), workFile.sha256);
  assert.equal(metadata.work.length, workFile.size);
  const project = {
    _id: 'synthetic-project',
    owner: 'synthetic-owner',
    key: randomUUID(),
    name: 'Private memory acceptance',
    work: { backupId: 'previous', initialRevision: manifest.revision, revision: manifest.revision },
    currentBackup: 'previous',
  };
  const item = id => ({
    backup: {
      _id: id,
      projectId: project._id,
      status: 'stored',
      storageId: 'synthetic-storage',
      size,
      digest: archiveSha256,
      preview: { manifestDigest: digest(metadata.manifest) },
    },
    project,
  });
  let receipt = null,
    mutations = 0;
  ctx.runQuery = async (ref, args) => {
    switch (getFunctionName(ref)) {
      case 'projectWork:owner':
      case 'projectWork:get':
        return project;
      case 'projectBackups:get':
        return item(args.id);
      case 'projectWork:find':
        return receipt;
      case 'projectWork:events':
        return { page: [], isDone: true, continueCursor: '' };
      default:
        throw Error('Unexpected synthetic query');
    }
  };
  ctx.runMutation = async (ref, args) => {
    assert.equal(getFunctionName(ref), 'projectWork:returnSource');
    mutations++;
    assert.equal(args.expectedRevision, manifest.revision);
    assert.equal(args.localRevision, manifest.revision);
    assert.equal(args.expectedBackupId, 'previous');
    assert.equal(args.backupId, 'candidate');
    receipt = {
      operationId: args.operationId,
      request: args.request,
      command: args.command,
      previousRevision: args.localRevision,
    };
    project.currentBackup = args.backupId;
    return receipt;
  };
  const input = {
    projectId: project._id,
    backupId: 'candidate',
    expectedBackupId: 'previous',
    revision: manifest.revision,
    operationId: randomUUID(),
  };
  const returned = await returns.returnSource._handler(ctx, input),
    requestsAfterReturn = requests;
  assert.equal(project.currentBackup, 'candidate');
  assert.equal(mutations, 1);
  const retried = await returns.returnSource._handler(ctx, input);
  assert.deepEqual(retried, returned);
  assert.equal(requests, requestsAfterReturn);
  assert.equal(mutations, 1);
  assert.equal(
    JSON.parse(returned.command).workSha256,
    digest(
      (await import('../dist/work-metadata.js')).workBytes(
        (await import('../dist/work-metadata.js')).parseWorkBytes(metadata.work),
      ),
    ),
  );
  assert.equal(JSON.parse(returned.command).archiveSha256, archiveSha256);
  currentBytes = metadata.manifest.length + metadata.work.length;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const maximumRss = Math.max(peakRss, process.resourceUsage().maxRSS * 1024);
  assert.ok(
    maximumRss < 512 * 1024 * 1024,
    `Peak RSS ${maximumRss} exceeds the current 512 MiB provider ceiling.`,
  );
  console.log(
    JSON.stringify({
      runtime: process.version,
      archiveBytes: size,
      archiveSha256,
      manifestBytes: metadata.manifest.length,
      workBytes: metadata.work.length,
      workSchema: originalWork.schema,
      workRevision: originalWork.revision,
      sourceFiles: manifest.files.length,
      metadataBytes: currentBytes,
      streamedBytes,
      transfers: requests,
      sourceReturnMutations: mutations,
      originalRetryReadFree: true,
      peakRssBytes: maximumRss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      heapLimitMiB: 128,
      coverage:
        'Actual complete archive streamed to the registered source-return action using synthetic provider/project authority. Exact manifest/Work pins and retained records checked; local full source closure remains its existing restore owner. No live provider or canonical Work writes.',
    }),
  );
} finally {
  clearInterval(sample);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
