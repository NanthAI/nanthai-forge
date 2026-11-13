// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../scripts/bench-t3code/github-arm.mjs';

test('GitHub settle and evidence reads survive a transient 502 without voiding the cell', async () => {
  for (const args of [
    ['pr', 'list', '--state', 'open', '--json', 'number,autoMergeRequest'],
    ['api', '--paginate', '--slurp', 'repos/example/project/actions/runs'],
    ['api', 'repos/example/project/actions/jobs/1/logs'],
  ]) {
    const delays = [];
    let attempts = 0;
    const result = await github.gh(args, {
      execute: async () => {
        if (++attempts === 1) throw Object.assign(Error('gh failed'), { stderr: 'HTTP 502 Bad Gateway' });
        return { stdout: '[]' };
      },
      pause: async ms => delays.push(ms),
    });
    assert.equal(result, '[]');
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [250]);
  }
});

for (const failure of [
  Object.assign(Error('gh failed'), { stderr: 'GraphQL: Something went wrong (HTTP 503)' }),
  Error('HTTP/2 504 Gateway Timeout'),
  Object.assign(Error('socket closed'), { code: 'ECONNRESET' }),
  Error('Get "https://api.github.com/repos/example/project": unexpected EOF'),
  Error('error connecting to api.github.com'),
  Error('dial tcp: lookup api.github.com: no such host'),
])
  test(`GitHub reads stop after three transient failures: ${failure.message}`, async () => {
    let attempts = 0;
    const delays = [];
    await assert.rejects(
      github.gh(['api', 'repos/example/project'], {
        execute: async () => {
          attempts++;
          throw failure;
        },
        pause: async ms => delays.push(ms),
      }),
      error => error === failure,
    );
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [250, 500]);
  });

for (const message of [
  'HTTP 400 Bad Request',
  'HTTP 401 Bad credentials',
  'HTTP 403 Forbidden',
  'HTTP 404 Not Found',
  'HTTP 429 Too Many Requests',
  'HTTP 403: rate limited (upstream reported HTTP 502)',
  'GraphQL: Could not resolve repository',
  'invalid JSON',
])
  test(`GitHub reads preserve non-transient failures immediately: ${message}`, async () => {
    const failure = Error(message);
    let attempts = 0;
    await assert.rejects(
      github.gh(['pr', 'list'], {
        execute: async () => {
          attempts++;
          throw failure;
        },
        pause: () => assert.fail('must not back off'),
      }),
      error => error === failure,
    );
    assert.equal(attempts, 1);
  });

for (const args of [
  ['pr', 'create'],
  ['pr', 'merge'],
  ['pr', 'close'],
  ['run', 'cancel'],
  ['api', '-X', 'POST', 'repos/example/project/statuses/abc'],
  ['api', '--method=PATCH', 'repos/example/project/git/refs/heads/main'],
  ['api', '-XDELETE', 'repos/example/project/git/refs/heads/topic'],
  ['api', 'repos/example/project/issues', '-f', 'title=example'],
  ['api', 'repos/example/project/issues', '-Ftitle=example'],
  ['api', 'repos/example/project/issues', '--raw-field=title=example'],
  ['api', 'repos/example/project/issues', '--field', 'title=example'],
  ['api', 'repos/example/project/issues', '--input=payload.json'],
  ['api', 'graphql', '-f', 'query=mutation { example }'],
  ['api', '/graphql', '--method', 'GET'],
])
  test(`GitHub helper never blindly retries writes or unknown commands: ${args.join(' ')}`, async () => {
    const failure = Error('HTTP 502 Bad Gateway');
    let attempts = 0;
    await assert.rejects(
      github.gh(args, {
        execute: async () => {
          attempts++;
          throw failure;
        },
        pause: () => assert.fail('must not replay a write'),
      }),
      error => error === failure,
    );
    assert.equal(attempts, 1);
  });

test('explicit GET API fields remain retryable reads and healthy reads never back off', async () => {
  let attempts = 0;
  assert.equal(
    await github.gh(['api', '--method', 'GET', 'repos/example/project/issues', '-f', 'state=all'], {
      execute: async () => {
        if (++attempts < 3) throw Error('HTTP 502 Bad Gateway');
        return { stdout: 'evidence' };
      },
      pause: async () => {},
    }),
    'evidence',
  );
  assert.equal(attempts, 3);
  attempts = 0;
  assert.equal(
    await github.gh(['api', 'repos/example/project'], {
      execute: async () => {
        attempts++;
        return { stdout: 'evidence' };
      },
      pause: () => assert.fail('healthy reads do not wait'),
    }),
    'evidence',
  );
  assert.equal(attempts, 1);
});
