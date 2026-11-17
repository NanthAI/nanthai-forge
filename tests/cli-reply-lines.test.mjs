// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { cliReplyLines } from '../dist/cli-reply-lines.js';
import { migrationSummary } from '../dist/migration-ledger.js';
const agent = (action, result) => cliReplyLines(['agent', '.', action], { action, result });

test('terminal landing lines use retained titles, explicit units, human times and short source identities', () => {
  const result = {
    landings: [
      {
        title: 'Fix comparison',
        committedAt: 1_900_000_000_000,
        laneId: '12345678-full-lane',
        landedHead: 'a'.repeat(64),
        acceptedBy: { kind: 'person', actor: 'river' },
        costs: { runnerAccepted: 95.65, runnerDiscarded: null },
      },
    ],
  };
  const original = structuredClone(result);
  const [line] = agent('landings', result);
  assert.match(line, /Fix comparison/);
  assert.match(line, /UTC · State aaaaaaaa/);
  assert.match(line, /accepted by @river/);
  assert.match(line, /95.65 accepted runner-minutes, unknown discarded runner-minutes/);
  assert(!line.includes('a'.repeat(64)));
  assert.deepEqual(result, original, 'machine evidence stays intact');
  assert.match(agent('landings', { landings: [{}] })[0], /title unavailable.*time unknown/);
});

test('terminal read lines identify the actual Lane, Item and selected source without inferring missing facts', () => {
  assert.deepEqual(
    agent('lanes', { page: [{ laneId: 'abcdefgh-full', intent: 'Fix reader', state: 'active' }] }),
    ['Lane abcdefgh: Fix reader · active.'],
  );
  assert.deepEqual(
    agent('planning', { items: [{ id: 'abcdefgh-full', title: 'Fix reader', status: 'closed' }] }),
    ['Item abcdefgh: Fix reader · Done.'],
  );
  assert.deepEqual(agent('lanes', { page: [] }), ['No Lanes in this page.']);
  assert.match(
    agent('status', { head: 'b'.repeat(64), lastActivityAt: '2026-11-17T00:00:00Z' })[0],
    /Saved State bbbbbbbb · last activity 2026-11-17 00:00:00 UTC/,
  );
  assert.deepEqual(agent('status', { clone: { status: 'current' } }), ['Forge clone: current with main.']);
  assert.match(
    agent('status', { clone: { status: 'behind', sourceRevisionsBehind: 3, next: 'nforge pull .' } })[0],
    /3 source revisions.*nforge pull/,
  );
});

test('login summaries allow only the public handle and expiry, never credentials or device labels', () => {
  const sensitive = {
    authenticated: true,
    account: 'river',
    name: 'private-device-host',
    token: 'synthetic-secret',
    expiresAt: 1_900_000_000_000,
    identity: { device: 'other-person-device' },
  };
  const line = cliReplyLines(['auth', 'status'], sensitive).join('\n');
  assert.match(line, /Signed in as @river; expires .* UTC/);
  assert.doesNotMatch(line, /private-device|synthetic-secret|other-person-device/);
  assert.match(
    cliReplyLines(['auth', 'status'], {
      authenticated: false,
      state: 'expired',
      nextStep: 'nforge login',
    })[0],
    /Signed out.*nforge login/,
  );
});

test('import and check-settings summaries name progress, retained pointers and existing next steps', () => {
  const lines = cliReplyLines(['import'], {
    repository: 'example/repo',
    ready: true,
    completed: 42,
    files: 42,
    bytes: 1024,
    commit: 'c'.repeat(40),
    submodules: 1,
    next: 'nforge clone PROJECT DIR',
  });
  assert.match(lines[0], /ready for Lanes · 42 of 42 files · 1,024 bytes · commit cccccccc/);
  assert.match(lines[1], /1 submodules kept as pointers.*nforge clone/);
  assert.deepEqual(
    agent('check-settings', {
      definitions: [{ name: 'verify' }],
      runner: {},
      agentLandsOnPass: false,
      blockers: ['Waiting for review.'],
    }),
    ['Landing check: verify; runner configured; held for review.', 'Needs attention: Waiting for review.'],
  );
});

test('GitHub and approval summaries report the existing connection state and exact supplied link', () => {
  assert.deepEqual(
    cliReplyLines(['github', 'status'], { page: [{ fullName: 'example/repo', active: false }] }),
    ['GitHub example/repo: disconnected.'],
  );
  assert.deepEqual(
    agent('approve-link', { held: true, owner: 'river', url: 'https://forge.example/approve/exact' }),
    ['Held, waiting for @river. Open https://forge.example/approve/exact'],
  );
  assert.deepEqual(cliReplyLines(['mcp'], { token: 'synthetic-secret' }), []);
});

test('repository titles cannot inject terminal control sequences or extra reply lines', () => {
  const lines = agent('planning', { items: [{ id: 'id', title: 'One\nTwo\u001b[31m', status: 'open' }] });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /[\n\u001b]/);
});

test('readable import replies distinguish reported zero from unavailable migration counts without changing machine evidence', () => {
  const report = {
    repository: 'example/repo',
    ready: true,
    migrationSummary: migrationSummary({ issues: 0, pullRequests: null, branches: 2, collaborators: null }),
  };
  const original = structuredClone(report);
  const lines = cliReplyLines(['import'], report);
  assert.match(
    lines.join('\n'),
    /Issues 0, pull requests not reported, branch heads 2, collaborators not reported/,
  );
  assert.match(lines.join('\n'), /Git history is acquired separately/);
  assert.match(lines.join('\n'), /pull-request work, tags, CI run history and accounts are not imported/);
  assert.deepEqual(report, original);
  assert.equal(cliReplyLines(['import'], { repository: 'example/repo', ready: true }).length, 2);
});

test('field-projected authentication and planning counts never invent missing sign-in or list states', () => {
  assert.deepEqual(cliReplyLines(['auth', 'status', '--json', 'account'], { account: 'river' }), []);
  assert.deepEqual(agent('planning', { counts: { closed: 5 } }), []);
});
