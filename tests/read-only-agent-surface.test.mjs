// SPDX-License-Identifier: Apache-2.0
import './automatic-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { hostedAgentHelp } from '../dist/hosted-agent-help.js';
import { agentCli } from '../dist/agent-cli.js';
import { laneHousekeeping, pruneCli } from '../dist/lane-prune.js';
import { listLanes, recordLane } from '../dist/lane-registry.js';

const hour = 3_600_000;
const address = { url: 'https://fixture.invalid', projectId: 'project' };
function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-read-only-'));
  t.after(() => {
    for (const path of [directory, join(directory, 'state', 'forge', 'lanes'), join(directory, 'home')])
      try {
        chmodSync(path, 0o700);
      } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const stub = result => ({ dispatch: async () => ({ operationId: null, result }) });

test('planning reconcile:false writes no address receipt on a read-only filesystem (d56dfe49)', async t => {
  const directory = scratch(t),
    root = join(directory, 'home', 'clone');
  mkdirSync(root, { recursive: true });
  chmodSync(join(directory, 'home'), 0o500); // `clone.forge-client` cannot be created
  const response = await hostedAgentCli(
    root,
    'planning',
    { status: 'open', reconcile: false },
    address,
    stub({ items: [] }),
  );
  assert.deepEqual(response.result, { items: [] });
  assert(!existsSync(`${root}.forge-client`), 'a read-only planning read creates no local state');
  // The write is still refused for other actions on the same filesystem: the guard is the read-only mode, not a swallowed error.
  await assert.rejects(hostedAgentCli(root, 'status', {}, address, stub({})), /EACCES|EPERM|EROFS/);
});

test('an unchanged address receipt is not rewritten, so reads work once it is retained', async t => {
  const directory = scratch(t),
    root = join(directory, 'clone');
  mkdirSync(root);
  await hostedAgentCli(root, 'status', {}, address, stub({}));
  const receipt = join(`${root}.forge-client`, 'agent', 'address.json');
  assert.equal(readFileSync(receipt, 'utf8'), JSON.stringify(address));
  const agent = join(`${root}.forge-client`, 'agent');
  chmodSync(agent, 0o500);
  try {
    await hostedAgentCli(root, 'status', {}, address, stub({}));
    assert.equal(readFileSync(receipt, 'utf8'), JSON.stringify(address));
  } finally {
    chmodSync(agent, 0o700);
  }
});

function laneRoot(directory, name, laneId, ageHours, now) {
  const root = join(directory, name);
  mkdirSync(join(root, '.forge'), { recursive: true });
  const marker = join(root, '.forge', 'hosted-lane.json');
  writeFileSync(marker, JSON.stringify({ url: address.url, selection: { laneId, projectId: 'project' } }));
  writeFileSync(join(root, 'a.txt'), 'synthetic\n');
  const old = new Date(now - ageHours * hour);
  for (const path of [marker, join(root, 'a.txt'), join(root, '.forge'), root]) utimesSync(path, old, old);
  return root;
}

test('prune --scan without --apply mutates no registry, pin, link or checkout, and names wouldPrune (41a24da0)', async t => {
  const directory = scratch(t),
    state = join(directory, 'state'),
    saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() =>
    saved === undefined ? delete process.env.XDG_STATE_HOME : (process.env.XDG_STATE_HOME = saved),
  );
  const now = Date.now(),
    settings = { autoPruneHours: 3, idleLaneHours: 0 };
  const scanDir = join(directory, 'scan');
  mkdirSync(scanDir);
  const scanned = randomUUID(),
    registered = randomUUID(),
    gone = randomUUID();
  const scannedRoot = laneRoot(scanDir, 'scanned', scanned, 10, now);
  const registeredRoot = laneRoot(scanDir, 'registered', registered, 10, now);
  // One registered Lane whose root is gone (forgetLane would remove its file), one registered stale pin mirror.
  recordLane(
    { laneId: gone, root: join(scanDir, 'missing'), ...address, lastActionAt: now - 10 * hour },
    now,
  );
  recordLane(
    { laneId: registered, root: registeredRoot, ...address, pinned: true, lastActionAt: now - 10 * hour },
    now,
  );
  const snapshot = () =>
    readdirSync(join(state, 'forge', 'lanes'))
      .sort()
      .map(name => [name, readFileSync(join(state, 'forge', 'lanes', name), 'utf8')]);
  const before = snapshot();
  chmodSync(join(state, 'forge', 'lanes'), 0o500); // any registry write or deletion now throws
  const readStates = async (_address, ids) =>
    new Map(ids.map(id => [id, { state: 'completed', pinned: false }]));
  const dry = await laneHousekeeping({ readStates, apply: false, now, settings, scan: scanDir });
  assert.deepEqual(
    dry.wouldPrune.map(row => row.laneId).sort(),
    [scanned, registered].sort(),
    'the unregistered scanned Lane and the server-unpinned registered Lane are candidates',
  );
  assert.deepEqual(dry.pruned, []);
  assert.deepEqual(snapshot(), before, 'registry files unchanged: no adoption, forget or pin refresh');
  assert(existsSync(scannedRoot) && existsSync(registeredRoot));
  chmodSync(join(state, 'forge', 'lanes'), 0o700);
  const applied = await laneHousekeeping({ readStates, apply: true, now, settings, scan: scanDir });
  assert.deepEqual(applied.wouldPrune, []);
  assert.deepEqual(
    applied.pruned.map(row => row.laneId).sort(),
    [scanned, registered].sort(),
    'apply still adopts, prunes and forgets',
  );
  assert(!existsSync(scannedRoot));
  assert(!listLanes().some(entry => entry.laneId === gone), 'apply forgets the Lane whose root is gone');
});

test('pruneCli reports a dry scan as wouldPrune with pruned empty', async t => {
  const directory = scratch(t),
    saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(directory, 'state');
  t.after(() =>
    saved === undefined ? delete process.env.XDG_STATE_HOME : (process.env.XDG_STATE_HOME = saved),
  );
  const now = Date.now(),
    laneId = randomUUID(),
    scanDir = join(directory, 'scan');
  mkdirSync(scanDir);
  const root = laneRoot(scanDir, 'old', laneId, 10, now);
  const result = await pruneCli(
    ['--scan', scanDir],
    async (_a, ids) => new Map(ids.map(id => [id, 'completed'])),
  );
  assert.deepEqual(result.pruned, []);
  assert.deepEqual(
    result.wouldPrune.map(row => row.laneId),
    [laneId],
  );
  assert(existsSync(root), 'nothing was removed');
});

test('operator actions point to nforge x in help and in BAD_ARGUMENT hints (2b9f2402)', async () => {
  const help = hostedAgentHelp();
  assert.match(help, /x ACTION.*nforge x ROOT ACTION/);
  await assert.rejects(
    agentCli(['/unused/root', 'x', 'friction-triage', '{}']),
    error => error.code === 'BAD_ARGUMENT' && /nforge x ROOT ACTION/.test(error.message),
  );
  const { actionRoot } = await import('../dist/agent-verbs.js');
  assert.equal(actionRoot('friction-triage'), 'nforge x ROOT');
  assert.equal(actionRoot('prioritize'), 'nforge x ROOT');
  assert.equal(actionRoot('save'), 'nforge agent ROOT');
});
