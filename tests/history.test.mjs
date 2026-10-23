// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, write, code } from './helpers.mjs';

function graph(t) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Baseline']);
  const base = git(root, ['rev-parse', 'HEAD']).trim(),
    tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim(),
    originals = new Map();
  function object(parents, message, signature = '') {
    const bytes = Buffer.concat([
      Buffer.from(
        `tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author Original Author <original@localhost> 1700000000 +0530\ncommitter Original Committer <committer@localhost> 1700000200 -0700\n${signature}\n`,
      ),
      Buffer.from(message),
    ]);
    // Large synchronous pipe writes can stall on macOS; give Git a file descriptor.
    const inputPath = join(root, '.git', 'synthetic-commit');
    writeFileSync(inputPath, bytes);
    const input = openSync(inputPath, 'r');
    let id;
    try {
      id = execFileSync('git', ['-C', root, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
        stdio: [input, 'pipe', 'pipe'],
        encoding: 'utf8',
      }).trim();
    } finally {
      closeSync(input);
      unlinkSync(inputPath);
    }
    originals.set(id, bytes);
    return id;
  }
  const left = object([base], Buffer.from([0x63, 0x61, 0x66, 0xe9, 10]));
  const right = object([base], 'Right path\n');
  const head = object(
    [left, right],
    '<script>globalThis.untrustedCommitExecuted = true</script>\n\nOriginal multiline message 👋\n',
    'gpgsig -----BEGIN PGP SIGNATURE-----\n synthetic signature bytes\n -----END PGP SIGNATURE-----\n',
  );
  git(root, ['update-ref', 'HEAD', head]);
  return { root, head, left, right, base, tree, originals, object };
}
function candidate(root) {
  const work = new WorkService(root),
    local = c => work.execute(c, work.status().revision).result;
  const intent = local({ action: 'intent', outcome: 'Inspect original Git history' });
  const lane = local({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const view = local({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const command = patch => ({ action: 'read-history', viewId: view.id, expectedHead: view.head, ...patch });
  const read = async patch => (await work.dispatch(command(patch), 0)).result;
  return { work, local, intent, lane, view, command, read };
}

test('exact raw merge DAG pagination preserves signature/encoding bytes, historical Views and dirty work despite replacement refs', async t => {
  const { root, head, left, right, base, originals } = graph(t),
    { work, local, intent, lane, view, read } = candidate(root);
  write(work.store.path(lane.id), 'a.ts', 'unfinished source');
  const before = readWorkBytes(join(work.store.directory, 'work.json'));
  git(root, ['replace', head, right]);
  const first = await read({ limit: 2 });
  assert.deepEqual(
    first.entries.map(c => c.id),
    [head, left],
  );
  assert.deepEqual(first.entries[0].parents, [left, right]);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.truncated, true);
  assert.match(first.entries[0].author, /Original Author.*1700000000 \+0530/);
  assert.match(first.entries[0].committer, /1700000200 -0700/);
  assert.deepEqual(first.entries[0].signatureFields, ['gpgsig']);
  assert.match(first.entries[1].displayEncoding, /replacement/);
  assert.match(first.entries[0].message, /<script>.*\n\nOriginal multiline message 👋/);
  assert.equal(first.entries[0].raw, undefined);
  const second = await read({ offset: first.nextOffset, limit: 2 });
  assert.deepEqual(
    second.entries.map(c => c.id),
    [base, right],
  );
  assert.equal(second.nextOffset, null);
  assert.equal(second.gapsObserved, 0);
  const exported = await read({ action: 'export-history', limit: 100 });
  assert.equal(exported.private, true);
  for (const entry of exported.entries.filter(c => originals.has(c.id)))
    assert.deepEqual(Buffer.from(entry.raw.data, 'base64'), originals.get(entry.id));
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
  git(root, ['replace', '-d', head]);
  git(work.store.path(lane.id), ['add', 'a.ts']);
  const staged = work.status().lanes[0];
  const checkpoint = local({
    action: 'checkpoint',
    laneId: lane.id,
    expectedHead: staged.actualHead,
    expectedTree: staged.indexTree,
    message: 'New candidate',
  });
  local({ action: 'compose', intentId: intent.id, inputs: [{ laneId: lane.id, head: checkpoint.head }] });
  write(work.store.path(lane.id), 'a.ts', 'still unfinished');
  assert.equal((await read()).head, view.head);
  assert.equal((await read()).entries[0].id, head);
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), head);
  assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'still unfinished');
  for (const patch of [{ offset: -1 }, { limit: 101 }, { expectedHead: '--help' }])
    await assert.rejects(read(patch), code('BAD_ARGUMENT'));
  await assert.rejects(read({ viewId: randomUUID() }), code('VIEW_STALE'));
  await assert.rejects(read({ expectedHead: '0'.repeat(40) }), code('VIEW_STALE'));
});

test('actual shallow/promisor missing parents stay unknown and never invoke a remote helper', async t => {
  const { root, head, left, right } = graph(t);
  const shallow = fixture(t);
  git(shallow, ['clone', '-q', '--depth=1', `file://${root}`, 'copy']);
  const copy = join(shallow, 'copy'),
    { work, read } = candidate(copy);
  const shallowBefore = readFileSync(join(copy, '.git/shallow'));
  const marker = join(shallow, 'remote-called'),
    helper = join(shallow, 'git-remote-forge-history-test');
  writeFileSync(helper, `#!/bin/sh\n: > '${marker.replaceAll("'", "'\\''")}'\nexit 1\n`);
  chmodSync(helper, 0o700);
  git(copy, ['config', 'extensions.partialClone', 'origin']);
  git(copy, ['config', 'remote.origin.promisor', 'true']);
  git(copy, ['config', 'remote.origin.url', 'forge-history-test::untrusted']);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shallow}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  assert.throws(() => git(copy, ['cat-file', '-e', left]));
  assert.equal(existsSync(marker), true);
  unlinkSync(marker);
  const before = readWorkBytes(join(work.store.directory, 'work.json'));
  const page = await read({ action: 'export-history' });
  assert.equal(page.head, head);
  assert.deepEqual(
    page.entries.map(c => c.id),
    [head, left, right],
  );
  assert.deepEqual(
    page.entries.map(c => c.status),
    ['available', 'unavailable', 'unavailable'],
  );
  assert.equal(page.gapsObserved, 2);
  assert.equal(page.nextOffset, null);
  assert.match(page.entries[1].reason, /No fetch/);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readFileSync(join(copy, '.git/shallow')), shallowBefore);
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
});

test('actual CLI and HTTP privately export pinned history without changing work or serving unauthorized reads', async t => {
  const { root, head, originals } = graph(t),
    { work, command } = candidate(root);
  const before = readWorkBytes(join(work.store.directory, 'work.json'));
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'work',
        root,
        JSON.stringify(command({ action: 'export-history', limit: 1 })),
        '0',
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(cli.result.head, head);
  assert.deepEqual(Buffer.from(cli.result.entries[0].raw.data, 'base64'), originals.get(head));
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`,
    body = JSON.stringify({ revision: 0, command: command({ action: 'export-history', limit: 1 }) });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
    401,
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
    body,
  });
  assert.equal(response.status, 200);
  const exported = (await response.json()).result;
  assert.equal(exported.private, true);
  assert.equal(exported.entries[0].id, head);
  assert.equal(exported.nextOffset, 1);
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
});

test('existing byte budget paginates large commits without loss and SHA-256 object identities remain exact', async t => {
  const { root, head, object } = graph(t);
  const first = object([head], 'A'.repeat(2200 * 1024)),
    newest = object([first], 'B'.repeat(2200 * 1024));
  git(root, ['update-ref', 'HEAD', newest]);
  const { read } = candidate(root);
  const page = await read();
  assert.deepEqual(
    page.entries.map(c => c.id),
    [newest],
  );
  assert.equal(page.nextOffset, 1);
  const next = await read({ action: 'export-history', offset: page.nextOffset });
  assert.equal(next.entries[0].id, first);
  assert.equal(next.nextOffset, null);
  assert.match(Buffer.from(next.entries[0].raw.data, 'base64').toString('utf8'), /A{100}/);
  const sha = join(root, 'sha256');
  git(root, ['init', '-q', '--object-format=sha256', sha]);
  write(sha, 'a.ts', 'export const sha = 1;\n');
  git(sha, ['add', '.']);
  git(sha, ['commit', '-qm', 'SHA-256 source']);
  const shaHead = git(sha, ['rev-parse', 'HEAD']).trim(),
    shaHistory = await candidate(sha).read({ action: 'export-history' });
  assert.equal(shaHead.length, 64);
  assert.equal(shaHistory.entries[0].id, shaHead);
  assert.equal(shaHistory.entries[0].parents.length, 0);
});
