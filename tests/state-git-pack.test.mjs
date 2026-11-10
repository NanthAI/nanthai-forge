// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digest } from '../dist/hash.js';
import { readGitPack, writeGitPack } from '../dist/state/git-pack.js';
import { gitObjectId } from '../dist/state/git.js';

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-state-git-pack-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}
const blobs = new Map();
const put = text => {
  const id = digest(text);
  blobs.set(id, Buffer.from(text));
  return id;
};
const readBlob = id => blobs.get(id);
function manifest(files, message = 'save', parents = []) {
  const list = Object.entries(files)
    .map(([path, value]) => {
      const { text, mode } = typeof value === 'string' ? { text: value, mode: 'file' } : value;
      return { path, blob: put(text), mode };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents,
      files: list,
      message,
      at: '2026-10-30T12:00:00.000Z',
    }),
  );
}
const object = (type, text) => ({ type, bytes: Buffer.from(text) });

test('a pack v2 is read by real Git and round-trips every object', t => {
  const root = scratch(t);
  const big = 'x'.repeat(70_000) + 'y'.repeat(3000);
  const hello = gitObjectId('blob', Buffer.from('hello\n'));
  const tree = {
    type: 'tree',
    bytes: Buffer.concat([Buffer.from('100644 hello\0'), Buffer.from(hello, 'hex')]),
  };
  const objects = [object('blob', ''), object('blob', 'hello\n'), object('blob', big), tree];
  const pack = writeGitPack(objects);
  assert.deepEqual(writeGitPack(objects), pack, 'deterministic bytes');
  const read = readGitPack(pack);
  assert.deepEqual(
    [...read.keys()],
    objects.map(o => gitObjectId(o.type, o.bytes)),
  );
  assert.equal(read.get(gitObjectId('blob', big)).bytes.toString(), big);
  const repo = join(root, 'repo.git');
  execFileSync('git', ['init', '--bare', '-q', repo]);
  execFileSync('git', ['-C', repo, 'index-pack', '--stdin', '--strict'], { input: pack });
  for (const o of objects.slice(0, 3))
    assert.deepEqual(
      execFileSync('git', ['-C', repo, 'cat-file', 'blob', gitObjectId(o.type, o.bytes)]),
      o.bytes,
    );
  assert.match(
    execFileSync('git', ['-C', repo, 'ls-tree', gitObjectId('tree', tree.bytes)]).toString(),
    /hello$/m,
  );
  assert.equal(readGitPack(writeGitPack([])).size, 0);
});

test('bad packs fail closed: trailer, deltas, sizes, truncation and trailing bytes', () => {
  const pack = writeGitPack([object('blob', 'hello')]);
  const resign = body => Buffer.concat([body, createHash('sha1').update(body).digest()]);
  const body = pack.subarray(0, -20);
  const cases = {
    trailer: Buffer.concat([body, Buffer.alloc(20)]),
    version: resign(Buffer.concat([Buffer.from('PACK\0\0\0\x03'), body.subarray(8)])),
    // Type 7 (REF_DELTA) in place of the blob header.
    delta: resign(Buffer.concat([body.subarray(0, 12), Buffer.from([0x75]), body.subarray(13)])),
    size: resign(Buffer.concat([body.subarray(0, 12), Buffer.from([0x34]), body.subarray(13)])),
    count: resign(Buffer.concat([body.subarray(0, 8), Buffer.from([0, 0, 0, 2]), body.subarray(12)])),
    trailing: resign(Buffer.concat([body, Buffer.from('junk')])),
    truncated: resign(body.subarray(0, body.length - 3)),
    short: Buffer.from('PACK'),
  };
  for (const [name, bytes] of Object.entries(cases))
    assert.throws(() => readGitPack(bytes), { code: 'GIT_OBJECT_INVALID' }, name);
});
