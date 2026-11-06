// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMirror, stepMirror, invalidTreeBlobs } from '../dist/hosted-github-mirror.js';
import { githubRequest, githubErrorSummary, githubErrorChars } from '../dist/hosted-github-api.js';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { gitHash } from '../dist/hosted-github-git.js';

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
  errors: [
    {
      resource: 'Tree',
      field: 'tree',
      code: 'invalid',
      message: 'synthetic entry rejected',
    },
  ],
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
          {
            status: 422,
            headers: {
              'x-github-request-id': 'B9C0:96918:33AF6A9:A940A34:6AED7BEC',
            },
          },
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
      JSON.stringify({
        message: 'token raw-secret and github_pat_ABCDEFGHIJ0123 here',
      }),
      'raw-secret',
    ),
    'token [redacted] and [redacted] here',
  );
  const long = githubErrorSummary(JSON.stringify({ message: 'é'.repeat(2000), errors: Array(50).fill('e') }));
  assert.equal([...long].length, githubErrorChars);
  assert(long.endsWith('…'));
});

// Follow-up: after deploy the resumed job failed with GitHub's reason
// "tree.sha 334a90e0… is not a valid blob" for tests/receipt-slim.test.mjs,
// although the App's own blob POST had returned that SHA.
function invalidBlobReplay() {
  const f = mirrorFixture({
    before: Object.fromEntries([...paths, 'README.md'].map(path => [path, `old ${path}`])),
    after: Object.fromEntries(
      [...paths, 'README.md'].map(path => [path, path === 'README.md' ? `old ${path}` : `new ${path}`]),
    ),
  });
  const named = gitHash('blob', Buffer.from('new tests/receipt-slim.test.mjs'));
  const replies = [];
  const trees = [];
  const api = githubRequest('ghs_syntheticInstallationToken0001', async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/git/trees')) {
      trees.push(init.body);
      const reply = replies.shift();
      if (reply) return Response.json(reply, { status: 422 });
    }
    return Response.json(await f.io.api(path, init.method, init.body && JSON.parse(init.body)));
  });
  return { f, named, replies, trees, io: { ...f.io, api } };
}
const notValid = sha => ({
  message: `tree.sha ${sha} is not a valid blob`,
  documentation_url: 'https://docs.github.com/rest/git/trees#create-a-tree',
  status: '422',
});

test('incident replay: tree 422 naming a blob re-uploads exactly that blob, retries the tree once and commits', async () => {
  const r = invalidBlobReplay();
  assert.deepEqual(invalidTreeBlobs(new Error('x')), []);
  // First run (old runtime): 12 blobs verified, tree rejected without a named
  // blob; the checkpointed cursor then resumes at the tree alone.
  r.replies.push({ message: 'GitRPC::BadObjectState' });
  const plan = await prepareMirror(r.f.seed, r.io);
  await assert.rejects(stepMirror(plan, r.io), e => e.status === 422);
  const cursor = JSON.parse(JSON.stringify(plan));
  const before = r.f.calls.length;
  const reads = r.f.reads.length;
  r.replies.push(notValid(r.named));
  const resumed = await stepMirror(cursor, r.io);
  assert.equal(resumed.phase, 'done');
  const calls = r.f.calls.slice(before).map(call => `${call.method} ${call.path.replace(/.*\/git\//, '')}`);
  // The rejected tree never reaches the store, so only its successful retry is a store call.
  assert.deepEqual(calls, [
    'POST blobs',
    'POST trees',
    'GET ref/heads/main',
    'POST commits',
    'PATCH refs/heads/main',
  ]);
  assert.equal(
    r.f.calls.at(before).body.content,
    Buffer.from('new tests/receipt-slim.test.mjs').toString('base64'),
  );
  assert.equal(r.f.reads.length - reads, 1, 'reads exactly the named blob from Forge');
  assert.equal(r.trees.length, 3);
  assert.equal(r.trees[2], r.trees[1], 'the retry sends the identical tree');
  assert.equal(Buffer.byteLength(r.trees[2]), 1461);
  assert.equal(resumed.entry.tree, r.f.expected());
  assert.equal(r.f.remote(), resumed.entry.commit, 'one deterministic commit for the State');
});

test('a second tree failure stays terminal with GitHub message; unnamed or foreign blobs are not uploaded', async () => {
  const r = invalidBlobReplay();
  const plan = await prepareMirror(r.f.seed, r.io);
  r.replies.push(notValid(r.named), notValid(r.named));
  const blobs = () => r.f.calls.filter(call => call.path.endsWith('/blobs')).length;
  await assert.rejects(stepMirror(plan, r.io), e => {
    assert.equal(e.code, 'GITHUB_SYNC_API');
    assert.equal(e.status, 422);
    assert.match(e.message, new RegExp(`GitHub error: "tree.sha ${r.named} is not a valid blob"`));
    assert.match(e.message, /re-uploaded 1 named blob\(s\) and retried the tree once; not retried again\./);
    return true;
  });
  assert.equal(r.trees.length, 2, 'one retry, no loop');
  assert.equal(blobs(), 13, '12 window blobs + the one named blob');
  assert.equal(r.f.remote(), r.f.root.commit, 'no ref change');
  // A SHA that is not one of this tree's blob entries is not ours to upload.
  const cursor = JSON.parse(JSON.stringify(plan));
  r.replies.push(notValid('f'.repeat(40)));
  await assert.rejects(stepMirror(cursor, r.io), e => e.status === 422 && !/re-uploaded/.test(e.message));
  assert.equal(r.trees.length, 3);
  assert.equal(blobs(), 13);
});
