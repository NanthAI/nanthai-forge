// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { digest } from '../dist/hash.js';
async function fixture(t, paths) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-sync-client-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'client'),
    objects = new Map(),
    reads = [];
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const id = digest(bytes);
    objects.set(id, bytes);
    return id;
  };
  const files = [
    { path: 'a', blob: put('before\n'), mode: 'file' },
    { path: 'unaffected', blob: put('unchanged'), mode: 'file' },
  ];
  const state = entries =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: entries,
        at: '2026-01-01T00:00:00Z',
        message: 'synthetic',
      }),
    );
  let selection = {
    schema: 2,
    projectId: 'synthetic',
    laneId: randomUUID(),
    intentId: randomUUID(),
    base: { head: 'a'.repeat(64), receiptId: 'main' },
    head: state(files),
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    authority: { mode: 'server', epoch: 1 },
  };
  let duringDownload,
    allowed = true;
  const transport = {
    select: async () => {
      assert(allowed, 'current access revoked');
      return structuredClone(selection);
    },
    objects: async ids => ids.map(sha256 => ({ sha256, size: objects.get(sha256).length })),
    downloadToFile: async (pin, path) => {
      reads.push(pin.sha256);
      writeFileSync(path, objects.get(pin.sha256));
      await duringDownload?.(pin);
    },
  };
  const from = structuredClone(selection),
    url = 'https://synthetic.invalid';
  await checkoutHostedLane(
    root,
    {
      operationId: randomUUID(),
      url,
      projectId: from.projectId,
      laneId: from.laneId,
      ...(paths ? { paths } : {}),
    },
    transport,
  );
  const change = () => {
    selection = {
      ...selection,
      head: state([{ ...files[0], blob: put('after\n') }, files[1]]),
      version: selection.version + 1,
      sourceVersion: selection.sourceVersion + 1,
    };
  };
  change();
  reads.length = 0;
  const command = () => ({
    operationId: randomUUID(),
    url,
    status: 'merged',
    from: {
      laneId: from.laneId,
      head: from.head,
      version: from.version,
      sourceVersion: from.sourceVersion,
    },
    lane: structuredClone(selection),
  });
  return {
    root,
    files,
    reads,
    objects,
    transport,
    command,
    from,
    selection: () => structuredClone(selection),
    change,
    onDownload: fn => {
      duringDownload = fn;
    },
    revoke: () => {
      allowed = false;
    },
  };
}
test('explicit sync apply fetches only affected materialized objects and preserves sparse scope', async t => {
  const s = await fixture(t, ['a']),
    command = s.command();
  const result = await applyHostedSync(s.root, command, s.transport);
  assert.equal(result.head, command.lane.head);
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
  assert.equal(result.downloadedObjects, 2);
  assert(!s.reads.includes(s.files[1].blob));
  assert(!existsSync(join(s.root, 'unaffected')));
  assert.deepEqual(readHostedLaneCheckout(s.root).scope, ['a']);
  assert.equal(readHostedLaneCheckout(s.root).state.files.length, 2);
  writeFileSync(join(s.root, 'a'), 'new local edit');
  const replay = await applyHostedSync(s.root, command, s.transport);
  assert.equal(replay.replayed, true);
  assert.equal(replay.downloadedObjects, 0);
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'new local edit');
  s.revoke();
  await assert.rejects(applyHostedSync(s.root, command, s.transport), /access revoked/);
});
test('changed-on-disk during transfer is preserved with the old marker; retry resumes cached source', async t => {
  const s = await fixture(t),
    command = s.command();
  const before = readHostedLaneCheckout(s.root);
  s.onDownload(() => writeFileSync(join(s.root, 'a'), 'newer on disk'));
  await assert.rejects(applyHostedSync(s.root, command, s.transport), { code: 'WORK_CONFLICT' });
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'newer on disk');
  assert.deepEqual(readHostedLaneCheckout(s.root), before);
  s.onDownload(undefined);
  writeFileSync(join(s.root, 'a'), 'before\n');
  const result = await applyHostedSync(s.root, command, s.transport);
  assert.equal(result.downloadedObjects, 0);
  assert.equal(result.head, command.lane.head);
});
test('older interrupted apply cannot overwrite a newer checkout or newer server selection', async t => {
  const s = await fixture(t),
    old = s.command();
  let failed = false;
  s.onDownload(() => {
    if (!failed) {
      failed = true;
      throw new Error('interrupted transfer');
    }
  });
  await assert.rejects(applyHostedSync(s.root, old, s.transport), /interrupted/);
  s.onDownload(undefined);
  s.change();
  const current = s.selection();
  await checkoutHostedLane(
    s.root,
    { operationId: randomUUID(), url: old.url, projectId: current.projectId, laneId: current.laneId },
    s.transport,
  );
  const marker = readHostedLaneCheckout(s.root);
  await assert.rejects(applyHostedSync(s.root, old, s.transport), { code: 'WORK_STALE' });
  assert.deepEqual(readHostedLaneCheckout(s.root), marker);
  const fresh = {
    ...s.command(),
    from: {
      ...old.from,
      head: old.lane.head,
      version: old.lane.version,
      sourceVersion: old.lane.sourceVersion,
    },
  };
  await assert.rejects(applyHostedSync(s.root, fresh, s.transport), { code: 'WORK_STALE' });
});
for (const kind of ['deletion', 'mode', 'symlink', 'untracked'])
  test(`sync apply preserves a local ${kind}`, async t => {
    const s = await fixture(t),
      command = s.command();
    if (kind === 'deletion') rmSync(join(s.root, 'a'));
    if (kind === 'mode') chmodSync(join(s.root, 'a'), 0o755);
    if (kind === 'symlink') {
      rmSync(join(s.root, 'a'));
      symlinkSync('../elsewhere', join(s.root, 'a'));
    }
    if (kind === 'untracked') writeFileSync(join(s.root, 'untracked'), 'retained');
    await assert.rejects(applyHostedSync(s.root, command, s.transport), { code: 'WORK_CONFLICT' });
    assert.equal(readHostedLaneCheckout(s.root).selection.head, s.from.head);
  });
test('fresh apply rejects a newer remote head and changed original command explicitly', async t => {
  const s = await fixture(t),
    old = s.command();
  s.change();
  await assert.rejects(applyHostedSync(s.root, old, s.transport), { code: 'WORK_STALE' });
  const current = s.command();
  await applyHostedSync(s.root, current, s.transport);
  await assert.rejects(
    applyHostedSync(s.root, { ...current, from: { ...current.from, version: 99 } }, s.transport),
    { code: 'WORK_OPERATION_CHANGED' },
  );
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
});
