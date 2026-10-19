import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkoutHostedMain } from '../dist/hosted-main-checkout.js';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
import { fixture, upload, modules } from './project-exchange-fixture.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const main = await import(moduleUrl('../convex/projectMain.ts'));
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hosted-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'client'),
    objects = new Map();
  const blob = text => {
    const bytes = Buffer.from(text);
    const id = digest(bytes);
    objects.set(id, bytes);
    return id;
  };
  const first = blob('first\n'),
    unchanged = blob('unchanged\n');
  const state = (a, parents = []) =>
    blob(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents,
        files: [
          { path: 'a.txt', blob: a, mode: 'file' },
          { path: 'bin/run', blob: unchanged, mode: 'executable' },
        ],
        message: 'synthetic',
        at: '2026-01-01T00:00:00Z',
      }),
    );
  const head = state(first);
  let selected = {
    schema: 1,
    projectId: 'project',
    generationId: 'generation',
    backupId: 'backup',
    channel: 'main',
    head,
    receipt: { id: 'receipt-a', kind: 'hosted', previousHead: null, previousReceiptId: null },
  };
  let allowed = true,
    fail = false,
    corrupt = false,
    reads = 0;
  const transport = {
    current: async () => {
      assert.ok(allowed, 'reader revoked');
      return structuredClone(selected);
    },
    objects: async ids => ids.map(sha256 => ({ sha256, size: objects.get(sha256).length })),
    downloadToFile: async (pin, path) => {
      reads++;
      if (fail && reads === 2) throw Error('lost response');
      writeFileSync(path, corrupt ? objects.get(pin.sha256).subarray(1) : objects.get(pin.sha256), {
        mode: 0o600,
      });
    },
  };
  const request = () => ({ url: 'https://fixture.invalid', projectId: 'project', operationId: randomUUID() });
  return {
    root,
    objects,
    transport,
    request,
    blob,
    state,
    head,
    unchanged,
    select: value => {
      selected = value;
    },
    selection: () => structuredClone(selected),
    access: value => {
      allowed = value;
    },
    fail: value => {
      fail = value;
    },
    corrupt: () => {
      corrupt = true;
    },
  };
}
test('exact hosted selected head; incremental wants and unchanged pull', async t => {
  const s = setup(t),
    initial = await checkoutHostedMain(s.root, s.request(), s.transport);
  assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'first\n');
  assert.equal(existsSync(join(s.root, '.forge/native.json')), false);
  const next = s.selection(),
    newBlob = s.blob('changed\n');
  next.head = s.state(newBlob, [s.head]);
  next.receipt = { id: 'receipt-b', kind: 'hosted', previousHead: s.head, previousReceiptId: 'receipt-a' };
  s.select(next);
  const full = await checkoutHostedMain(`${s.root}-cold`, s.request(), s.transport);
  const changed = await checkoutHostedMain(s.root, s.request(), s.transport);
  assert.equal(changed.downloadedObjects, 2);
  assert.equal(changed.downloadedBytes, s.objects.get(next.head).length + 8);
  assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'changed\n');
  const warm = await checkoutHostedMain(s.root, s.request(), s.transport);
  assert.equal(warm.downloadedObjects, 0);
  assert.equal(warm.downloadedBytes, 0);
  t.diagnostic(
    JSON.stringify({
      cold: { objects: initial.downloadedObjects, bytes: initial.downloadedBytes },
      fullCheckoutAfterChange: { objects: full.downloadedObjects, bytes: full.downloadedBytes },
      oneFileChange: { objects: changed.downloadedObjects, bytes: changed.downloadedBytes },
      unchanged: { objects: warm.downloadedObjects, bytes: warm.downloadedBytes },
    }),
  );
});
test('lost response resumes cached objects and completed operation never rewinds newer checkout', async t => {
  const s = setup(t),
    request = s.request();
  s.fail(true);
  await assert.rejects(checkoutHostedMain(s.root, request, s.transport), /lost response/);
  s.fail(false);
  const result = await checkoutHostedMain(s.root, request, s.transport);
  assert.equal(result.downloadedObjects, 2);
  writeFileSync(join(s.root, 'a.txt'), 'local edit');
  const replay = await checkoutHostedMain(s.root, request, s.transport);
  assert.equal(replay.replayed, true);
  assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'local edit');
  writeFileSync(join(s.root, 'a.txt'), 'first\n');
  const selected = s.selection();
  selected.head = s.state(s.blob('newer\n'), [s.head]);
  selected.receipt.id = 'newer-receipt';
  s.select(selected);
  await checkoutHostedMain(s.root, s.request(), s.transport);
  assert.equal((await checkoutHostedMain(s.root, request, s.transport)).replayed, true);
  assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'newer\n');
});
test('stale expected head, wrong project, revoked access and corruption refuse checkout', async t => {
  const s = setup(t);
  await assert.rejects(
    checkoutHostedMain(
      s.root,
      { ...s.request(), expected: { head: '0'.repeat(64), receiptId: 'old' } },
      s.transport,
    ),
    { code: 'CHANNEL_CHANGED' },
  );
  await assert.rejects(checkoutHostedMain(s.root, { ...s.request(), projectId: 'other' }, s.transport), {
    code: 'PROJECT_UNAVAILABLE',
  });
  s.corrupt();
  await assert.rejects(checkoutHostedMain(s.root, s.request(), s.transport), {
    code: 'INVALID_NATIVE_SOURCE',
  });
  assert.equal(existsSync(s.root), false);
  s.access(false);
  await assert.rejects(checkoutHostedMain(s.root, s.request(), s.transport), /revoked/);
});
test('dirty files and untracked content are preserved', async t => {
  const s = setup(t);
  await checkoutHostedMain(s.root, s.request(), s.transport);
  writeFileSync(join(s.root, 'untracked.txt'), 'keep');
  await assert.rejects(checkoutHostedMain(s.root, s.request(), s.transport), { code: 'WORK_CONFLICT' });
  assert.equal(readFileSync(join(s.root, 'untracked.txt'), 'utf8'), 'keep');
  rmSync(join(s.root, 'untracked.txt'));
  chmodSync(join(s.root, 'bin/run'), 0o644);
  await assert.rejects(checkoutHostedMain(s.root, s.request(), s.transport), { code: 'WORK_CONFLICT' });
});
function hostedFixture() {
  const s = fixture([]),
    head = 'a'.repeat(64);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    work: { backupId: 'backup', generationId: 'generation' },
  });
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    projectId: 'project',
    preview: { format: 'native' },
  });
  s.tables.projectWorkGenerations.set('generation', {
    _id: 'generation',
    projectId: 'project',
    backupId: 'backup',
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
  });
  function row(id, collection, key, value, position = 0) {
    s.tables.projectWorkRecords.set(id, {
      _id: id,
      generationId: 'generation',
      collection,
      key,
      parent: 'main',
      position,
      value: JSON.stringify(value),
    });
  }
  row('native', 'channelMoves', 'native-receipt', {
    id: 'native-receipt',
    head: 'b'.repeat(64),
    previous: null,
    status: 'accepted',
  });
  row('hosted', 'hostedChannels', 'main', { id: 'hosted-receipt', head, previousId: null });
  return { s, head };
}
test('server contract prefers hosted receipt over uploaded native main and checks expectation', async () => {
  const { s, head } = hostedFixture();
  const result = JSON.parse(await main.current._handler(s.ctx, { projectId: 'project' }));
  assert.equal(result.head, head);
  assert.equal(result.receipt.id, 'hosted-receipt');
  await assert.rejects(
    main.current._handler(s.ctx, {
      projectId: 'project',
      expected: { head: 'b'.repeat(64), receiptId: 'native-receipt' },
    }),
    /CHANNEL_CHANGED/,
  );
  await assert.rejects(
    main.current._handler(s.ctx, { projectId: 'project', expected: { head, receiptId: 'stale-receipt' } }),
    /CHANNEL_CHANGED/,
  );
  s.tables.projectWorkRecords.delete('hosted');
  assert.equal(
    JSON.parse(await main.current._handler(s.ctx, { projectId: 'project' })).receipt.id,
    'native-receipt',
  );
});
test('server refuses revoked readers, cross-project bindings and absent objects', async () => {
  const { s } = hostedFixture();
  s.tables.projectReaders.set('reader', { _id: 'reader', projectId: 'project', reader: 'reader' });
  s.caller('reader');
  await main.current._handler(s.ctx, { projectId: 'project' });
  s.tables.projectReaders.clear();
  await assert.rejects(main.current._handler(s.ctx, { projectId: 'project' }), /PROJECT_UNAVAILABLE/);
  await assert.rejects(
    main.objects._handler(s.ctx, { projectId: 'project', digests: ['a'.repeat(64)] }),
    /PROJECT_UNAVAILABLE/,
  );
  s.caller('owner');
  s.tables.projectBackups.get('backup').projectId = 'other';
  await assert.rejects(main.current._handler(s.ctx, { projectId: 'project' }), /SOURCE_UNAVAILABLE/);
});

test('interrupted old pull does not overwrite a newer checkout', async t => {
  const s = setup(t),
    original = s.request();
  s.fail(true);
  await assert.rejects(checkoutHostedMain(s.root, original, s.transport), /lost response/);
  s.fail(false);
  const selected = s.selection();
  selected.head = s.state(s.blob('newer\n'), [s.head]);
  selected.receipt.id = 'newer-receipt';
  s.select(selected);
  await checkoutHostedMain(s.root, s.request(), s.transport);
  await assert.rejects(checkoutHostedMain(s.root, original, s.transport), { code: 'CHANNEL_CHANGED' });
  assert.equal(readFileSync(join(s.root, 'a.txt'), 'utf8'), 'newer\n');
});
test('access lost after downloading refuses publication even with complete cached bytes', async t => {
  const s = setup(t),
    download = s.transport.downloadToFile;
  s.transport.downloadToFile = async (...args) => {
    await download(...args);
    s.access(false);
  };
  await assert.rejects(checkoutHostedMain(s.root, s.request(), s.transport), /revoked/);
  assert.equal(existsSync(s.root), false);
});

test('server-selected hosted A is materialized while uploaded native main remains B', async t => {
  const client = setup(t),
    { s } = hostedFixture();
  for (const bytes of client.objects.values()) await upload(s, bytes);
  const row = s.tables.projectWorkRecords.get('hosted');
  row.value = JSON.stringify({ id: 'hosted-a', head: client.head, previousId: null });
  s.tables.projectBackups.get('backup').preview.head = 'b'.repeat(64);
  const transport = {
    current: async () => JSON.parse(await main.current._handler(s.ctx, { projectId: 'project' })),
    objects: digests => main.objects._handler(s.ctx, { projectId: 'project', digests }),
    downloadToFile: async (pin, path) => {
      const part = await modules.projectExchangeActions.downloadPart._handler(s.ctx, {
        projectId: 'project',
        digest: pin.sha256,
        offset: 0,
      });
      writeFileSync(path, Buffer.from(part.data), { mode: 0o600 });
    },
  };
  const result = await checkoutHostedMain(client.root, client.request(), transport);
  assert.equal(result.head, client.head);
  assert.equal(result.receipt.id, 'hosted-a');
  assert.equal(readFileSync(join(client.root, 'a.txt'), 'utf8'), 'first\n');
  assert.equal(JSON.parse(s.tables.projectWorkRecords.get('native').value).head, 'b'.repeat(64));
});
