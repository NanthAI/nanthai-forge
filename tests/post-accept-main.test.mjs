// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainPostAccept } from '../dist/post-accept-main.js';

for (const completed of [false, true])
  test(`an idle audit drain takes no Work writer lock (${completed ? 'already audited' : 'no requests'})`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-idle-audit-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const data = {
      channelMoves: completed
        ? [
            {
              id: 'acceptance',
              channel: 'main',
              status: 'accepted',
              head: 'saved-main',
              postAccept: { checkId: 'verify' },
              postAcceptRunId: 'audit',
            },
          ]
        : [],
      runs: completed
        ? [
            {
              id: 'audit',
              head: 'saved-main',
              mainCheck: { channel: 'main' },
              status: 'passed',
              endedAt: '2026-01-01T00:00:00.000Z',
              check: { id: 'verify', definition: 'definition' },
            },
          ]
        : [],
      checks: [{ id: 'verify', definition: 'definition' }],
      intents: [],
      views: [],
    };
    // Model a detached wake arriving after another driver drained the audit.
    // A foreground checkpoint can have zero lock patience at this point.
    const before = structuredClone(data);
    await drainPostAccept({
      directory,
      native: false,
      load: () => structuredClone(data),
      locked: () => assert.fail('Completed audit must not contend with a foreground writer'),
    });
    assert.deepEqual(data, before);
  });
