// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { gitHash, gitTree, githubCommit, gitMode } from '../dist/hosted-github-git.js';
import { GithubMirrorApiError } from '../dist/hosted-github-api.js';
const fileMode = mode =>
  mode === '160000' ? 'gitlink' : mode === '120000' ? 'symlink' : mode === '100755' ? 'executable' : 'file';
export function mirrorFixture({
  before = { 'hello.txt': 'old' },
  after = { 'hello.txt': 'new' },
  verified = true,
  /** Which `before` paths GitHub main holds (an older mirror dropped some names). */
  onGithub = () => true,
  /** The bytes GitHub's tree holds for a `before` path (an LFS pointer, say). */
  githubBytes = (_path, bytes) => bytes,
  /** Files of a State landed after `before` while the mirror was off: GitHub main still holds
   * `before`, and this is the State before the job's landing. */
  between = null,
  /** GitHub main is the project's import commit: no Forge-State trailer, named by the seed. */
  imported = false,
  /** The GitHub repository has no commit yet: its Git Data API answers 409 until one exists. */
  empty = false,
  targetBranch = 'main',
} = {}) {
  const objects = new Map(),
    states = new Map(),
    commits = new Map(),
    trees = new Map(),
    githubBlobs = new Map(),
    /** Commit comments by commit sha (Item c63c2171's notice to a dropped commit's author). */
    comments = new Map(),
    statuses = new Map();
  const calls = [],
    windows = [],
    reads = [],
    ticks = [];
  const identity = { name: 'Forge Sync', email: '123+fixture@users.noreply.github.com' };
  const state = files => {
    const value = {
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      message: 'source',
      at: '2026-01-01T00:00:00.000Z',
      files: Object.entries(files).map(([path, value]) => {
        const mode = typeof value === 'string' ? 'file' : value.mode;
        const bytes = Buffer.from(typeof value === 'string' ? value : value.text);
        const blob = digest(bytes);
        objects.set(blob, bytes);
        return { path, blob, mode };
      }),
    };
    const head = digest(JSON.stringify(value));
    states.set(head, value);
    return head;
  };
  const github = state(before),
    previous = between ? state(between) : github,
    head = state(after);
  const base = states
    .get(github)
    .files.filter(file => onGithub(file.path))
    .map(file => {
      const bytes = githubBytes(file.path, objects.get(file.blob)),
        sha = file.mode === 'gitlink' ? bytes.toString().trimEnd() : gitHash('blob', bytes);
      githubBlobs.set(sha, bytes);
      return { path: file.path, mode: file.mode, sha };
    });
  const baseTree = gitTree(base);
  trees.set(baseTree, base);
  const root = {
    operationId: randomUUID(),
    acceptanceId: randomUUID(),
    viewId: randomUUID(),
    state: github,
    parent: '0'.repeat(40),
    tree: baseTree,
    message: imported ? 'base' : `base\n\nForge-State: ${github}`,
    author: identity,
    committer: identity,
    seconds: 1767225600,
  };
  root.commit = githubCommit(root);
  commits.set(root.commit, root);
  let remote = empty ? null : root.commit,
    lose;
  /** Branches other than main (Candidate branches), by name. */
  const branches = new Map();
  const seed = {
    repository: 'synthetic/mirror',
    ...(targetBranch !== 'main' ? { targetBranch } : {}),
    state: head,
    previous,
    acceptanceId: randomUUID(),
    viewId: randomUUID(),
    operationId: randomUUID(),
    message: `An accepted outcome\n\nForge-State: ${head}`,
    at: '2026-01-02T00:00:00.000Z',
    binding: verified ? root : null,
    verified,
    identity,
    ...(imported ? { import: { commit: root.commit, state: github } } : {}),
  };
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    const route = path.replace('/repos/synthetic/mirror/git/', '');
    let result;
    if (remote === null && path.includes('/git/'))
      throw new GithubMirrorApiError(409, `${method} git`, 0, undefined, 'Git Repository is empty.');
    const commented = path.match(
      /^\/repos\/synthetic\/mirror\/commits\/([0-9a-f]{40})(\/comments)?(\?per_page=\d+)?$/,
    );
    const statusSha = path.match(/\/statuses\/([a-f0-9]{40})$/)?.[1];
    const combinedSha = path.match(/\/commits\/([a-f0-9]{40})\/status$/)?.[1];
    if (statusSha && method === 'POST') {
      assert(commits.has(statusSha));
      const history = statuses.get(statusSha) ?? [];
      history.unshift({ target_url: null, ...body });
      statuses.set(statusSha, history);
      result = history[0];
    } else if (combinedSha) {
      result = { statuses: statuses.get(combinedSha) ?? [] };
    } else if (commented && commented[2]) {
      const list = comments.get(commented[1]) ?? [];
      if (method === 'POST') list.push({ body: body.body, beforeMain: remote });
      comments.set(commented[1], list);
      result = method === 'POST' ? { id: list.length } : list.map(({ body }) => ({ body }));
    } else if (commented) result = { sha: commented[1], author: { login: 'synthetic-pusher' } };
    else if (path === '/repos/synthetic/mirror/branches?per_page=1') result = remote === null ? [] : [{}];
    else if (path.startsWith('/repos/synthetic/mirror/contents/') && method === 'PUT') {
      assert.equal(remote, null, 'the Contents API only seeds an empty repository');
      assert.equal(body.branch, targetBranch);
      const file = { path: path.slice('/repos/synthetic/mirror/contents/'.length), mode: 'file' };
      const bytes = Buffer.from(body.content, 'base64');
      file.sha = gitHash('blob', bytes);
      githubBlobs.set(file.sha, bytes);
      const tree = gitTree([file]);
      trees.set(tree, [file]);
      remote = digest(body.message).slice(0, 40);
      commits.set(remote, { tree, message: body.message, parent: null });
      result = { commit: { sha: remote, tree: { sha: tree } } };
    } else if (route === `ref/heads/${targetBranch}`) result = { object: { sha: remote } };
    else if (route.startsWith('ref/heads/')) {
      const sha = branches.get(route.slice(10));
      if (!sha) throw new GithubMirrorApiError(404, 'GET ref', 0);
      result = { object: { sha } };
    } else if (route === 'refs' && method === 'POST') {
      const name = body.ref.slice('refs/heads/'.length);
      assert(!branches.has(name), 'a branch is created once');
      assert(commits.has(body.sha));
      branches.set(name, body.sha);
      result = { object: { sha: body.sha } };
    } else if (route.startsWith('commits/') && method === 'GET') {
      const entry = commits.get(route.slice(8));
      assert(entry);
      result = { tree: { sha: entry.tree }, message: entry.message };
    } else if (route === 'blobs') {
      const bytes = Buffer.from(body.content, body.encoding),
        sha = gitHash('blob', bytes);
      githubBlobs.set(sha, bytes);
      result = { sha };
    } else if (route === 'trees') {
      // With base_tree, path entries edit that tree; without it, entries are one directory's full
      // listing whose `tree` entries name subtrees already known here (per-directory fallback).
      if (!body.base_tree) assert(body.tree.every(change => !change.path.includes('/')));
      const files = new Map(body.base_tree ? trees.get(body.base_tree).map(file => [file.path, file]) : []);
      for (const change of body.tree) {
        if (change.sha === null) files.delete(change.path);
        else if (change.type === 'tree') {
          assert.equal(change.mode, '040000');
          for (const file of trees.get(change.sha))
            files.set(`${change.path}/${file.path}`, { ...file, path: `${change.path}/${file.path}` });
        } else {
          if (change.type === 'commit') assert.equal(change.mode, '160000');
          else assert(githubBlobs.has(change.sha));
          files.set(change.path, { path: change.path, mode: fileMode(change.mode), sha: change.sha });
        }
      }
      const values = [...files.values()],
        sha = gitTree(values);
      trees.set(sha, values);
      result = { sha };
    } else if (route.startsWith('trees/') && method === 'GET') {
      const [sha, query] = route.slice(6).split('?');
      const files = trees.get(sha);
      assert(files);
      const recursive = query === 'recursive=1';
      const entries = new Map();
      for (const file of files) {
        const parts = file.path.split('/');
        for (let i = 1; i < parts.length && (recursive || i === 1); i++) {
          const dir = parts.slice(0, i).join('/');
          if (entries.has(dir)) continue;
          const sub = files
            .filter(other => other.path.startsWith(`${dir}/`))
            .map(other => ({ ...other, path: other.path.slice(dir.length + 1) }));
          const subSha = gitTree(sub);
          trees.set(subSha, sub);
          entries.set(dir, { path: dir, mode: '040000', type: 'tree', sha: subSha });
        }
        if (recursive || parts.length === 1)
          entries.set(file.path, {
            path: file.path,
            mode: gitMode(file.mode),
            type: file.mode === 'gitlink' ? 'commit' : 'blob',
            sha: file.sha,
          });
      }
      result = { sha, tree: [...entries.values()], truncated: false };
    } else if (route === 'commits') {
      const entry = { ...body, parent: body.parents[0], seconds: Date.parse(body.committer.date) / 1000 };
      assert.equal(body.message.at(-1), '\n');
      entry.message = body.message.slice(0, -1);
      const sha = githubCommit(entry, body.parents[1]);
      commits.set(sha, entry);
      result = { sha };
    } else if (route === `refs/heads/${targetBranch}`) {
      assert.equal(body.force, false);
      const pending = [body.sha];
      const ancestors = new Set();
      while (pending.length) {
        const ancestor = pending.pop();
        if (ancestors.has(ancestor)) continue;
        ancestors.add(ancestor);
        const entry = commits.get(ancestor);
        if (entry?.parents) pending.push(...entry.parents);
        else if (entry?.parent) pending.push(entry.parent);
      }
      assert(ancestors.has(remote), 'fast forward only');
      remote = body.sha;
      result = { object: { sha: remote } };
    } else assert.fail(`${method} ${path}`);
    if (lose === route) {
      lose = null;
      throw new Error('synthetic lost reply');
    }
    return result;
  };
  const io = {
    api,
    states: async ids => {
      windows.push({ states: ids.length });
      return ids.map(id => states.get(id));
    },
    blobs: async ids => {
      assert(ids.length <= 100);
      windows.push({ blobs: ids.length });
      return ids.map(id => ({
        size: objects.get(id).length,
        read: async () => {
          reads.push(id);
          return objects.get(id);
        },
      }));
    },
  };
  return {
    seed,
    io,
    calls,
    windows,
    reads,
    ticks,
    objects,
    states,
    commits,
    trees,
    githubBlobs,
    comments,
    statuses,
    root,
    head,
    remote: () => remote,
    branches,
    move: sha => {
      remote = sha;
    },
    lose: route => {
      lose = route;
    },
    expected: () =>
      gitTree(
        states.get(head).files.map(file => ({
          ...file,
          sha:
            file.mode === 'gitlink'
              ? objects.get(file.blob).toString().trimEnd()
              : gitHash('blob', objects.get(file.blob)),
        })),
      ),
    gitMode,
  };
}
