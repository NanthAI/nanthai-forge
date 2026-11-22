// SPDX-License-Identifier: Apache-2.0
// Incident 48835eea (Lane abcc3257, 2026-11-20): under load, `save --sync` twice reported success with
// the builder's edits left out of the head (once on an up-to-date sync that saved nothing, once after a
// killed sync replayed), and a killed event probe left a file that blocked the next apply. A reply that
// names a save now implies the checkout equals the saved head, or it fails UNSAVED_LANE_EDITS naming
// the files; save --sync saves before it syncs; a leftover probe never blocks an apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { digest } from '../dist/hash.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { filesystemEventHealth } from '../dist/filesystem-event-health.js';
import { preflightRuntime } from '../dist/agent-preflight.js';

const savedBlob = (root, path) =>
  readHostedLaneCheckout(root).state.files.find(file => file.path === path)?.blob;
const sourceCalls = calls =>
  calls.filter(call => /Save|upload|object/i.test(call.name)).map(call => call.name);

async function opened(t) {
  const s = await resolutionFixture(t, { overlap: false });
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  return { s, f: s.f, root: realpathSync(s.root) };
}

test('48835eea: an up-to-date save --sync saves a dirty file instead of reporting a sync that saved nothing', async t => {
  const { s, f, root } = await opened(t);
  writeFileSync(join(root, 'docs-sentence.md'), 'one docs sentence\n');
  const synced = await s.transport().dispatch('sync', { laneId: f.lane.laneId, apply: true });
  assert.equal(synced.result.saved.status, 'completed');
  assert.equal(savedBlob(root, 'docs-sentence.md'), digest(Buffer.from('one docs sentence\n')));
  assert.equal(readHostedLaneCheckout(root).selection.head, (await f.readLane(f.lane.laneId)).head);
});

test('48835eea: a clean save --sync makes no save, upload or object call, and the final check makes none', async t => {
  const { s, f } = await opened(t);
  const before = s.calls.length;
  const synced = await s.transport().dispatch('sync', { laneId: f.lane.laneId, apply: true });
  assert.equal(synced.result.saved, undefined);
  assert.deepEqual(sourceCalls(s.calls.slice(before)), []);
});

test('48835eea incident replay: a killed save --sync rerun after an edit names the edit instead of reporting success', async t => {
  const { s, f, root } = await opened(t);
  writeFileSync(join(root, 'round.txt'), 'round 5 change\n');
  const command = { laneId: f.lane.laneId, operationId: randomUUID(), apply: true };
  // The CLI dies once the server holds the sync (a T3 restart): its handoff and request stay retained.
  s.lose('projectHostedSyncJobs:submit');
  await assert.rejects(s.transport().dispatch('sync', command), /agent sync failed \(cause: [a-z-]+\)/);
  assert(existsSync(join(clientCacheRoot(root), 'sync-handoff.json')), 'the killed sync left its handoff');
  writeFileSync(join(root, 'after-kill.md'), 'edited after the kill\n');
  await assert.rejects(s.transport().dispatch('sync', command), error => {
    assert.equal(error.code, 'UNSAVED_LANE_EDITS');
    assert.deepEqual(error.recovery.unsaved.paths, ['after-kill.md']);
    assert.equal(error.recovery.next.action, 'save');
    assert.match(error.message, /after-kill\.md/);
    return true;
  });
  // The one named save takes it, and the next sync is clean.
  await s.transport().dispatch('save', {});
  assert.equal(savedBlob(root, 'after-kill.md'), digest(Buffer.from('edited after the kill\n')));
  assert.equal(savedBlob(root, 'round.txt'), digest(Buffer.from('round 5 change\n')));
});

async function keptDuringSync(t, syncCommand) {
  const { s, f, root } = await opened(t);
  f.moveMain({ overlap: true }); // main changes a.txt
  const original = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    const result = await original(ref, args);
    if (getFunctionName(ref) === 'projectHostedSyncJobs:submit') {
      writeFileSync(join(root, 'a.txt'), 'written during the sync\n');
      writeFileSync(join(root, 'during.txt'), 'a new file written during the sync\n');
    }
    return result;
  };
  let retained;
  try {
    await assert.rejects(
      s.transport().dispatch('sync', { laneId: f.lane.laneId, apply: true, ...syncCommand }),
      error => {
        retained = error.recovery;
        assert.equal(error.code, 'WORK_CONFLICT');
        return true;
      },
    );
  } finally {
    s.exchange.client.mutation = original;
  }
  const { action, ...next } = retained.next;
  assert.equal(action, 'recover-apply');
  return { s, root, next };
}

test('48835eea: an edit written while a sync runs on a path main changed goes to kept-apply, and recover-apply reports it as needing action', async t => {
  const { s, next } = await keptDuringSync(t, {});
  let handoff;
  await assert.rejects(s.transport().dispatch('recover-apply', next), error => {
    assert.equal(error.code, 'UNSAVED_LANE_EDITS');
    assert.equal(error.recovery.status, 'needs-action');
    assert.deepEqual(error.recovery.kept.paths, ['a.txt']);
    assert.equal(error.recovery.completed.status, 'applied', 'the apply itself finished');
    const kept = error.recovery.kept.directories[0];
    assert.equal(
      readFileSync(join(error.recovery.completed.preservedAt, 'a.txt'), 'utf8'),
      'written during the sync\n',
    );
    assert(existsSync(kept));
    assert.match(error.message, /not in the Lane head/);
    // The retained sync is the next step, never a bare save that would skip it.
    assert.equal(error.recovery.next.action, 'sync');
    assert.match(error.recovery.command, / sync /);
    handoff = error.recovery.next;
    return true;
  });
  // The sync replay takes the carried new file through its own final check: never a success.
  const { action, ...replay } = handoff;
  await assert.rejects(s.transport().dispatch(action, replay), error => {
    assert.equal(error.code, 'UNSAVED_LANE_EDITS');
    assert.deepEqual(error.recovery.unsaved.paths, ['during.txt']);
    return true;
  });
});

test('48835eea review: recovering a restack (cleanOnly) sync names the carried unsaved file itself', async t => {
  const { s, root, next } = await keptDuringSync(t, {});
  // A restack's sync (a stacked Lane's cleanOnly sync) retained this handoff: its replay makes no final check.
  const record = join(clientCacheRoot(root), `apply-blocked-${next.applyOperationId}.json`),
    retained = JSON.parse(readFileSync(record, 'utf8'));
  retained.handoff.command.cleanOnly = true;
  writeFileSync(record, JSON.stringify(retained));
  await assert.rejects(s.transport().dispatch('recover-apply', next), error => {
    assert.equal(error.code, 'UNSAVED_LANE_EDITS');
    assert.deepEqual(error.recovery.unsaved.paths, ['during.txt']);
    assert.equal(error.recovery.next.action, 'save');
    return true;
  });
});

test('48835eea: a SIGKILLed event probe leaves nothing in the checkout or its client cache, and a live one is kept', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-probe-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'checkout'),
    probes = join(clientCacheRoot(join(directory, 'checkout')), 'event-probe'),
    old = new Date(Date.now() - 120_000);
  mkdirSync(join(root, '.forge'), { recursive: true });
  // An older client's probe killed earlier left a folder inside the checkout.
  const legacy = join(root, '.forge', '.forge-event-probe-legacy');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'pulse'), 'probe');
  utimesSync(legacy, old, old);
  // A caller killed earlier left its run folder; another run is probing right now.
  const stale = join(probes, randomUUID()),
    live = join(probes, randomUUID());
  mkdirSync(stale, { recursive: true });
  utimesSync(stale, old, old);
  mkdirSync(live);
  let own;
  const health = filesystemEventHealth(root, (_executable, args) => {
    // This run is killed mid-attempt: its own cleanup never runs.
    own = join(probes, args.find(value => value.startsWith('--probe-id=')).slice('--probe-id='.length));
    mkdirSync(join(own, '.forge-event-probe-killed'), { recursive: true });
    return { stdout: '', signal: 'SIGKILL', error: new Error('ETIMEDOUT') };
  });
  assert.equal(health.ok, false);
  assert.equal(existsSync(own), false, "the killed run's folder is removed");
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(live), true, 'a concurrent live probe is never removed');
  assert.deepEqual(readdirSync(join(root, '.forge')), []);
});

test('48835eea: a probe folder an older client left in .forge no longer blocks the next sync apply', async t => {
  const { s, f, root } = await opened(t);
  mkdirSync(join(root, '.forge', '.forge-event-probe-abc123'));
  writeFileSync(join(root, '.forge', '.forge-event-probe-abc123', 'pulse'), 'probe');
  const userPath = '.forge-event-probe-abc123/pulse',
    userBytes = Buffer.from('user file\n');
  mkdirSync(join(root, '.forge-event-probe-abc123'));
  writeFileSync(join(root, userPath), userBytes);
  f.moveMain({ overlap: false });
  const synced = await s.transport().dispatch('sync', { laneId: f.lane.laneId, apply: true });
  assert.equal(synced.result.applied.head, (await f.readLane(f.lane.laneId)).head);
  assert(existsSync(join(root, 'accepted.txt')), 'main change installed');
  assert.equal(savedBlob(root, userPath), digest(userBytes), 'a user file with the same prefix is saved');
});

test('48835eea non-cause guard: with event health stubbed degraded, a save still takes an edit that kept its size and mtime', async t => {
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({
    ok: false,
    reason: 'synthetic degraded',
  }));
  const { s, root } = await opened(t);
  const path = join(root, 'a.txt'),
    before = statSync(path),
    original = readFileSync(path);
  const edited = Buffer.from(original.toString('utf8').replace(/./, ch => (ch === 'X' ? 'Y' : 'X')));
  assert.equal(edited.length, original.length);
  writeFileSync(path, edited);
  utimesSync(path, before.atime, before.mtime);
  const saved = await s.transport().dispatch('save', {});
  assert.equal(saved.result.outcome.status, 'completed');
  assert.equal(savedBlob(root, 'a.txt'), digest(edited));
});

test('48835eea review: two save --sync calls in a row each save their edits, even when both syncs are up to date', async t => {
  const { s, f, root } = await opened(t);
  writeFileSync(join(root, 'first.md'), 'first\n');
  await s.transport().dispatch('sync', { laneId: f.lane.laneId, apply: true });
  writeFileSync(join(root, 'second.md'), 'second\n');
  const again = await s.transport().dispatch('sync', { laneId: f.lane.laneId, apply: true });
  assert.equal(again.result.saved.status, 'completed');
  assert.equal(savedBlob(root, 'first.md'), digest(Buffer.from('first\n')));
  assert.equal(savedBlob(root, 'second.md'), digest(Buffer.from('second\n')));
});

test('48835eea review: a CRLF working copy of a text=auto file is saved without a false unsaved refusal', async t => {
  const { s, root } = await opened(t);
  writeFileSync(join(root, '.gitattributes'), '* text=auto\n');
  await s.transport().dispatch('save', {});
  writeFileSync(join(root, 'notes.txt'), 'one\r\ntwo\r\n');
  const saved = await s.transport().dispatch('save', {});
  assert.equal(saved.result.outcome.status, 'completed');
  assert.equal(savedBlob(root, 'notes.txt'), digest(Buffer.from('one\ntwo\n')));
});

test('48835eea review: a save-first refused for conflict markers names the same sync to run again, never a bare save', async t => {
  const { s, f, root } = await opened(t);
  writeFileSync(join(root, 'merge.txt'), '<<<<<<< lane\nmine\n=======\ntheirs\n>>>>>>> main\n');
  const command = { laneId: f.lane.laneId, apply: true };
  await assert.rejects(s.transport().dispatch('sync', command), error => {
    assert.equal(error.code, 'CONFLICT_MARKERS');
    assert.match(error.message, /^The sync did not run: /);
    assert.equal(error.recovery.next.action, 'sync');
    assert.match(error.recovery.command, / sync /);
    return true;
  });
});

test('48835eea review: keptOut reads this apply’s own receipt past 20 entries, counts checkout-*/delta-* copies, and never .forge metadata', async t => {
  const { keptOut, keptApplyEntry, keptApplyRoot } = await import('../dist/hosted-apply-kept.js');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-kept-out-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'checkout');
  mkdirSync(root);
  const kept = keptApplyRoot(root),
    entry = (id, rounds, extra = {}) => {
      mkdirSync(join(kept, id), { recursive: true });
      writeFileSync(join(kept, id, 'receipt.json'), JSON.stringify({ rounds, ...extra }));
      return id;
    };
  // 25 other Lanes' entries share the folder; this apply's entry is never missed by a capped listing.
  for (let i = 0; i < 25; i++)
    entry(randomUUID(), { r: [{ kind: 'edited', path: `other-${i}.txt`, digest: null }] });
  const id = entry(randomUUID(), {
    r: [
      { kind: 'edited', path: 'mine.txt', digest: null },
      { kind: 'extra', path: '.forge/private-note.json', digest: null },
    ],
  });
  assert.equal(keptApplyEntry(root, id).id, id);
  assert.deepEqual(keptOut(root, { applyOperationId: id }), {
    directories: [join(kept, id)],
    count: 1,
    paths: ['mine.txt'],
  });
  // Only Forge metadata kept: nothing missing from the head.
  const meta = entry(randomUUID(), {
    r: [{ kind: 'extra', path: '.forge/private-note.json', digest: null }],
  });
  assert.equal(keptOut(root, { applyOperationId: meta }), null);
  // Prior-checkout copies and an interrupted install's backup are moved-out bytes; files-* rounds are not.
  const copies = keptOut(root, {
    applyOperationId: meta,
    additionalPreservedAt: [
      join(kept, meta, `files-${randomUUID()}`),
      join(kept, meta, `checkout-${randomUUID()}`),
      join(kept, meta, 'delta-abc'),
    ],
  });
  assert.deepEqual(
    copies.directories.map(path =>
      path
        .split('/')
        .pop()
        .replace(/-[0-9a-f-]{36}$/, '-*'),
    ),
    ['checkout-*', 'delta-abc'],
  );
  // An apply that moved nothing has no folder: nothing kept, never a thrown read error.
  assert.equal(keptOut(root, { applyOperationId: randomUUID() }), null);
  // A held prior-checkout remainder, or an unreadable receipt, still names its folder.
  const held = entry(randomUUID(), {}, { held: true });
  assert.deepEqual(keptOut(root, { applyOperationId: held }).directories, [join(kept, held)]);
  const torn = randomUUID();
  mkdirSync(join(kept, torn));
  assert.deepEqual(keptOut(root, { applyOperationId: torn }).directories, [join(kept, torn)]);
});

test('48835eea review: recover-apply where nothing was moved returns success with no kept copy', async t => {
  const { keptOut } = await import('../dist/hosted-apply-kept.js');
  const { s, f, root } = await opened(t);
  f.moveMain({ overlap: false });
  // The local apply stops after the sync is submitted (its marker vanished); no local edit exists.
  const original = s.exchange.client.mutation,
    marker = join(root, '.forge', 'hosted-lane.json');
  let removed = false;
  s.exchange.client.mutation = async (ref, args) => {
    const result = await original(ref, args);
    if (getFunctionName(ref) === 'projectHostedSyncJobs:submit' && !removed) {
      removed = true;
      rmSync(marker);
    }
    return result;
  };
  let retained;
  try {
    await assert.rejects(
      s.transport().dispatch('sync', { laneId: f.lane.laneId, operationId: randomUUID(), apply: true }),
      error => {
        retained = error.recovery;
        return true;
      },
    );
  } finally {
    s.exchange.client.mutation = original;
  }
  assert(removed, 'the apply stopped after source submission');
  const { action, ...next } = retained.next;
  assert.equal(action, 'recover-apply');
  const recovered = await s.transport().dispatch('recover-apply', next);
  assert.equal(recovered.result.status, 'applied');
  assert.equal(recovered.result.kept, undefined, 'nothing kept');
  assert.equal(recovered.result.unsavedEdits, undefined);
  assert.equal(readHostedLaneCheckout(root).selection.head, (await f.readLane(f.lane.laneId)).head);
  assert.equal(keptOut(root, recovered.result), null, 'no Lane edit was kept out of the checkout');
});
