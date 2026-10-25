// SPDX-License-Identifier: Apache-2.0
// Offline only: create a synthetic owner; never accept an existing owner path.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { NativeSource } from '../dist/native-source.js';

const directory = mkdtempSync('/tmp/forge-b1-rollback-');
const owner = join(directory, 'owner');
const target = join(directory, 'restored');
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const commands = [];
const env = {
  PATH: process.env.PATH,
  HOME: join(directory, 'home'),
  TMPDIR: directory,
  FORGE_CHECK_QUEUE_DIR: join(directory, 'check-queue'),
};
mkdirSync(env.HOME);
function command(...args) {
  commands.push(['node', 'dist/cli.js', ...args]);
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' }));
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
mkdirSync(owner);
writeFileSync(join(owner, 'main.txt'), 'initial main\n');
writeFileSync(join(owner, 'bytes.bin'), Buffer.from([0, 255, 128, 10]));
writeFileSync(join(owner, 'execute.sh'), '#!/bin/sh\nexit 0\n');
chmodSync(join(owner, 'execute.sh'), 0o700);
command('init-native', owner);
const work = new WorkService(owner);
const act = input => work.execute({ operationId: randomUUID(), ...input }, work.status().revision).result;
const intent = act({ action: 'intent', outcome: 'Synthetic rollback point' });
const lane = act({ action: 'lane', intentId: intent.id, name: 'Saved source' });
function accept(text, previous) {
  writeFileSync(join(work.store.path(lane.id), 'main.txt'), text);
  const observed = work.status().lanes.find(item => item.id === lane.id);
  const saved = act({
    action: 'checkpoint',
    laneId: lane.id,
    expectedHead: observed.actualHead,
    expectedTree: observed.indexTree,
    message: text.trim(),
  });
  const view = act({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: saved.head }],
  });
  return act({
    action: 'accept-channel',
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: previous,
  });
}
const accepted = accept('snapshotted main\n', null);
const before = new WorkStore(owner).snapshotBytes();
const source = new NativeSource(owner);
const main = source.state(accepted.head);
const originals = main.files.map(file => ({ ...file, bytes: source.object(file.blob) }));
const revision = work.status().revision;
const backup = command(
  'work',
  owner,
  JSON.stringify({ action: 'export-work', archive: true }),
  String(revision),
).result;
assert.deepEqual(new WorkStore(owner).snapshotBytes(), before, 'Export must not change Work');
const advanced = accept('later main; replay needed after rollback\n', accepted.head);
assert.notEqual(advanced.head, accepted.head);
const restored = command('restore-native', backup.archive.path, target);
// restore-native returns the bootstrap State; accepted main is in channelMoves.
assert.equal(restored.head, JSON.parse(before).nativeHead);
assert.equal(restored.revision, revision);
assert.deepEqual(new WorkStore(target).snapshotBytes(), before, 'Portable Work records differ');
assert.deepEqual(new WorkStore(target).load(), JSON.parse(before), 'Hydrated Work records differ');
const recovered = new NativeSource(target);
assert.deepEqual(recovered.object(accepted.head), source.object(accepted.head), 'Main State bytes differ');
const mainDirectory = join(directory, 'restored-main');
recovered.materialize(accepted.head, mainDirectory, false);
for (const file of originals) {
  assert.deepEqual(recovered.object(file.blob), file.bytes, file.path);
  assert.deepEqual(readFileSync(join(mainDirectory, file.path)), file.bytes, file.path);
  assert.equal(Boolean(lstatSync(join(mainDirectory, file.path)).mode & 0o111), file.mode === 'executable');
}
assert.equal(new WorkService(target).status().channels[0].moveId, accepted.id);
assert.equal(
  new WorkService(owner).status().channels[0].moveId,
  advanced.id,
  'Original owner was overwritten',
);
const verified = command(
  'work',
  target,
  JSON.stringify({ action: 'inspect-native-objects' }),
  String(revision),
);
assert.equal(verified.result.removed.length, 0);
console.log(
  JSON.stringify(
    {
      directory,
      commands,
      main: accepted.head,
      receipt: accepted.id,
      revision,
      files: originals.length,
      mainStateSha256: hash(recovered.object(accepted.head)),
      workSha256: hash(before),
      archiveSha256: backup.archive.sha256,
      byteIdenticalMain: true,
      byteIdenticalRecords: true,
      originalLaterMainPreserved: true,
      nativeObjectVerification: verified.result,
      unrun: [
        'hosted authority transition and epoch fencing',
        'hosted-only recovery folding',
        'Route A and Route B hosted drills',
      ],
    },
    null,
    2,
  ),
);
