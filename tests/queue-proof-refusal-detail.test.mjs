// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 168e4ed8: QUEUE_PROOF_REQUIRED names every missing core path with its next step, and the
// changed files no registered replay can reach (a pure schema module) with what to do instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coreQueuePath, REGISTRY, registeredQueueReplays } from '../scripts/core-queue-paths.mjs';
import { queueProofDetail, queueProofMessage, REFRESH_QUEUE_PROOF } from '../scripts/test-queue-proof.mjs';

const registry = readFileSync(new URL(`../${REGISTRY}`, import.meta.url), 'utf8');
const reached = [...new Set(registeredQueueReplays(registry).flatMap(entry => entry.paths ?? []))]
  .filter(coreQueuePath)
  .sort();
// Fields only: its code all runs at load, so no replay records it.
const schemaOnly = 'convex/projectHostedComposeFields.ts';

test('Item 168e4ed8: a change missing proof on 22 core paths and one schema module names each with its next step', () => {
  assert(
    coreQueuePath(schemaOnly) && !reached.includes(schemaOnly),
    'the fixture file is core and unreached',
  );
  const missing = [...reached.slice(0, 22), schemaOnly].sort();
  const stale = new Map([[reached[22], ['.nforge/queue-proofs/old.json']]]);
  const message = queueProofMessage({ missing, stale });
  for (const path of [...missing, reached[22]]) assert(message.includes(path), `the message names ${path}`);
  assert.doesNotMatch(message, /and \d+ more/);

  const detail = queueProofDetail({ missing, stale }, registry);
  assert.deepEqual(
    detail.missing.map(item => item.path),
    missing.filter(path => path !== schemaOnly),
  );
  for (const item of detail.missing) {
    assert(item.replays.length >= 1, `${item.path} names a replay that reaches it`);
    assert(item.next.includes(REFRESH_QUEUE_PROOF), `${item.path} carries the refresh command`);
  }
  assert.deepEqual(
    detail.uncoverable.map(item => item.path),
    [schemaOnly],
  );
  assert.match(detail.uncoverable[0].next, /pure schema or validator module.*on-path bench cell/);
  assert.deepEqual(detail.stale, [
    {
      path: reached[22],
      proofs: ['.nforge/queue-proofs/old.json'],
      next: `\`${REFRESH_QUEUE_PROOF} .nforge/queue-proofs/old.json\``,
    },
  ]);
});
