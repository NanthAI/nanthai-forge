// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMirror, stepMirror } from '../dist/hosted-github-mirror.js';
import { githubRequest, githubErrorSummary, githubErrorChars } from '../dist/hosted-github-api.js';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';

// Incident 8568bc76: mirror job for State 04984b7f changed exactly these 12
// ordinary files on a verified binding; POST git/trees sent 1461 bytes and
// GitHub answered 422 twice. Source bytes are synthetic; the request shape is exact.
const paths = [
  'docs/agents/workflow.md',
  'scripts/measure-agent-context.mjs',
  'src/agent-cli.ts',
  'src/hosted-agent-help.ts',
  'src/hosted-overlap-notice.ts',
  'src/mcp-hosted-agent.ts',
  'src/mcp-tool-list.ts',
  'src/receipt-slim.ts',
  'tests/hosted-records-transport.test.mjs',
  'tests/mcp-tool-list.test.mjs',
  'tests/mcp-verbs.test.mjs',
  'tests/receipt-slim.test.mjs',
];
const github422 = {
  message: 'GitRPC::BadObjectState',
  errors: [{ resource: 'Tree', field: 'tree', code: 'invalid', message: 'synthetic entry rejected' }],
  documentation_url: 'https://docs.github.com/rest/git/trees#create-a-tree',
  status: '422',
};

test('incident replay: 12 modified files send one exact 1461-byte tree; a 422 keeps GitHub message and resume sends only the tree', async () => {
  const f = mirrorFixture({
    before: Object.fromEntries([...paths, 'README.md'].map(path => [path, `old ${path}`])),
    after: Object.fromEntries(
      [...paths, 'README.md'].map(path => [path, path === 'README.md' ? `old ${path}` : `new ${path}`]),
    ),
  });
  let reject = true;
  const trees = [];
  const api = githubRequest('ghs_syntheticInstallationToken0001', async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/git/trees')) {
      trees.push(init.body);
      if (reject)
        return Response.json(
          { ...github422, echoed: 'ghs_syntheticInstallationToken0001' },
          { status: 422, headers: { 'x-github-request-id': 'B9C0:96918:33AF6A9:A940A34:6AED7BEC' } },
        );
    }
    return Response.json(await f.io.api(path, init.method, init.body && JSON.parse(init.body)));
  });
  const io = { ...f.io, api };
  const plan = await prepareMirror(f.seed, io);
  const started = { phase: plan.phase, index: plan.index };
  await assert.rejects(stepMirror(plan, io), e => {
    assert.equal(e.code, 'GITHUB_SYNC_API');
    assert.equal(e.status, 422);
    assert.equal(e.operation, 'POST git/trees');
    assert.equal(e.requestBytes, 1461);
    assert.equal(e.githubError, 'GitRPC::BadObjectState; Tree tree invalid synthetic entry rejected');
    assert.match(
      e.message,
      /GitHub error: "GitRPC::BadObjectState; Tree tree invalid synthetic entry rejected"\./,
    );
    assert.match(e.message, /request ID B9C0:96918:33AF6A9:A940A34:6AED7BEC/);
    assert(!/ghs_|documentation_url|docs\.github\.com/.test(e.message));
    return true;
  });
  const body = JSON.parse(trees[0]);
  assert.equal(Buffer.byteLength(trees[0]), 1461);
  assert.deepEqual(Object.keys(body), ['base_tree', 'tree']);
  assert.equal(body.base_tree, f.root.tree);
  assert.deepEqual(
    body.tree.map(entry => [entry.path, entry.mode, entry.type, /^[0-9a-f]{40}$/.test(entry.sha)]),
    paths.map(path => [path, '100644', 'blob', true]),
  );
  for (const entry of body.tree)
    assert(f.githubBlobs.has(entry.sha), 'every tree entry names a created blob');
  // The action checkpoints this verified progress; resume replays the tree alone.
  assert.notDeepEqual({ phase: plan.phase, index: plan.index }, started);
  const blobPosts = f.calls.filter(call => call.path.endsWith('/blobs')).length;
  assert.equal(blobPosts, 12);
  reject = false;
  const resumed = await stepMirror(JSON.parse(JSON.stringify(plan)), io);
  assert.equal(resumed.phase, 'done');
  assert.equal(trees.length, 2);
  assert.equal(trees[1], trees[0], 'resume sends the identical tree request');
  assert.equal(f.calls.filter(call => call.path.endsWith('/blobs')).length, blobPosts, 'no blob is re-sent');
  assert.equal(resumed.entry.tree, f.expected());
  assert.equal(f.remote(), resumed.entry.commit);
});

test('GitHub error summary keeps only bounded JSON message and errors, never raw bodies or credentials', () => {
  assert.equal(githubErrorSummary('private raw body'), undefined);
  assert.equal(githubErrorSummary('"string"'), undefined);
  assert.equal(githubErrorSummary(JSON.stringify({ documentation_url: 'x', status: '422' })), undefined);
  assert.equal(
    githubErrorSummary(
      JSON.stringify({
        message: 'Validation\nFailed for Bearer abc.def',
        errors: ['plain', { code: 'missing_field', field: 'sha', value: 'private-value' }, 7, null],
      }),
    ),
    'Validation Failed for Bearer [redacted]; plain; sha missing_field',
  );
  assert.equal(
    githubErrorSummary(
      JSON.stringify({ message: 'token raw-secret and github_pat_ABCDEFGHIJ0123 here' }),
      'raw-secret',
    ),
    'token [redacted] and [redacted] here',
  );
  const long = githubErrorSummary(JSON.stringify({ message: 'é'.repeat(2000), errors: Array(50).fill('e') }));
  assert.equal([...long].length, githubErrorChars);
  assert(long.endsWith('…'));
});
