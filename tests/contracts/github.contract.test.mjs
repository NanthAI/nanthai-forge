// SPDX-License-Identifier: Apache-2.0
// Contract: the GitHub rules in tests/github-api-fake.mjs (and the fakes that use it) are what
// GitHub does. Every case runs against the fake, and against a public scratch repository with a
// contract GitHub App installed on it alone when the CONTRACT_GITHUB_* settings are present (the
// nightly contract workflow). Production token and request code runs on both sides:
// convex/githubAppToken.ts and src/hosted-github-api.ts. Each run writes one short-lived branch
// and a few unreferenced Git objects; it deletes the branch at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { moduleUrl } from '../convex-module.mjs';
import { fakeGithub } from '../github-api-fake.mjs';
import { contractTargets } from './targets.mjs';

const { appInstallation, actionsToken, metadataProbeToken, mirrorPermissions, mirrorWorkflowPermissions } =
  await import(moduleUrl('../convex/githubAppToken.ts'));
const { githubRequest } = await import(moduleUrl('../src/hosted-github-api.ts'));

const appSettings = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'];
const targets = contractTargets(
  'github',
  ['CONTRACT_GITHUB_APP_ID', 'CONTRACT_GITHUB_APP_PRIVATE_KEY', 'CONTRACT_GITHUB_REPO'],
  {
    async fake() {
      const github = fakeGithub();
      return {
        repo: github.repo,
        request: github.fetch,
        app: {
          GITHUB_APP_ID: '123',
          GITHUB_APP_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
            type: 'pkcs8',
            format: 'pem',
          }),
        },
      };
    },
    async real(env) {
      return {
        repo: env.CONTRACT_GITHUB_REPO,
        request: fetch,
        app: {
          GITHUB_APP_ID: env.CONTRACT_GITHUB_APP_ID,
          GITHUB_APP_PRIVATE_KEY: env.CONTRACT_GITHUB_APP_PRIVATE_KEY,
        },
      };
    },
  },
);

const refused = async (promise, status) => {
  const error = await promise.then(
    () => assert.fail(`expected HTTP ${status}`),
    error => error,
  );
  assert.equal(error.code, 'GITHUB_SYNC_API');
  assert.equal(error.status, status);
  return error;
};

for (const target of targets) {
  test(`GitHub contract (${target.name})`, { skip: target.skip }, async t => {
    const { repo, request, app } = await target.open();
    const prior = Object.fromEntries(appSettings.map(name => [name, process.env[name]]));
    Object.assign(process.env, app);
    const { api, installation } = await appInstallation(repo, request, Date.now());
    const repoId = (
      await githubRequest(await metadataProbeToken(api, installation.id, repo), request)(`/repos/${repo}`)
    ).id;
    const tokenFor = async permissions =>
      githubRequest(
        await actionsToken(
          null,
          '',
          repo,
          { installationId: installation.id, repoId },
          request,
          Date.now(),
          permissions,
        ),
        request,
      );
    const writer = await tokenFor(mirrorPermissions);
    const main = (await writer(`/repos/${repo}/git/ref/heads/main`)).object.sha,
      baseTree = (await writer(`/repos/${repo}/git/commits/${main}`)).tree.sha;
    const blob = (
      await writer(`/repos/${repo}/git/blobs`, 'POST', {
        content: `contract ${randomUUID()}\n`,
        encoding: 'utf-8',
      })
    ).sha;
    const tree = path => ({ base_tree: baseTree, tree: [{ path, mode: '100644', type: 'blob', sha: blob }] });
    const branch = `heads/contract/${randomUUID()}`;
    t.after(async () => {
      await writer(`/repos/${repo}/git/refs/${branch}`, 'DELETE').catch(() => {});
      for (const [name, value] of Object.entries(prior))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    });

    await t.test('a contents-read token cannot write a blob (403)', async () => {
      const reader = await tokenFor({ contents: 'read' });
      await refused(
        reader(`/repos/${repo}/git/blobs`, 'POST', { content: 'refused', encoding: 'utf-8' }),
        403,
      );
    });

    await t.test(
      'incident 708b6943: a contents-only token cannot create a tree touching .github/workflows (403)',
      async () => {
        const error = await refused(
          writer(`/repos/${repo}/git/trees`, 'POST', tree('.github/workflows/contract.yml')),
          403,
        );
        assert.match(error.githubError ?? '', /not accessible by integration/i);
        assert.ok((await writer(`/repos/${repo}/git/trees`, 'POST', tree('contract/file.txt'))).sha);
        assert.ok((await writer(`/repos/${repo}/git/trees`, 'POST', tree('.github/contract.txt'))).sha);
      },
    );

    await t.test('a token with workflows write creates the workflow tree', async () => {
      const workflows = await tokenFor(mirrorWorkflowPermissions);
      assert.ok(
        (await workflows(`/repos/${repo}/git/trees`, 'POST', tree('.github/workflows/contract.yml'))).sha,
      );
    });

    await t.test(
      'a ref moves forward to a descendant and refuses a non-fast-forward update (422)',
      async () => {
        const files = (await writer(`/repos/${repo}/git/trees`, 'POST', tree('contract/file.txt'))).sha;
        const commit = parents =>
          writer(`/repos/${repo}/git/commits`, 'POST', { message: 'contract', tree: files, parents }).then(
            c => c.sha,
          );
        const first = await commit([main]),
          child = await commit([first]),
          sibling = await commit([main]);
        await writer(`/repos/${repo}/git/refs`, 'POST', { ref: `refs/${branch}`, sha: first });
        assert.equal(
          (await writer(`/repos/${repo}/git/refs/${branch}`, 'PATCH', { sha: child, force: false })).object
            .sha,
          child,
        );
        const error = await refused(
          writer(`/repos/${repo}/git/refs/${branch}`, 'PATCH', { sha: sibling, force: false }),
          422,
        );
        assert.match(error.githubError ?? '', /not a fast forward/i);
        assert.equal((await writer(`/repos/${repo}/git/ref/${branch}`)).object.sha, child);
      },
    );

    await t.test(
      'a refusal names the operation and rate-limit diagnostics, never the request token',
      async () => {
        const token = await actionsToken(
          null,
          '',
          repo,
          { installationId: installation.id, repoId },
          request,
          Date.now(),
          { contents: 'read' },
        );
        const error = await refused(
          githubRequest(token, request)(`/repos/${repo}/git/blobs`, 'POST', {
            content: 'x',
            encoding: 'utf-8',
          }),
          403,
        );
        assert.match(error.message, /POST git\/blobs/);
        assert.match(error.message, /rate limit remaining \d+/);
        assert.ok(!error.message.includes(token));
      },
    );
  });
}
