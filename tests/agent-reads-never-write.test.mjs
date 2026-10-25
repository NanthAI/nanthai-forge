// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
} from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { READ_ONLY_ACTIONS } from '../dist/agent-read-actions.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { initNative } from '../dist/native-work.js';
import { PRESENCE } from '../dist/presence.js';

/** Paths a read may change, each with its reason. Everything else under .forge
 * (work.json, records, objects, receipts, presence in hosted-binding.json, Lane
 * sources) must stay byte-for-byte identical. The peers cache lives in tmpdir,
 * outside the owner, and is disposable acceleration. */
const ALLOWED = [
  {
    actions: ['diff', 'review'],
    path: /^\.forge\/work\/lane-[^/]+\//,
    why: 'diff/review re-materialize a cleaned Lane directory from its retained head; source bytes, not Work.',
  },
];

/** Relative path -> content hash for every file under .forge, Lane sources included. */
function snapshot(root) {
  const files = new Map();
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name),
        stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else
        files.set(
          relative(root, path),
          createHash('sha256')
            .update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path))
            .digest('hex'),
        );
    }
  };
  walk(join(root, '.forge'));
  return files;
}
/** Background workers started by the fixture's own writes (check controllers,
 * integration preview, presence) hold transient queue tickets. Wait until the
 * owner is quiet so every byte measured around a read belongs to that read. */
async function settled(root) {
  const deadline = performance.now() + 30_000;
  for (let previous; ; await delay(50)) {
    const current = snapshot(root),
      queued = [...current.keys()].some(path => /\/ticket\.json$/.test(path));
    if (!queued && previous && changedPaths(previous, current).length === 0) return current;
    assert.ok(performance.now() < deadline, 'owner background work settled');
    previous = current;
  }
}
function changedPaths(before, after) {
  return [...new Set([...after.keys(), ...before.keys()])].filter(
    path => before.get(path) !== after.get(path),
  );
}
function changed(before, after, action) {
  return changedPaths(before, after)
    .filter(path => !ALLOWED.some(allow => allow.actions.includes(action) && allow.path.test(path)))
    .sort();
}

async function fixture(t, mcp) {
  const root = mkdtempSync(join(tmpdir(), 'forge-reads-never-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'b.txt'), 'b\n');
  initNative(root);
  const agent = new AgentWorkflow(root, mcp),
    act = async (action, input = {}) => (await agent.dispatch({ action, ...input })).result;
  const first = await act('start', { outcome: 'First edit' }),
    second = await act('start', { outcome: 'Second edit' });
  writeFileSync(join(first.path, 'a.txt'), 'one\nFIRST\nthree\n');
  const saved = await act('checkpoint', { laneId: first.laneId, message: 'First' });
  const check = await act('define-check', {
    name: 'synthetic',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  const view = await act('compose', {
    operationId: randomUUID(),
    intentId: first.intentId,
    inputs: [{ laneId: first.laneId, head: saved.head }],
  });
  const run = await act('run', { viewId: view.viewId, checkId: check.checkId, wait: true });
  assert.equal(run.status, 'passed');
  // Overlapping live edits make peers build in-memory previews of both Lanes.
  writeFileSync(join(second.path, 'a.txt'), 'one\nSECOND\nthree\n');
  writeFileSync(join(first.path, 'a.txt'), 'one\nFIRST live\nthree\n');
  return { root, agent, act, first, second, saved, view, run };
}

const reads = f => [
  ['status', {}],
  ['status', { laneId: f.first.laneId }],
  ['status', { laneId: f.first.laneId, detail: true }],
  ['peers', { laneId: f.first.laneId }],
  ['peers', { laneId: f.second.laneId, detail: true }],
  ['brief', { situation: 'add-lane', laneId: f.first.laneId }],
  ['tests', { laneId: f.first.laneId }],
  ['diff', { laneId: f.second.laneId }],
  ['diff', { from: f.first.base, to: f.saved.head }],
  ['show', { laneId: f.first.laneId, path: 'a.txt' }],
  [
    'review',
    {
      kind: 'view',
      id: f.view.viewId,
      expectedHead: f.view.head,
      expectedBase: f.view.base,
      expectedStatus: f.view.status,
    },
  ],
  ['handoff-read', { laneId: f.first.laneId }],
  ['improve', {}],
  ['policy', {}],
  ['link', { laneId: f.first.laneId }],
  ['records', { collection: 'lanes' }],
  ['records', { collection: 'runs', status: 'passed' }],
  ['making-of', { intentId: f.first.intentId }],
  ['views', { laneId: f.first.laneId }],
  ['view', { viewId: f.view.viewId }],
  ['provenance', { viewId: f.view.viewId }],
  ['observe', { operationId: f.run.operationId }],
  ['log', { operationId: f.run.operationId }],
];

for (const mcp of [false, true])
  test(`${mcp ? 'MCP' : 'CLI'} read-only agent actions leave the owner .forge byte-for-byte unchanged`, async t => {
    const f = await fixture(t, mcp);
    // MCP activity is throttled per session; expire it so a read that touches presence is visible.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const covered = new Set();
    for (const [action, input] of reads(f)) {
      t.mock.timers.tick(PRESENCE.touchMs + 1);
      const before = await settled(f.root);
      await f.agent.dispatch({ action, ...input });
      assert.deepEqual(changed(before, snapshot(f.root), action), [], `${action} ${JSON.stringify(input)}`);
      covered.add(action);
    }
    const before = await settled(f.root);
    readPendingStatus(f.agent.work.store);
    assert.deepEqual(changed(before, snapshot(f.root), 'pending-status'), [], 'pending-status');
    // Every action classified read-only is exercised here.
    assert.deepEqual(
      [...READ_ONLY_ACTIONS].filter(action => !covered.has(action)),
      [],
    );
  });

test('repeated peers reads with overlapping live edits persist no preview States', async t => {
  const f = await fixture(t, false);
  const objects = () => readdirSync(join(f.root, '.forge', 'work', 'objects')).sort();
  const before = objects();
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(f.second.path, 'a.txt'), `one\nSECOND ${i}\nthree\n`);
    const peers = await f.act('peers', { laneId: f.second.laneId, detail: true });
    assert.ok(peers.conflicts?.length || peers.overlaps?.length, 'previews were computed');
  }
  assert.deepEqual(objects(), before);
});
