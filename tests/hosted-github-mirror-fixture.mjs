// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { gitHash, gitTree, githubCommit, gitMode } from '../dist/hosted-github-git.js';
import { GithubMirrorApiError } from '../dist/hosted-github-api.js';
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
} = {}) {
  const objects = new Map(),
    states = new Map(),
    commits = new Map(),
    trees = new Map(),
    githubBlobs = new Map();
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
  let remote = root.commit,
    lose;
  /** Branches other than main (Candidate branches), by name. */
  const branches = new Map();
  const seed = {
    repository: 'synthetic/mirror',
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
    if (route === 'ref/heads/main') result = { object: { sha: remote } };
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
      assert(body.base_tree);
      const files = new Map(trees.get(body.base_tree).map(file => [file.path, file]));
      for (const change of body.tree) {
        if (change.sha === null) files.delete(change.path);
        else {
          if (change.type === 'commit') assert.equal(change.mode, '160000');
          else assert(githubBlobs.has(change.sha));
          files.set(change.path, {
            path: change.path,
            mode:
              change.mode === '160000'
                ? 'gitlink'
                : change.mode === '120000'
                  ? 'symlink'
                  : change.mode === '100755'
                    ? 'executable'
                    : 'file',
            sha: change.sha,
          });
        }
      }
      const values = [...files.values()],
        sha = gitTree(values);
      trees.set(sha, values);
      result = { sha };
    } else if (route === 'commits') {
      const entry = { ...body, parent: body.parents[0], seconds: Date.parse(body.committer.date) / 1000 };
      assert.equal(body.message.at(-1), '\n');
      entry.message = body.message.slice(0, -1);
      const sha = githubCommit(entry);
      commits.set(sha, entry);
      result = { sha };
    } else if (route === 'refs/heads/main') {
      assert.equal(body.force, false);
      assert.equal(commits.get(body.sha).parent, remote, 'fast forward only');
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
