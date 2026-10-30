import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pagedFixture } from './github-import-pages-fixture.mjs';
import { readObjectRecipe } from '../dist/object-chunks.js';
import { filePage, importPageBytes, importPathKey } from '../dist/github-import-pages.js';
import { digest } from '../dist/hash.js';
const sha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const hex = n => n.toString(16).padStart(40, '0');

test('28,905 files / 4,089 directories use bounded pages within the complete import call budget', async t => {
  const s = pagedFixture(),
    files = 28905,
    directories = 4089,
    bodies = new Map();
  const trees = new Map();
  const root = [];
  for (let dir = 0, index = 0; dir < directories; dir++) {
    const tree = dir ? [] : root;
    const count = dir === 0 ? files - (directories - 1) * 7 : 7;
    for (let j = 0; j < count; j++, index++) {
      const bytes = Buffer.from(`synthetic source ${index}\n`),
        id = sha(bytes);
      bodies.set(id, bytes);
      tree.push({
        path: `file-${String(index).padStart(5, '0')}`,
        sha: id,
        size: bytes.length,
        type: 'blob',
        mode: index % 3 === 0 ? '100755' : index % 3 === 1 ? '120000' : '100644',
      });
    }
    if (dir)
      root.push({
        path: `dir-${String(dir).padStart(4, '0')}`,
        sha: hex(dir + 1),
        mode: '040000',
        type: 'tree',
      });
    trees.set(hex(dir + 1), tree);
  }
  const old = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = old;
  });
  let blobRequests = 0;
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path === '/repos/fixture/scale')
      return Response.json({
        full_name: 'fixture/scale',
        private: false,
        default_branch: 'main',
        html_url: 'https://github.com/fixture/scale',
        license: null,
      });
    if (path.includes('/commits/'))
      return Response.json({ sha: 'a'.repeat(40), commit: { tree: { sha: hex(1) } } });
    if (path.includes('/git/trees/')) {
      const id = path.split('/').at(-1);
      return Response.json({ sha: id, truncated: false, tree: trees.get(id) });
    }
    if (path.includes('/git/blobs/')) {
      blobRequests++;
      return new Response(bodies.get(path.split('/').at(-1)));
    }
    throw Error(`Unexpected synthetic request ${path}`);
  };
  const id = await s.modules.projectGithubImport.start._handler(s.ctx, {
    operationId: randomUUID(),
    url: 'fixture/scale',
  });
  let importCalls = 0,
    iterations = 0;
  while (s.tables.projectGithubImports.get(id).phase !== 'ready' && iterations++ < 200) {
    const job = structuredClone(s.tables.projectGithubImports.get(id)),
      before = [...s.calls.values()].reduce((a, b) => a + b, 0);
    const beforeScheduled = s.scheduled.length;
    await s.worker(id);
    if (job.totalKnown && job.completed === job.total)
      assert.equal(s.scheduled.length, beforeScheduled, 'publication schedules no idle continuation');
    assert.notEqual(
      s.tables.projectGithubImports.get(id).phase,
      'error',
      JSON.stringify(s.tables.projectGithubImports.get(id).error),
    );
    if (job.totalKnown && job.completed < job.total)
      importCalls += [...s.calls.values()].reduce((a, b) => a + b, 0) - before;
  }
  const job = s.tables.projectGithubImports.get(id),
    calls = [...s.calls.values()].reduce((a, b) => a + b, 0) + 1; // public start
  assert.equal(job.phase, 'ready');
  assert.equal(job.completed, files);
  assert.equal(blobRequests, files);
  assert.ok(
    importCalls <= 5 * Math.ceil(files / 1000),
    `${importCalls} file-page executions exceed 5 per 1,000 files`,
  );
  assert.ok(calls <= 1000, `${calls} executions exceed the whole-import ceiling`);
  assert.ok(s.stats().maxCursorBytes < 1024);
  assert.ok(s.stats().maxPayloadBytes < 1024 * 1024);
  assert.equal(s.tables.projectGithubImportInventory.size > files, true);
  const project = s.tables.hostedProjects.get(job.projectId),
    backup = s.tables.projectBackups.get(project.currentBackup);
  const read = async pin => {
    const row = [...s.tables.projectObjects.values()].find(
      row => row.projectId === project._id && row.digest === pin.sha256,
    );
    return Buffer.from(await s.files.get(row.storageId).blob.arrayBuffer());
  };
  const logical = async hash => {
    const row = [...s.tables.projectObjects.values()].find(
      row => row.projectId === project._id && row.digest === hash,
    );
    if (!row.recipe) return read({ sha256: hash });
    const recipe = JSON.parse((await read({ sha256: row.recipe.digest })).toString());
    const chunks = [];
    for await (const chunk of readObjectRecipe(recipe, read)) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const source = JSON.parse(await logical(backup.preview.head));
  assert.equal(source.files.length, files);
  assert.equal(digest(await logical(backup.preview.head)), backup.preview.head);
  const manifest = JSON.parse(await logical(backup.digest));
  assert.equal(manifest.files.length, files + 2);
  assert.ok(source.files.some(file => file.mode === 'symlink'));
  assert.ok(source.files.some(file => file.mode === 'executable'));
  assert.equal(
    [...s.tables.projectWorkRecords.values()].filter(row => row.collection === 'sourceBlobs').length,
    files + 1,
  );
  const count = calls,
    scheduled = s.scheduled.length;
  // Completion installs no continuation. A finite status read does not enqueue work.
  await s.modules.projectGithubImport.status._handler(s.ctx, { id });
  assert.equal(s.scheduled.length, scheduled);
  assert.equal(s.tables.projectGithubImportInventory.size > directories, true);
  t.diagnostic(
    JSON.stringify({
      files,
      directories,
      executions: count,
      filePageExecutions: importCalls,
      ...s.stats(),
      memory: process.memoryUsage(),
      idleScheduled: 0,
    }),
  );
});

test('file pages bound count, bytes and metadata while preserving a single large file', () => {
  assert.equal(filePage(Array.from({ length: 2000 }, () => ({ size: 1 }))).length, 1000);
  assert.equal(filePage([{ size: importPageBytes }, { size: 1 }]).length, 1);
  assert.equal(filePage([{ size: importPageBytes * 10 }, { size: 1 }]).length, 1);
  assert.equal(
    filePage(Array.from({ length: 1000 }, () => ({ size: 1, path: 'x'.repeat(1000) }))).length < 1000,
    true,
  );
});

test('inventory index keys retain portable State order for Unicode paths', () => {
  const paths = ['z', 'é', '\uE000', '😀', 'A', 'a/x', 'a.y'];
  assert.deepEqual(
    [...paths].sort((a, b) => importPathKey(a).localeCompare(importPathKey(b))),
    [...paths].sort(),
  );
});
