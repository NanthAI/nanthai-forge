// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 6b7d5a79: the first-write hook teaches three working rules at the moment they matter, from local state
// only (no server call): edits in the project's copy of main, edits during a live landing, and long unsaved work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from '../scripts/test-temp.mjs';

// A fixed fixture instant; the hints take `now` as an argument and read no clock here.
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
import { PeersCache } from '../dist/agent-peers-cache.js';
import {
  UNSAVED_HINT_MINUTES,
  cloneRootHint,
  cloneRootOf,
  laneEditHints,
} from '../dist/agent-edit-local-hints.js';

function folders(t) {
  const base = temporaryDirectory(t, 'forge-edit-hints-');
  const cache = new PeersCache(base, join(base, 'cache', 'peers'));
  const state = join(base, 'state');
  const prior = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
  });
  return { base, cache, state };
}
function lane(base, laneId = randomUUID()) {
  const root = join(base, `lane-${laneId.slice(0, 8)}`);
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(join(root, '.forge', 'hosted-lane.json'), '{}');
  return { root, laneId, path: 'src/a.ts', project: 'p', url: 'https://example.invalid' };
}

test('an edit in the project copy of main says once per session that Forge never saves it there, and where to work', t => {
  const { base, cache } = folders(t);
  const clone = join(base, 'project');
  mkdirSync(join(clone, '.forge'), { recursive: true });
  mkdirSync(join(clone, 'src'));
  writeFileSync(
    join(clone, '.forge', 'hosted-main.json'),
    JSON.stringify({ selection: { projectId: 'proj' }, state: { files: [] } }),
  );
  const found = cloneRootOf(join(clone, 'src', 'a.ts'));
  assert.deepEqual(found, { root: clone, projectId: 'proj' });
  const hint = cloneRootHint(found, 'session-1', cache);
  assert.match(hint, /copy of main, not a Lane/);
  assert.match(hint, /nforge agent '.*project' start '\{"outcome"/);
  assert.equal(cloneRootHint(found, 'session-1', cache), '', 'once per session');
  assert.notEqual(cloneRootHint(found, 'session-2', cache), '');
  // A Lane folder (even one placed inside the project folder) is never the copy of main.
  const nested = lane(clone);
  assert.equal(cloneRootOf(join(nested.root, 'src', 'a.ts')), null);
  assert.equal(cloneRootOf(join(base, 'elsewhere', 'a.ts')), null);
});

test('an edit while this machine has a live landing of the Lane names the wait and withdraw commands', t => {
  const { base, cache, state } = folders(t);
  const target = lane(base);
  assert.deepEqual(laneEditHints(target, NOW, cache), [], 'no landing, first write: nothing');
  const operationId = randomUUID();
  mkdirSync(join(state, 'forge', 'lanes'), { recursive: true });
  const entry = landing =>
    writeFileSync(
      join(state, 'forge', 'lanes', `${target.laneId}.json`),
      JSON.stringify({ laneId: target.laneId, landing }),
    );
  entry({ operationId, at: NOW });
  const [hint, ...rest] = laneEditHints(target, NOW, cache);
  assert.match(hint, /landing in flight; this edit is not in it/);
  assert.match(hint, new RegExp(`wait '\\{"operationIds":\\["${operationId}"\\]\\}'`));
  assert.match(hint, /land --withdraw/);
  assert.deepEqual(rest, [], 'no unsaved nudge while a landing is live');
  // Scratch under .forge/ (a land message) is never in a landing: no hint for it.
  assert.deepEqual(laneEditHints({ ...target, path: '.forge/scratch/land-message.txt' }, NOW, cache), []);
  // A landing recorded long ago settled without this machine seeing it: not live.
  entry({ operationId, at: NOW - 7 * 3_600_000 });
  assert.deepEqual(laneEditHints(target, NOW, cache), []);
});

test('unsaved edits past the checkpoint nudge get one save line per interval, measured from the first write after a save', t => {
  const { base, cache } = folders(t);
  const target = lane(base);
  const start = NOW;
  const minutes = n => start + n * 60_000;
  // A scratch write under .forge/ starts no stretch: a later tracked write starts it.
  const scratch = lane(base);
  assert.deepEqual(laneEditHints({ ...scratch, path: '.forge/scratch/notes.md' }, start, cache), []);
  assert.deepEqual(laneEditHints(scratch, minutes(UNSAVED_HINT_MINUTES), cache), []);
  assert.deepEqual(
    laneEditHints(scratch, minutes(UNSAVED_HINT_MINUTES + 1), cache),
    [],
    'stretch from minute 30',
  );
  assert.deepEqual(laneEditHints(target, start, cache), [], 'the first write starts the stretch');
  assert.deepEqual(laneEditHints(target, minutes(UNSAVED_HINT_MINUTES - 1), cache), []);
  const [nudge] = laneEditHints(target, minutes(UNSAVED_HINT_MINUTES), cache);
  assert.match(nudge, new RegExp(`unsaved edits for ${UNSAVED_HINT_MINUTES} min`));
  assert.match(nudge, /save '\{"message":"checkpoint"\}'/);
  assert.deepEqual(
    laneEditHints(target, minutes(UNSAVED_HINT_MINUTES + 5), cache),
    [],
    'quiet after a nudge',
  );
  assert.equal(laneEditHints(target, minutes(2 * UNSAVED_HINT_MINUTES), cache).length, 1);
  // A save rewrites the Lane marker: a new stretch starts at the next write.
  const marker = join(target.root, '.forge', 'hosted-lane.json');
  const saved = new Date(minutes(2 * UNSAVED_HINT_MINUTES + 1));
  utimesSync(marker, saved, saved);
  assert.deepEqual(laneEditHints(target, minutes(2 * UNSAVED_HINT_MINUTES + 2), cache), []);
  assert.deepEqual(laneEditHints(target, minutes(2 * UNSAVED_HINT_MINUTES + 10), cache), []);
});
