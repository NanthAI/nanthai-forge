// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { finishSourceFingerprint } from '../dist/hosted-agent-finish-identity.js';
import { hostedLaneDirty } from '../dist/hosted-lane-dirty.js';
import { checkoutStatIndexName, indexedBlob, racyMarginMs } from '../dist/checkout-stat-index.js';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import {
  LAND_INVOKED_ENV,
  landTiming,
  landTimingLine,
  markLandStep,
  startLandTiming,
} from '../dist/land-timing.js';
import { digest } from '../dist/hash.js';

/** A thousand-file Lane opened through the real checkout path. */
async function openedLane(t, count = 1000) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-land-speed-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const objects = new Map(),
    put = value => {
      const bytes = Buffer.from(value),
        id = digest(bytes);
      objects.set(id, bytes);
      return id;
    };
  const files = Array.from({ length: count }, (_, i) => ({
    path: `pkg${i % 30}/file-${String(i).padStart(5, '0')}.ts`,
    blob: put(`export const value${i} = ${i};\n`),
    mode: 'file',
  })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const head = put(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files,
      message: 'synthetic',
      at: '2026-01-01T00:00:00Z',
    }),
  );
  const selection = {
    schema: 2,
    projectId: 'project',
    laneId: randomUUID(),
    intentId: randomUUID(),
    head,
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    base: { head: 'a'.repeat(64), receiptId: 'base' },
    authority: { mode: 'server', epoch: 1 },
  };
  const transport = {
    select: async () => structuredClone(selection),
    objects: async ids => ids.map(sha256 => ({ sha256, size: objects.get(sha256).length })),
    downloadToFile: async (pin, path) => writeFileSync(path, objects.get(pin.sha256), { mode: 0o600 }),
  };
  const root = join(directory, 'lane');
  await checkoutHostedLane(
    root,
    {
      url: 'https://fixture.invalid',
      projectId: 'project',
      laneId: selection.laneId,
      operationId: randomUUID(),
    },
    transport,
  );
  return { directory, root, files };
}
const files = marker => marker.state.files.map(file => file.path);
/** Source files under ROOT opened for reading while the test runs (marker and client files excluded). */
function countSourceReads(t, root) {
  const reads = [],
    originals = { openSync: fs.openSync, readFileSync: fs.readFileSync, readlinkSync: fs.readlinkSync };
  const prefixes = [...new Set([root, realpathSync(root)])].map(path => `${path}/`);
  const note = path => {
    const text = String(path),
      prefix = prefixes.find(value => text.startsWith(value));
    if (prefix && !text.startsWith(`${prefix}.forge/`)) reads.push(text.slice(prefix.length));
  };
  let depth = 0; // readFileSync opens through fs.openSync: count the outer call only
  for (const [name, original] of Object.entries(originals))
    fs[name] = function (path, ...rest) {
      if (depth === 0) note(path);
      depth++;
      try {
        return original.call(this, path, ...rest);
      } finally {
        depth--;
      }
    };
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  });
  return reads;
}

test('open indexes the checkout; capture, finish fingerprint and dirty read only edited files', async t => {
  const { root, directory } = await openedLane(t);
  const marker = readHostedLaneCheckout(root);
  const indexPath = `${root}.forge-client/${checkoutStatIndexName}`;
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  assert.equal(Object.keys(index.entries).length, 1000, 'open indexes every installed file');
  for (const file of marker.state.files) {
    const [size, mtimeMs, ctimeMs, ino, mode, blob] = index.entries[file.path],
      stat = lstatSync(join(root, file.path));
    assert.deepEqual(
      [size, mtimeMs, ctimeMs, ino, mode, blob],
      [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.mode, file.blob],
    );
  }
  // Replay of the hosted flake: on a loaded runner the install of the last files finishes in the
  // same clock tick as the index snapshot. Touch the last files now, then age the index below.
  for (const file of marker.state.files.slice(-25)) {
    const path = join(root, file.path);
    writeFileSync(path, readFileSync(path));
    const stat = lstatSync(path);
    index.entries[file.path] = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.mode, file.blob];
  }
  // As if the Lane was opened a while ago: these installs are now outside the racy window. The
  // reader also bounds `since` by the index file's own mtime (the file system's clock after the
  // observations), so age that too; `since` alone would be clamped to the moment of this write.
  const aged = Date.now() + 5_000;
  writeFileSync(indexPath, JSON.stringify({ ...index, since: aged }));
  utimesSync(indexPath, new Date(aged), new Date(aged));
  // A same-size edit with its mtime restored: only ctime moves. It must still count as changed.
  const edited = files(marker)[17],
    before = statSync(join(root, edited)),
    original = readFileSync(join(root, edited), 'utf8');
  writeFileSync(
    join(root, edited),
    original.replace(/\d;/, digit => `${(Number(digit[0]) + 1) % 10};`),
  );
  assert.notEqual(readFileSync(join(root, edited), 'utf8'), original);
  utimesSync(join(root, edited), before.atime, before.mtime);
  assert.equal(statSync(join(root, edited)).size, before.size);
  // The fingerprint every finish selection compares, computed by reading every file.
  renameSync(indexPath, `${indexPath}.aside`);
  const full = finishSourceFingerprint(root, {});
  renameSync(`${indexPath}.aside`, indexPath);
  // Budget: with the index, finish fingerprint, dirty check and capture open only the edited file.
  const reads = countSourceReads(t, root);
  assert.equal(finishSourceFingerprint(root, {}), full, 'same fingerprint without reading');
  const perPass = [reads.length];
  assert.equal(hostedLaneDirty(root), true);
  perPass.push(reads.length);
  const capture = await captureHostedSave(root, join(directory, 'capture'));
  perPass.push(reads.length);
  assert.deepEqual(
    capture.changes.map(change => change.path),
    [edited],
  );
  assert.deepEqual(reads, [edited, edited, edited], 'unchanged files are never opened');
  assert.deepEqual(perPass, [1, 2, 3], 'the edited file is read once per pass');
  assert.equal(capture.changes[0].after.blob, digest(readFileSync(join(root, edited))));
  // Capture rewrote the index; the edited file is now tied to its new blob, not the baseline,
  // so after reverting the edit it is read again and found clean.
  assert.equal(JSON.parse(readFileSync(indexPath, 'utf8')).entries[edited][5], capture.changes[0].after.blob);
  writeFileSync(join(root, edited), original);
  assert.equal(hostedLaneDirty(root), false);
});

test('a stat inside the racy window, or any stat or blob mismatch, is never trusted', () => {
  const since = 1_700_000_000_500,
    stat = { size: 3, mtimeMs: since - 300.25, ctimeMs: since - 300.25, ino: 7, mode: 0o100644 },
    entry = [3, stat.mtimeMs, stat.ctimeMs, 7, 0o100644, 'b'.repeat(64)],
    index = { since, entries: new Map([['a.ts', entry]]) };
  assert.equal(indexedBlob(index, 'a.ts', stat, 'b'.repeat(64)), 'b'.repeat(64));
  assert.equal(indexedBlob(index, 'a.ts', stat, 'c'.repeat(64)), undefined, 'baseline moved');
  for (const field of ['size', 'mtimeMs', 'ctimeMs', 'ino', 'mode'])
    assert.equal(
      indexedBlob(index, 'a.ts', { ...stat, [field]: stat[field] + 1 }, 'b'.repeat(64)),
      undefined,
      field,
    );
  // Sub-second clocks: a change within ~one tick before observation may hide in that tick.
  const racy = { ...stat, mtimeMs: since - 50.5, ctimeMs: since - 50.5 };
  assert.equal(
    indexedBlob(
      { since, entries: new Map([['a.ts', [3, racy.mtimeMs, racy.ctimeMs, 7, 0o100644, 'b'.repeat(64)]]]) },
      'a.ts',
      racy,
      'b'.repeat(64),
    ),
    undefined,
  );
  // Whole-second clocks (HFS+, FAT): anything within two seconds is read.
  const coarse = { ...stat, mtimeMs: 1_700_000_000_000 - 1000, ctimeMs: 1_700_000_000_000 - 1000 };
  assert.equal(racyMarginMs(coarse), 2000);
  assert.equal(
    indexedBlob(
      {
        since,
        entries: new Map([['a.ts', [3, coarse.mtimeMs, coarse.ctimeMs, 7, 0o100644, 'b'.repeat(64)]]]),
      },
      'a.ts',
      coarse,
      'b'.repeat(64),
    ),
    undefined,
  );
  assert.equal(indexedBlob(index, 'other.ts', stat, 'b'.repeat(64)), undefined, 'unindexed');
});

test('land --save receipt splits the time before submission and prints one line', async t => {
  // The submitter process started 400 ms after the user's command.
  const origin = performance.timeOrigin;
  startLandTiming(origin - 400);
  markLandStep('ready', origin + 600);
  markLandStep('saveStarted', origin + 700);
  markLandStep('captured', origin + 1_200);
  markLandStep('captured', origin + 9_999); // a replay keeps the first time
  markLandStep('saved', origin + 6_600);
  markLandStep('submitted', origin + 7_600);
  const timing = landTiming();
  assert.equal(timing.totalMs, 8_000);
  assert.deepEqual(timing.stepsMs, {
    spawn: 400,
    connect: 600,
    select: 100,
    capture: 500,
    saveJob: 5_400,
    submit: 1_000,
  });
  assert.equal(
    landTimingLine(timing),
    'land: submitted in 8.0 s (spawn 0.4, connect 0.6, select 0.1, capture 0.5, saveJob 5.4, submit 1.0)',
  );

  // The submitter attaches it to the receipt, timed from the user's command (passed by env).
  const root = mkdtempSync(join(tmpdir(), 'forge-land-timing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saved = process.env[LAND_INVOKED_ENV];
  process.env[LAND_INVOKED_ENV] = String(Date.now() - 2_000);
  t.after(() => {
    if (saved === undefined) delete process.env[LAND_INVOKED_ENV];
    else process.env[LAND_INVOKED_ENV] = saved;
  });
  const lines = [],
    write = process.stderr.write;
  process.stderr.write = chunk => (lines.push(String(chunk)), true);
  t.after(() => (process.stderr.write = write));
  const transport = {
    dispatch: async () => {
      markLandStep('saveStarted');
      markLandStep('submitted');
      return {
        schema: 1,
        transport: 'hosted',
        action: 'finish',
        operationId: randomUUID(),
        resolved: null,
        result: { phase: 'finish', submission: { phase: 'queued' } },
      };
    },
  };
  const response = await submitHostedLand(
    root,
    { message: 'm' },
    { url: 'https://x.invalid', projectId: 'p' },
    transport,
    0,
  );
  assert(response.landTiming.totalMs >= 2_000, 'includes time before the submitter started');
  assert.equal(typeof response.landTiming.stepsMs.submit, 'number');
  assert.match(lines.join(''), /land: submitted in \d+\.\d s \(spawn /);
});
