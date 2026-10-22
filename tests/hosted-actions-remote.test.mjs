// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionsFixture } from './hosted-actions-fixture.mjs';
import { hostedActionsRemote } from '../dist/hosted-actions-remote.js';
import { ActionsApiError } from '../dist/github-actions-api.js';
import { code } from './hosted-checks-fixture.mjs';

test('installation credential reference is used privately; bounded paged lookup and dispatch use selected repo', async () => {
  const s = await actionsFixture(),
    requests = [],
    uses = [];
  const credentials = async (reference, installation, repository, use) => {
    uses.push({ reference, installation, repository });
    return use('synthetic-private-token');
  };
  const remote = hostedActionsRemote(
    s.runner,
    credentials,
    () => s.transport,
    async (url, init) => {
      requests.push({ url, method: init.method });
      assert.equal(init.headers.authorization, 'Bearer synthetic-private-token');
      assert.equal(init.redirect, 'error');
      assert(init.signal);
      if (init.method === 'POST') return new Response(null, { status: 204 });
      const second = url.includes('page=2');
      return new Response(JSON.stringify({ workflow_runs: [{ id: second ? 2 : 1 }] }), {
        headers: second ? {} : { link: '<https://api.github.com/ignored>; rel="next"' },
      });
    },
  );
  assert.deepEqual(
    await remote.api.pages('repos/synthetic/project/actions/runs?per_page=100', 'workflow_runs'),
    [{ id: 1 }, { id: 2 }],
  );
  await remote.api.request('repos/synthetic/project/actions/workflows/forge-check.yml/dispatches', 'POST', {
    ref: 'pinned',
  });
  assert.equal(uses.length, 3);
  assert.deepEqual(uses[0], {
    reference: s.runner.credential,
    installation: s.runner.installationId,
    repository: s.runner.repository,
  });
  assert.equal(requests.length, 3);
  await assert.rejects(remote.api.request('repos/foreign/project/actions/runs'), code('EVIDENCE_CHANGED'));
});
test('registration/access/transport errors are sanitized and 400 retains local ambiguous classification', async () => {
  const s = await actionsFixture();
  const create = (credentials, response) =>
    hostedActionsRemote(s.runner, credentials, () => s.transport, response);
  await assert.rejects(
    create(
      async (_r, _i, _p, use) => use(''),
      async () => {},
    ).api.request('repos/synthetic/project/actions/runs'),
    code('GITHUB_APP_UNAVAILABLE'),
  );
  await assert.rejects(
    create(
      async () => {
        throw new Error('private credential detail');
      },
      async () => {},
    ).api.request('repos/synthetic/project/actions/runs'),
    e => e.code === 'GITHUB_APP_UNAVAILABLE' && !e.message.includes('private credential detail'),
  );
  const credentials = async (_r, _i, _p, use) => use('synthetic-private-token');
  for (const status of [401, 403])
    await assert.rejects(
      create(credentials, async () => new Response('private body', { status })).api.request(
        'repos/synthetic/project/actions/runs',
      ),
      code('GITHUB_APP_ACCESS'),
    );
  await assert.rejects(
    create(credentials, async () => new Response('private body', { status: 400 })).api.request(
      'repos/synthetic/project/actions/runs',
    ),
    e => e instanceof ActionsApiError && e.outcome === 'ambiguous' && !e.message.includes('private body'),
  );
  await assert.rejects(
    create(credentials, async () => {
      throw new Error('private transport detail');
    }).api.request('repos/synthetic/project/actions/runs'),
    e => e instanceof ActionsApiError && !e.message.includes('private transport detail'),
  );
});

test('real remote wrapper reconciles exact run refs, uses empty/expected leases and preserves changed branches', async () => {
  const { exportHostedActions } = await import('../dist/hosted-actions-export.js');
  const s = await actionsFixture(),
    exported = (await exportHostedActions(s.input, s.transport)).export;
  await s.store.control({ kind: 'claim', owner: '00000000-0000-4000-8000-000000000001' });
  const mapping = { ...s.mapping(), export: exported };
  let ref = '',
    pushes = 0;
  const remote = hostedActionsRemote(
    s.runner,
    async (_r, _i, _p, use) => use('synthetic-private-token'),
    () => s.transport,
    async () => new Response('{}'),
    async (_root, args, _input, token) => {
      assert.equal(token, 'synthetic-private-token');
      const branch = `refs/heads/${mapping.branch}`;
      if (args[0] === 'ls-remote') return ref ? `${ref}\t${branch}` : '';
      assert.equal(args[0], 'push');
      pushes++;
      if (args.at(-1) === `:${branch}`) {
        assert(args.includes(`--force-with-lease=${branch}:${exported.commit}`));
        ref = '';
      } else {
        assert(args.includes(`--force-with-lease=${branch}:`));
        ref = exported.commit;
      }
      if (pushes === 1) throw new Error('synthetic lost push reply');
      return '';
    },
  );
  await assert.rejects(remote.publish(mapping), /lost push/);
  await remote.publish(mapping);
  assert.equal(pushes, 1);
  ref = '2'.repeat(40);
  await assert.rejects(remote.delete(mapping), code('EVIDENCE_CHANGED'));
  assert.equal(pushes, 1);
  ref = exported.commit;
  await remote.delete(mapping);
  await remote.delete(mapping);
  assert.equal(pushes, 2);
});
