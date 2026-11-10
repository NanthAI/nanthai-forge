// SPDX-License-Identifier: Apache-2.0
// Guard for the docs promise "a normal user never needs a Forge background process"
// (docs/quickstart.md#no-background-process). Every place the client detaches a child is named here with
// its job. Entries marked owner-store belong to the local Git/native owner workflow, not to a hosted
// clone. A new detached child fails this test until it is listed and the quickstart section still holds.
// A child that stays resident on the hosted path needs an owner decision, not a line here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DETACHED_JOBS = {
  'auth-cli.ts': 'opens the login page in the system browser',
  'board-claim-queue.ts': 'sends one file-claim note from the first-write hook',
  'check-controller.ts': 'owner-store: drives one local check run',
  'cli-canary.ts': 'one canary run of a newly installed CLI build',
  'cli-version.ts': 'one background CLI update to the released build',
  'github-auto-push.ts': 'owner-store: pushes accepted main to a connected GitHub mirror',
  'host-command.ts': 'finishes the history backfill of one `nforge host` run',
  'hosted-land-cli.ts': 'submits one landing and relays its first lines',
  'hosted-snapshot-worker.ts': 'takes one unsaved-work snapshot of a Lane checkout, then exits',
  'integration-preview-auto.ts': 'owner-store: one integration preview after a saved event',
  'local-watcher-client.ts': 'owner-store: shared file-watch helper',
  'post-accept-main.ts': 'owner-store: applies one acceptance',
  'push-audit-wait.ts': 'waits on one mirror push audit',
  'self-metrics-weekly.ts': 'writes one weekly self-metrics report',
};

test('every detached client child is listed with its job', () => {
  const found = readdirSync(new URL('../src/', import.meta.url))
    .filter(name => name.endsWith('.ts'))
    .filter(name =>
      /\bdetached:\s*true\b/.test(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')),
    )
    // agent-stack.ts uses `detached` for a stacked Lane's state, not a process.
    .filter(name => name !== 'agent-stack.ts')
    .sort();
  assert.deepEqual(
    found,
    Object.keys(DETACHED_JOBS).sort(),
    'A detached child was added or removed: list its job here and keep docs/quickstart.md#no-background-process true.',
  );
});
