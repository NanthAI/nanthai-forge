// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { browserApproval } from '../dist/browser-approval.js';
import { githubJournalRoot, githubConnectCli } from '../dist/github-connect-cli.js';
import { HostedAgentJournal } from '../dist/hosted-agent-journal.js';

for (const tty of [true, false])
  for (const noBrowser of [true, false])
    test(`browser approval keeps the link and next step with tty=${tty}, noBrowser=${noBrowser}`, () => {
      const opened = [],
        lines = [];
      const url = 'https://forge.example/device?code=SYNTHETIC';
      browserApproval(url, noBrowser, {
        tty,
        open: value => opened.push(value),
        write: value => lines.push(value),
      });
      assert.deepEqual(opened, tty && !noBrowser ? [url] : []);
      assert.match(lines.join(''), /Approve in your browser; this command waits until you do/);
      assert(lines.join('').includes(url));
    });

test('GitHub connection recovery is in CLI state and replays without a project-id folder', async t => {
  const directory = temporaryDirectory(t, 'forge-connect-state-');
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  const address = { url: 'https://forge.example', projectId: 'opaque-project-id' };
  const root = githubJournalRoot(address);
  assert(root.startsWith(join(directory, 'forge', 'github')));
  const request = { repository: 'example/repo' };
  const journal = new HostedAgentJournal(root, address, 'river', 'github-connect', request);
  await journal.retain('connection', () => 'synthetic-result');
  const replay = new HostedAgentJournal(root, address, 'river', 'github-connect', request);
  assert.equal(replay.operationId, journal.operationId);
  assert.equal(replay.get('connection'), 'synthetic-result');
  assert(!existsSync(join(directory, `${address.projectId}.forge-client`)));
  assert.notEqual(githubJournalRoot({ ...address, url: 'https://other.example' }), root);
});

for (const tty of [true, false])
  for (const noBrowser of [true, false])
    test(`github connect preserves JSON and uses shared browser guidance with tty=${tty}, noBrowser=${noBrowser}`, async t => {
      const directory = temporaryDirectory(t, 'forge-connect-cli-');
      const previous = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = directory;
      t.after(() => {
        if (previous === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previous;
      });
      const opened = [],
        lines = [],
        stdout = [];
      t.mock.method(process.stdout, 'write', value => {
        stdout.push(value);
        return true;
      });
      const url = 'https://forge.example/approve/connection';
      let operationId, selectedRoot;
      const result = await githubConnectCli(
        [
          'connect',
          'opaque-project-id',
          '--url',
          'https://forge.example',
          '--repo',
          'example/repo',
          ...(noBrowser ? ['--no-browser'] : []),
        ],
        {
          transport: root => {
            selectedRoot = root;
            return {
              dispatch: async () => ({ result: { actor: 'river' } }),
              action: async () => ({ protected: true }),
              exchange: {
                client: {
                  action: async (_ref, input) => {
                    operationId = input.operationId;
                    return { status: 'waiting', authorizeUrl: url };
                  },
                },
              },
            };
          },
          subscribe: () => ({
            onUpdate: (_ref, _args, update) => {
              queueMicrotask(() =>
                update({
                  operationId,
                  status: 'completed',
                  repoId: 42,
                  code: null,
                  mirror: 'enabled',
                  direction: 'two-way',
                }),
              );
              return () => {};
            },
            close: async () => {},
          }),
          approve: (link, disabled) =>
            browserApproval(link, disabled, {
              tty,
              open: value => opened.push(value),
              write: value => lines.push(value),
            }),
        },
      );
      assert.deepEqual(opened, tty && !noBrowser ? [url] : []);
      assert.match(lines.join(''), /Approve in your browser/);
      assert(lines.join('').includes(url));
      assert.equal(JSON.parse(stdout.join('')).operationId, result.operationId);
      assert.equal(JSON.parse(stdout.join('')).authorizeUrl, url);
      assert.match(result.mirror, /Pause or Disconnect in Forge → Settings → GitHub mirror/);
      assert(!result.mirror.includes('autoPush'));
      assert(selectedRoot.startsWith(directory));
      assert(!existsSync(join(directory, 'opaque-project-id.forge-client')));
    });

// Item c63c2171: an agent's connect is the owner's decision on Forge; the CLI prints and opens that link, not GitHub's.
test('github connect from an agent prints and opens the Forge approval link and sends the agent words', async t => {
  const directory = temporaryDirectory(t, 'forge-connect-cli-');
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  const opened = [],
    lines = [],
    stdout = [],
    stderr = [];
  t.mock.method(process.stdout, 'write', value => (stdout.push(value), true));
  t.mock.method(process.stderr, 'write', value => (stderr.push(value), true));
  const github = 'https://github.com/login/oauth/authorize?state=synthetic';
  const forge = 'https://forge.example/approve?project=p&lane=setting%3Agithub-connect';
  let operationId, sent;
  await githubConnectCli(
    [
      'connect',
      'opaque-project-id',
      '--url',
      'https://forge.example',
      '--repo',
      'example/repo',
      '--reason',
      'Mirror main so reviewers on GitHub see it.',
    ],
    {
      transport: () => ({
        dispatch: async () => ({ result: { actor: 'river' } }),
        action: async () => ({ protected: true }),
        exchange: {
          client: {
            action: async (_ref, input) => {
              ({ operationId } = input);
              sent = input;
              return {
                status: 'waiting',
                authorizeUrl: github,
                approval: {
                  id: 'setting:github-connect',
                  status: 'requested',
                  url: forge,
                  next: 'Connecting GitHub needs the project owner.',
                },
              };
            },
          },
        },
      }),
      subscribe: () => ({
        onUpdate: (_ref, _args, update) => {
          queueMicrotask(() => update({ operationId, status: 'completed', repoId: 42, code: null }));
          return () => {};
        },
        close: async () => {},
      }),
      approve: (link, disabled) =>
        browserApproval(link, disabled, {
          tty: true,
          open: value => opened.push(value),
          write: value => lines.push(value),
        }),
    },
  );
  assert.deepEqual(opened, [forge], 'the owner opens the Forge decision, not GitHub');
  assert(lines.join('').includes(forge));
  assert.equal(JSON.parse(stdout.join('')).approval.url, forge);
  assert.match(stderr.join(''), /needs the project owner/);
  assert.equal(sent.reason, 'Mirror main so reviewers on GitHub see it.');
});

test('browser approval never launches a non-web protocol from a malformed service reply', () => {
  assert.throws(
    () =>
      browserApproval('file:///synthetic', false, {
        tty: true,
        open: () => assert.fail('No opener'),
        write: () => {},
      }),
    { code: 'HOSTED_PROTOCOL_INVALID' },
  );
});
