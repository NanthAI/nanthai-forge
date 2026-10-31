#!/usr/bin/env node
// Offline import cost projection for a real GitHub tree shape (B1.5c preflight).
// Usage: node scripts/benchmark-import-projection.mjs TREE.json
// TREE.json is a saved `GET /repos/O/R/git/trees/SHA?recursive=1` response (truncated:false).
// Runs the real bounded-page import handlers on the paged test fixture with synthetic
// bytes of each file's exact size; no network, no Convex, no credentials.
// Synthetic content is unique per file, so blob dedupe is never assumed (conservative).
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pagedFixture } from '../tests/github-import-pages-fixture.mjs';

const listing = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (listing.truncated) throw Error('Tree listing is truncated; projection needs the complete tree.');
const body = (index, size) => {
  const seed = Buffer.from(`synthetic ${index}\n`);
  const out = Buffer.allocUnsafe(size);
  for (let at = 0; at < size; at += seed.length) seed.copy(out, at, 0, Math.min(seed.length, size - at));
  return out;
};
const gitSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const hex = n => n.toString(16).padStart(40, '0');

// Rebuild non-recursive trees from the recursive listing (synthetic tree ids).
const dirs = new Map([['', { id: hex(1), entries: [] }]]);
let nextTree = 2;
const blobs = new Map();
let fileIndex = 0;
const dirOf = path => {
  if (dirs.has(path)) return dirs.get(path);
  const dir = { id: hex(nextTree++), entries: [] };
  dirs.set(path, dir);
  const slash = path.lastIndexOf('/');
  dirOf(slash < 0 ? '' : path.slice(0, slash)).entries.push({
    path: path.slice(slash + 1),
    sha: dir.id,
    mode: '040000',
    type: 'tree',
  });
  return dir;
};
for (const entry of listing.tree) {
  const slash = entry.path.lastIndexOf('/');
  const parent = slash < 0 ? '' : entry.path.slice(0, slash),
    name = entry.path.slice(slash + 1);
  if (entry.type === 'tree') dirOf(entry.path);
  else if (entry.type === 'commit')
    dirOf(parent).entries.push({ path: name, sha: entry.sha, mode: '160000', type: 'commit' });
  else {
    const index = fileIndex++,
      sha = gitSha(body(index, entry.size));
    blobs.set(sha, { index, size: entry.size });
    dirOf(parent).entries.push({ path: name, sha, size: entry.size, type: 'blob', mode: entry.mode });
  }
}
const trees = new Map([...dirs.values()].map(dir => [dir.id, dir.entries]));
const files = fileIndex,
  submodules = listing.tree.filter(e => e.type === 'commit').length;

const s = pagedFixture();
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
    const blob = blobs.get(path.split('/').at(-1));
    return new Response(body(blob.index, blob.size));
  }
  throw Error(`Unexpected synthetic request ${path}`);
};
const started = Date.now();
const id = await s.modules.projectGithubImport.start._handler(s.ctx, {
  operationId: randomUUID(),
  url: 'fixture/scale',
});
let steps = 0;
while (s.tables.projectGithubImports.get(id).phase !== 'ready' && steps++ < 5000) {
  await s.worker(id);
  const phase = s.tables.projectGithubImports.get(id).phase;
  if (phase === 'error') throw Error(JSON.stringify(s.tables.projectGithubImports.get(id).error));
}
const job = s.tables.projectGithubImports.get(id);
const byFunction = Object.fromEntries([...s.calls.entries()].sort((a, b) => b[1] - a[1]));
const executions = [...s.calls.values()].reduce((a, b) => a + b, 0) + 1; // + public start
console.log(
  JSON.stringify(
    {
      files,
      directories: dirs.size,
      submodules,
      bytes: listing.tree.reduce((sum, e) => sum + (e.size ?? 0), 0),
      phase: job.phase,
      completed: job.completed,
      workerSteps: steps,
      executions,
      byFunction,
      ...s.stats(),
      wallMs: Date.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    },
    null,
    1,
  ),
);
