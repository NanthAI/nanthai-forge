// SPDX-License-Identifier: Apache-2.0
// Item c63c2171: an agent's `nforge github connect` appears as a Forge-owned decision in the agent's words, with
// an approve link the CLI prints. The owner person allows it (then authorizes on GitHub) or declines it (the
// connect ends). A person's own connect asks nothing extra.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { policyPreset } from '../dist/autonomy-policy.js';
const store = await import(moduleUrl('../convex/githubBindingStore.ts'));
const approvals = await import(moduleUrl('../convex/projectHostedApprovals.ts'));

const device = { subject: 'owner', forgeCredential: 'synthetic-device' };
const words = 'Mirror main so reviewers on GitHub see each landing.';

function fixture(t) {
  const prior = process.env.FORGE_WEB_URL;
  process.env.FORGE_WEB_URL = 'https://forge.example';
  t.after(() =>
    prior === undefined ? delete process.env.FORGE_WEB_URL : (process.env.FORGE_WEB_URL = prior),
  );
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    owner: 'owner',
    key: randomUUID(),
    name: 'Connect project',
    currentBackup: null,
    revision: 0,
    visibility: 'private',
    autonomyPolicy: policyPreset('supervised'),
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  s.insert('cliCredentials', {
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'test',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    revoked: false,
    scope: 'cli',
    settings: { source: 'write', projects: { kind: 'all' } },
  });
  const start = async (actor, extra = {}) => {
    const operationId = randomUUID(),
      state = randomUUID();
    const input = {
      projectId,
      operationId,
      state,
      repository: 'synthetic/repo',
      githubAccounts: ['1001'],
      verifier: 'synthetic-verifier',
      authorizeUrl: `https://github.com/login/oauth/authorize?state=${state}`,
      mirror: true,
      ...extra,
    };
    return { input, reply: JSON.parse(await s.call('start', store.start, input, actor)) };
  };
  const op = operationId =>
    [...s.tables.githubBindingOperations.values()].find(row => row.operationId === operationId);
  const request = () => [...s.tables.projectHostedApprovals.values()].find(row => row.setting);
  const decide = (decision, actor = 'owner') =>
    s.call(
      'decide',
      approvals.decide,
      { projectId, operationId: randomUUID(), laneId: request().laneId, head: request().head, decision },
      actor,
    );
  return { s, projectId, start, op, request, decide };
}

test('an agent connect holds a Forge decision in its words; allowing it continues to GitHub', async t => {
  const f = fixture(t);
  const { input, reply } = await f.start(device, { reason: `  ${words}\n` });
  assert.equal(reply.status, 'waiting');
  assert.match(
    reply.approval.url,
    /^https:\/\/forge\.example\/approve\?project=.+&lane=setting%3Agithub-connect$/,
  );
  assert.match(reply.approval.next, /needs the project owner/);
  const row = f.request();
  assert.equal(row.setting.origin, 'github-connect');
  assert.equal(row.reason, words, 'the owner reads the agent’s own words');
  assert.deepEqual(JSON.parse(row.setting.request), {
    direction: 'two-way',
    operationId: input.operationId,
    repository: 'synthetic/repo',
  });
  // The cost of the hold: one indexed read and one write beside the connect's own operation row.
  const meter = f.s.counts.at(-1);
  assert(meter.writes <= 2, `start writes ${meter.writes}`);
  // The replayed connect returns the same link.
  const replay = JSON.parse(await f.s.call('start', store.start, input, device));
  assert.equal(replay.approval.url, reply.approval.url);
  // Only the owner person decides; the agent's own sign-in cannot grant it.
  await assert.rejects(
    f.decide('grant', device),
    error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE',
  );
  const granted = JSON.parse(await f.decide('grant'));
  assert.equal(granted.approval.status, 'granted');
  assert.equal(
    granted.applied.authorizeUrl,
    input.authorizeUrl,
    'the page continues to GitHub’s authorization',
  );
  assert.equal(
    f.op(input.operationId).status,
    'waiting',
    'GitHub authorization still proves repository access',
  );
});

test('declining an agent connect ends it, so the waiting CLI returns', async t => {
  const f = fixture(t);
  const { input } = await f.start(device, { reason: words });
  const declined = JSON.parse(await f.decide('decline'));
  assert.equal(declined.approval.status, 'declined');
  assert.equal(f.op(input.operationId).status, 'failed');
  assert.equal(f.op(input.operationId).code, 'REVIEW_DECLINED');
});

test('a person connect asks nothing extra; GitHub authorization without the page settles an open request', async t => {
  const f = fixture(t);
  const person = await f.start('owner');
  assert.equal(person.reply.approval, undefined);
  assert.equal(f.request(), undefined);
  assert.equal(f.op(person.input.operationId).asked, undefined, 'its completion reads no request');
  // The owner authorizes on GitHub straight from the printed link: the Forge request is no longer open.
  const { input } = await f.start(device);
  assert.equal(f.request().reason, 'Connect synthetic/repo to this project.');
  await f.s.call('consume', store.consume, { state: input.state });
  await f.s.call('fail', store.fail, { state: input.state, code: 'GITHUB_OAUTH_DENIED' });
  assert(f.request().ended, 'the request ends with the connect');
});
