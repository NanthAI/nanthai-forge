// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, write } from './helpers.mjs';
import { workGit } from '../dist/work-git.js';
import { gitBundleParents } from '../dist/git-bundle-parents.js';
import { applyGitDelta } from '../dist/git-pack-delta.js';
const oid = (bytes, format = 'sha1') =>
  createHash(format).update(`commit ${bytes.length}\0`).update(bytes).digest('hex');
const header = (type, size) => {
  const bytes = [(type << 4) | (size & 15)];
  size = Math.floor(size / 16);
  while (size) {
    bytes[bytes.length - 1] |= 128;
    bytes.push(size & 127);
    size = Math.floor(size / 128);
  }
  return Buffer.from(bytes);
};
const variable = number => {
  const bytes = [];
  do {
    const part = number & 127;
    number = Math.floor(number / 128);
    bytes.push(part | (number ? 128 : 0));
  } while (number);
  return Buffer.from(bytes);
};
const insert = bytes => {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 127) {
    const part = bytes.subarray(i, i + 127);
    chunks.push(Buffer.from([part.length]), part);
  }
  return Buffer.concat(chunks);
};
function bundle(objects, head, format = 'sha1') {
  const packHeader = Buffer.alloc(12);
  packHeader.write('PACK');
  packHeader.writeUInt32BE(2, 4);
  packHeader.writeUInt32BE(objects.length, 8);
  const body = Buffer.concat([packHeader, ...objects]);
  return Buffer.concat([
    Buffer.from(
      `# v${format === 'sha1' ? 2 : 3} git bundle\n${format === 'sha256' ? '@object-format=sha256\n' : ''}${head} refs/heads/main\n\n`,
    ),
    body,
    createHash(format).update(body).digest(),
  ]);
}
for (const format of ['sha1', 'sha256'])
  test(`pure ${format} bundle parent graph agrees with actual Git across branching, merge and repack`, t => {
    const root = fixture(t);
    rmSync(join(root, '.git'), { recursive: true, force: true });
    workGit(root, ['init', '--object-format=' + format, '--template=']);
    write(root, 'a.ts', 'original\n');
    workGit(root, ['add', '.']);
    workGit(root, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Original',
    ]);
    const base = workGit(root, ['rev-parse', 'HEAD']).trim();
    const left = workGit(root, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      base,
      '-m',
      'Left',
    ]).trim();
    const right = workGit(root, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      base,
      '-m',
      'Right',
    ]).trim();
    const merge = workGit(root, [
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      left,
      '-p',
      right,
      '-m',
      'Merge',
    ]).trim();
    workGit(root, ['update-ref', 'refs/heads/merged', merge]);
    workGit(root, ['repack', '-adf', '--window=20', '--depth=20']);
    const path = join(root, 'source.bundle');
    workGit(root, ['bundle', 'create', path, '--all']);
    const graph = gitBundleParents(readFileSync(path), format);
    const actual = workGit(root, ['rev-list', '--parents', '--all'])
      .trim()
      .split('\n')
      .map(line => line.split(' '));
    assert.deepEqual([...graph].sort(), actual.map(([head, ...parents]) => [head, parents]).sort());
    assert.deepEqual(graph.get(merge), [left, right]);
  });
test('REF_DELTA forward bases and OFS_DELTA commit chains recover exact identities without exposing commit contents', () => {
  const prefix = Buffer.from(`tree ${'1'.repeat(40)}\n`),
    base = Buffer.concat([
      prefix,
      Buffer.from(
        'author Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nBase\n',
      ),
    ]);
  const first = Buffer.concat([
    prefix,
    Buffer.from(
      `parent ${oid(base)}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nChild\n`,
    ),
  ]);
  const delta = Buffer.concat([
    variable(base.length),
    variable(first.length),
    Buffer.from([0x90, prefix.length]),
    insert(first.subarray(prefix.length)),
  ]);
  assert.deepEqual(applyGitDelta(base, delta), first);
  const ref = Buffer.concat([header(7, delta.length), Buffer.from(oid(base), 'hex'), deflateSync(delta)]);
  const raw = Buffer.concat([header(1, base.length), deflateSync(base)]);
  const graph = gitBundleParents(bundle([ref, raw], oid(first)), 'sha1');
  assert.deepEqual(
    [...graph].sort(),
    [
      [oid(base), []],
      [oid(first), [oid(base)]],
    ].sort(),
  );
  const third = Buffer.from(`tree ${'1'.repeat(40)}\nparent ${oid(first)}\n\nThird\n`);
  const secondDelta = Buffer.concat([variable(first.length), variable(third.length), insert(third)]);
  // Raw followed by an offset delta: one-byte back distance names the raw object.
  const ofs = Buffer.concat([header(6, delta.length), Buffer.from([raw.length]), deflateSync(delta)]);
  assert.ok(raw.length < 128);
  const chain = Buffer.concat([
    header(7, secondDelta.length),
    Buffer.from(oid(first), 'hex'),
    deflateSync(secondDelta),
  ]);
  assert.deepEqual(gitBundleParents(bundle([raw, ofs, chain], oid(third)), 'sha1').get(oid(third)), [
    oid(first),
  ]);
});
test('malformed/truncated/checksum-changed bundles and invalid delta instructions fail; thin parents stay missing rather than proving independence', () => {
  const commit = Buffer.from(`tree ${'1'.repeat(40)}\nparent ${'2'.repeat(40)}\n\nIncomplete ancestry\n`);
  const valid = bundle([Buffer.concat([header(1, commit.length), deflateSync(commit)])], oid(commit));
  assert.deepEqual(gitBundleParents(valid, 'sha1').get(oid(commit)), ['2'.repeat(40)]);
  for (const invalid of [
    valid.subarray(0, valid.length - 1),
    Buffer.from('not a bundle'),
    Buffer.concat([valid.subarray(0, -1), Buffer.from([valid.at(-1) ^ 1])]),
  ])
    assert.throws(() => gitBundleParents(invalid, 'sha1'));
  assert.throws(() => gitBundleParents(valid, 'sha256'), /format differs/);
  assert.throws(() => applyGitDelta(Buffer.from('a'), Buffer.from([1, 1, 0])), /instruction/);
  assert.throws(() => applyGitDelta(Buffer.from('a'), Buffer.from([1, 2, 0x91, 2, 2])), /outside/);
});
