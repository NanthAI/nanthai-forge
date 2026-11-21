// SPDX-License-Identifier: Apache-2.0
// The installation and Git data cases also run against the public scratch repository when
// CONTRACT_GITHUB_* is set. That run creates and deletes one branch. The Actions, check-run
// and LFS cases use synthetic data while scratch permissions and seed data await approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleUrl } from '../convex-module.mjs';
import { fakeGithub } from '../github-api-fake.mjs';
import { fixture, git } from '../helpers.mjs';
import { hostedActionsRemote } from '../../dist/hosted-actions-remote.js';
import { lfsBatch, streamLfsObject } from '../../dist/github-lfs.js';
import { WorkService } from '../../dist/work.js';
import { contractTargets } from './targets.mjs';

const {
  appInstallation,
  actionsToken,
  actionsPermissions,
  githubAppRequest,
  metadataProbeToken,
  mirrorPermissions,
  mirrorWorkflowPermissions,
} = await import(moduleUrl('../convex/githubAppToken.ts'));
const { githubRequest } = await import(moduleUrl('../src/hosted-github-api.ts'));

const lfsBytes = Buffer.from([0, 255, 1, 128]);
const lfsPointer = bytes => ({ oid: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });

const appSettings = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'];
const targets = contractTargets(
  'github',
  ['CONTRACT_GITHUB_APP_ID', 'CONTRACT_GITHUB_APP_PRIVATE_KEY', 'CONTRACT_GITHUB_REPO'],
  {
    async fake() {
      const github = fakeGithub({ lfsObjects: [lfsBytes] });
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
    t.after(() => {
      for (const [name, value] of Object.entries(prior))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    });
    const { api, installation } = await appInstallation(repo, request, Date.now());
    const repoId = (
      await githubRequest(await metadataProbeToken(api, installation.id, repo), request)(`/repos/${repo}`)
    ).id;
    const scope = { installationId: installation.id, repoId };
    const mint = permissions => actionsToken(null, '', repo, scope, request, Date.now(), permissions);
    const tokenFor = async permissions => githubRequest(await mint(permissions), request);
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

    if (target.name === 'fake') {
      const base = `repos/${repo}/actions`;
      const dispatch = `${base}/workflows/forge-check.yml/dispatches`;
      const remoteFor = (token, transport = request) =>
        hostedActionsRemote(
          { repository: repo, installationId: String(installation.id), credential: {} },
          (_reference, _installationId, _repo, use) => use(token),
          () => assert.fail('Actions API reads do not use source export'),
          transport,
        ).api;
      const input = { ref: 'main', inputs: { runId: 'synthetic-run' }, return_run_details: false };
      const runToken = await mint(actionsPermissions);
      const remote = remoteFor(runToken);

      await t.test('workflow dispatch supports the legacy empty reply and the returned run ID', async t => {
        const reader = remoteFor(await mint({ contents: 'read', actions: 'read' }));
        await assert.rejects(reader.request(dispatch, 'POST', input), { code: 'GITHUB_APP_ACCESS' });
        assert.deepEqual(await reader.pages(`${base}/runs`, 'workflow_runs'), []);
        assert.equal(await remote.request(dispatch, 'POST', input), undefined);
        const response = await githubAppRequest(dispatch, runToken, request, {
          ...input,
          return_run_details: true,
        });
        assert.equal(response.status, 200);
        const { workflow_run_id: id, html_url: url } = await response.json();
        assert.equal(id, 2);
        assert.equal(url, `https://github.com/${repo}/actions/runs/2`);
        await t.test('Actions pagination stops at the page whose Link has only prev', async () => {
          const pages = [];
          const lookup = remoteFor(runToken, async (url, init) => {
            assert.ok(pages.length < 2, 'Only Link next should request another page');
            const response = await request(url, init);
            pages.push({
              page: new URL(url).searchParams.get('page'),
              link: response.headers.get('link'),
            });
            return response;
          });
          const runs = await lookup.pages(`${base}/runs?branch=main&per_page=1`, 'workflow_runs');
          assert.deepEqual(
            runs.map(({ id, head_sha, event }) => [id, head_sha, event]),
            [
              [2, main, 'workflow_dispatch'],
              [1, main, 'workflow_dispatch'],
            ],
          );
          assert.deepEqual(
            pages.map(page => page.page),
            ['1', '2'],
          );
          assert.match(pages[0].link, /rel="next"/);
          assert.match(pages[1].link, /rel="prev"/);
          assert.doesNotMatch(pages[1].link, /rel="next"/);
        });
      });

      await t.test(
        'LFS batches resolve exact bytes and preserve an individual missing-object error',
        async () => {
          const pointer = lfsPointer(lfsBytes);
          const missing = lfsPointer(Buffer.from('absent'));
          const [object, absent] = await lfsBatch(
            repo,
            'download',
            [pointer, missing],
            await mint({
              contents: 'read',
            }),
            request,
          );
          assert.equal(object.oid, pointer.oid);
          assert.equal(object.size, pointer.size);
          assert.deepEqual(absent, { ...missing, error: { code: 404, message: 'Object does not exist' } });
          const parts = [];
          await streamLfsObject(
            pointer,
            object.download,
            async part => {
              parts.push(part);
            },
            request,
          );
          assert.deepEqual(Buffer.concat(parts), lfsBytes);
          await assert.rejects(
            streamLfsObject({ ...pointer, oid: missing.oid }, object.download, async () => {}, request),
            { code: 'ARTIFACT_INTEGRITY' },
          );
        },
      );
    }
  });
}

test('GitHub check import keeps reruns for the pinned commit across the 100-run page boundary', async t => {
  const root = fixture(t, { 'README.md': 'Synthetic check fixture\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Baseline']);
  const work = new WorkService(root);
  const local = command => work.execute(command, work.status().revision).result;
  const intent = local({ action: 'intent', outcome: 'Import provider checks' });
  const lane = local({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const view = local({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: work.status().lanes[0].actualHead }],
  });
  const checks = Array.from({ length: 101 }, (_, index) => ({
    id: 101 - index,
    name: index === 0 || index === 100 ? 'Verify' : `Check ${index}`,
    head_sha: view.head,
    status: 'completed',
    conclusion: index === 100 ? 'failure' : 'success',
    html_url: null,
    started_at: null,
    completed_at: null,
    app: { id: 1, name: 'Synthetic CI' },
  }));
  const repo = 'synthetic/contract';
  const bin = join(root, '.git', 'contract-bin');
  mkdirSync(bin);
  // The production importer invokes gh. This executable translates that request into the HTTP
  // fake instead of touching a network or returning its own precomputed pages.
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}
import { fakeGithub } from ${JSON.stringify(new URL('../github-api-fake.mjs', import.meta.url).href)};
const { fetch } = fakeGithub({ repo: ${JSON.stringify(repo)}, checkRuns: ${JSON.stringify(checks)} });
const response = await fetch(new URL(process.argv[7], 'https://api.github.com/'));
if (!response.ok) process.exit(1);
process.stdout.write(await response.text());
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
  });
  process.env.PATH = `${bin}:${path}`;

  const { result } = await work.dispatch(
    {
      action: 'import-checks',
      operationId: randomUUID(),
      viewId: view.id,
      expectedHead: view.head,
      repository: repo,
    },
    work.status().revision,
  );
  assert.equal(result.checks.length, 101);
  assert.deepEqual(
    result.checks.filter(check => check.name === 'Verify').map(check => [check.id, check.conclusion]),
    [
      [101, 'success'],
      [1, 'failure'],
    ],
  );
  assert.equal(result.head, view.head);
});
