// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { gitHash, gitTree } from '../dist/hosted-github-git.js';
import { pullRequestEvent } from '../dist/github-pull-check.js';

/** Attach a one-file GitHub push to an already accepted fixture main. The real mirror action,
 * import uploads, compose, desired landing and settle path run; only GitHub and R2 are fake. */
export async function inboundCostFixture(t, f, { pull = false, path = 'inbound.js' } = {}) {
  const modules = Object.fromEntries(
    await Promise.all(
      [
        'projectGithubInboundQueue',
        'projectGithubInbound',
        'projectGithubMirror',
        'projectGithubMirrorStore',
        'projectGithubMirrorObjects',
        'projectObjectCommit',
        'projectGithubPull',
        'projectGithubPullQueue',
        'projectGithubPullStatus',
        'projectGithubPullStatusStore',
        'projectHostedMainAudit',
      ].map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))]),
    ),
  );
  const main = f.currentMain();
  const receipt = [...f.tables.projectHostedAcceptances.values()]
    .map(row => JSON.parse(row.value))
    .find(row => row.id === main.receipt.id);
  assert(receipt, 'bootstrap accepted main exists outside the measured push');
  const before = Object.fromEntries(
    JSON.parse(f.c.objects.get(main.head)).files.map(file => [
      file.path,
      f.c.objects.get(file.blob).toString(),
    ]),
  );
  const github = mirrorFixture({ before });
  const bytes = Buffer.from('export const value = 2;\n');
  const treeFor = (name, content) => {
    const blob = gitHash('blob', content);
    github.githubBlobs.set(blob, content);
    const entries = [
      { path: name, mode: 'file', sha: blob },
      ...github.trees.get(github.root.tree).filter(file => file.path !== name),
    ];
    const tree = gitTree(entries);
    github.trees.set(tree, entries);
    return tree;
  };
  const tree = treeFor(path, bytes);
  const commit = 'e'.repeat(40);
  const pullHead = 'f'.repeat(40);
  github.commits.set(commit, { tree, message: 'Synthetic inbound cost change' });
  github.commits.set(pullHead, { tree, message: 'Synthetic pull request' });
  github.move(commit);
  const repository = 'synthetic/mirror';
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { repo: repository, autoPush: true, inbound: true, laneRefs: false },
    },
  });
  f.insert('projectGithubMirrors', {
    projectId: f.projectId,
    repository,
    repositoryKey: repository,
    activeId: null,
    mapping: JSON.stringify({ ...github.root, state: main.head, acceptanceId: receipt.id }),
  });
  const names = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'FORGE_GITHUB_REPO_BINDINGS'];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, {
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    FORGE_GITHUB_REPO_BINDINGS: `${f.projectId}=${repository}`,
  });
  const previousFetch = globalThis.fetch;
  let githubRequests = 0;
  let githubLookups = 0;
  let association = {
    number: 7,
    merge_commit_sha: commit,
    merged_at: '2026-01-01T00:00:00Z',
    base: { ref: 'main', repo: { id: 71 } },
    head: { sha: pullHead, repo: { id: 71 } },
  };
  let associationError = null;
  let pullPermissionRevoked = false;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).hostname !== 'api.github.com') return previousFetch(url, init);
    githubRequests++;
    if (url.endsWith('/installation'))
      return Response.json({ id: 42, ...(pull ? { permissions: { pull_requests: 'read' } } : {}) });
    if (url.includes('/access_tokens')) {
      const permissions = JSON.parse(init.body).permissions;
      assert(permissions.statuses === 'write' || ['read', 'write'].includes(permissions.contents));
      if (permissions.pull_requests && pullPermissionRevoked)
        return Response.json({ message: 'Permissions are not available' }, { status: 422 });
      return Response.json({ token: 'synthetic-token' });
    }
    const endpoint = new URL(url).pathname;
    if (endpoint.includes('/compare/'))
      return Response.json({
        merge_base_commit: { sha: github.root.commit, commit: { tree: { sha: github.root.tree } } },
      });
    if (endpoint.includes('/statuses/')) return Response.json({}, { status: 201 });
    if (endpoint === `/repos/${repository}/commits/${commit}/pulls`) {
      githubLookups++;
      return associationError
        ? Response.json({}, { status: associationError })
        : Response.json(Array.isArray(association) ? association : [association]);
    }
    if (endpoint.includes('/git/trees/')) {
      const files = github.trees.get(endpoint.split('/').at(-1));
      assert(files, 'the requested synthetic tree exists');
      return Response.json({
        truncated: false,
        tree: files.map(file => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: file.sha,
          size: github.githubBlobs.get(file.sha).length,
        })),
      });
    }
    if (endpoint.includes('/git/blobs/'))
      return Response.json({
        encoding: 'base64',
        content: github.githubBlobs.get(endpoint.split('/').at(-1)).toString('base64'),
      });
    return Response.json(await github.io.api(endpoint, init?.method, init?.body && JSON.parse(init.body)));
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  });
  const call = (ref, args) => {
    const name = getFunctionName(ref),
      [file, method] = name.split(':');
    return f.tx(name, modules[file][method], args);
  };
  const execute = async task => {
    const [file, method] = task.name.split(':');
    const handler = modules[file]?.[method];
    if (!handler) return f.execute(task);
    f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
    if (handler.isAction) await handler._handler({ runQuery: call, runMutation: call }, task.args[0]);
    else await f.tx(task.name, handler, task.args[0]);
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  };
  return {
    execute,
    root: github.root,
    repository,
    lookupCount: () => githubLookups,
    requestCount: () => githubRequests,
    setAssociation: value => {
      association = value;
    },
    failAssociation: status => {
      associationError = status;
    },
    changeTree: () => {
      github.commits.set(commit, { tree: treeFor('another.js', bytes), message: 'Changed tree' });
    },
    revokeOptionalPermission: () => {
      pullPermissionRevoked = true;
    },
    receivePull: (author = 81) =>
      f.tx(
        'githubPullReceive',
        modules.projectGithubPullQueue.receive,
        pullRequestEvent({
          action: 'synchronize',
          repository: { id: 71, full_name: repository },
          sender: { id: 81, type: 'User' },
          pull_request: {
            number: 7,
            user: { id: author },
            base: { ref: 'main' },
            head: { sha: pullHead, repo: { id: 71, full_name: repository } },
          },
        }),
      ),
    receive: () =>
      f.tx('githubInboundReceive', modules.projectGithubInboundQueue.receive, {
        repository,
        ref: 'refs/heads/main',
        after: commit,
      }),
    assertLanded() {
      const queue = [...f.tables.projectGithubMirrors.values()][0];
      assert.equal(queue.activeId, null, JSON.stringify([...f.tables.projectGithubMirrorJobs.values()]));
      const outcome = JSON.parse(queue.inbound);
      assert.equal(outcome.outcome, 'landed');
      const landed = [...f.tables.projectHostedLandingRequests.values()]
        .map(row => JSON.parse(row.value))
        .find(
          row =>
            row.id ===
            JSON.parse(
              [...f.tables.projectGithubMirrorJobs.values()].find(job => job.inbound && !job.pullKey).inbound,
            ).submissionId,
        );
      assert.equal(landed.phase, 'landed');
      const files = JSON.parse(f.c.objects.get(f.currentMain().head)).files;
      assert.equal(f.c.objects.get(files.find(file => file.path === path).blob).toString(), bytes.toString());
      return { githubRequests, importedBytes: bytes.length };
    },
  };
}
