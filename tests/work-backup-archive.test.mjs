// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { packWorkArchive, withWorkArchive, validateArchiveEntrySizes } from '../dist/work-backup-archive.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { exportNativeWork } from '../dist/native-backup.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = error => error.code === 'INVALID_WORK_BACKUP';
function fixture(t) {
  const previousSecret = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fake-test-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousSecret;
  });
  const root = mkdtempSync(join(tmpdir(), 'forge-archive-extraction-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function listingProbe(root) {
  const actual = execFileSync('which', ['tar'], { encoding: 'utf8' }).trim(),
    bin = join(root, 'bin'),
    log = join(root, 'tar-operations.jsonl');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'tar'),
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nimport {spawnSync} from 'node:child_process';\nif(process.env.OPENAI_API_KEY)process.exit(93);\nappendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\nconst result=spawnSync(${JSON.stringify(actual)},process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);\n`,
    { mode: 0o700 },
  );
  return {
    bin,
    operations: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []),
  };
}
function checksum(bytes) {
  bytes.fill(32, 148, 156);
  const total = bytes.subarray(0, 512).reduce((a, b) => a + b, 0);
  bytes.write(total.toString(8).padStart(6, '0') + '\0 ', 148);
}
async function archive(root, count = 1, claimedDelta = 0) {
  const directory = join(root, 'source');
  mkdirSync(directory);
  mkdirSync(join(directory, 'objects'));
  const files = [],
    originals = new Map();
  const work = Buffer.from('{"synthetic":true}\n');
  writeFileSync(join(directory, 'work.json'), work);
  files.push({ path: 'work.json', size: work.length + claimedDelta, sha256: sha(work) });
  originals.set('work.json', work);
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.concat([Buffer.from(`synthetic ${i}:`), Buffer.alloc(8192, i % 255)]),
      digest = sha(bytes),
      path = `objects/${digest}`;
    writeFileSync(join(directory, path), bytes);
    files.push({ path, size: bytes.length, sha256: digest });
    originals.set(path, bytes);
  }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ files }) + '\n');
  return {
    ...(await packWorkArchive(
      directory,
      files.map(file => file.path),
    )),
    originals,
  };
}

test('owner archive export exceeds ARG_MAX without putting its file list on argv', async t => {
  const root = fixture(t),
    owner = join(root, 'owner');
  mkdirSync(owner);
  initNative(owner);
  const source = new NativeSource(owner),
    store = new WorkStore(owner),
    data = store.load(),
    argMax = Number(execFileSync('getconf', ['ARG_MAX'], { encoding: 'utf8' }).trim()),
    count = Math.ceil(argMax / Buffer.byteLength(`objects/${'0'.repeat(64)}\0`)) + 128,
    files = Array.from({ length: count }, (_, index) => {
      const bytes = Buffer.from(String(index)),
        blob = sha(bytes);
      // Seed tiny immutable fixtures directly; this test exercises export, not
      // the per-object durability flush already covered by source-store tests.
      writeFileSync(join(source.directory, blob), bytes, { flag: 'wx', mode: 0o600 });
      return { path: `file-${index}.txt`, blob, mode: 'file' };
    });
  data.nativeHead = source.writeState(files, [], 'Synthetic large archive', new Date().toISOString());
  store.save(data);
  const names = files.map(file => `objects/${file.blob}`);
  assert(Buffer.byteLength(names.join('\0')) > argMax);
  const oldInvocation = spawnSync('tar', ['-cf', '/dev/null', '--', ...names], { cwd: owner });
  assert.equal(oldInvocation.error?.code, 'E2BIG', 'Fixture must reproduce the old argv failure');
  const backup = (await exportNativeWork(store, data.revision, true)).result;
  assert.equal(backup.files, count + 2); // Work plus the State and its blobs.
  assert(backup.archive.size > 0);
  await withWorkArchive(backup.archive.path, async directory => {
    assert.equal(readdirSync(join(directory, 'objects')).length, count + 1);
    assert.deepEqual(readFileSync(join(directory, names.at(-1))), Buffer.from(String(count - 1)));
  });
});

test('archives written by the old argv-based packer still restore', async t => {
  const root = fixture(t),
    backup = await archive(root),
    directory = join(root, 'source'),
    oldArchive = join(root, 'old.tar.gz');
  execFileSync(
    'tar',
    [
      '--format=ustar',
      '-czf',
      oldArchive,
      '--',
      ...readdirSync(directory).filter(name => name !== 'objects'),
      ...[...backup.originals.keys()].filter(name => name.startsWith('objects/')),
    ],
    { cwd: directory },
  );
  await withWorkArchive(oldArchive, async extracted => {
    for (const [path, bytes] of backup.originals)
      assert.deepEqual(readFileSync(join(extracted, path)), bytes);
  });
});

test('owner-sized manifest metadata is not truncated by the native command output buffer', async t => {
  const root = fixture(t),
    backup = await archive(root),
    directory = join(root, 'source');
  const manifest = Buffer.from(
    JSON.stringify({
      ...JSON.parse(readFileSync(join(directory, 'manifest.json'))),
      coverage: 'synthetic retained coverage '.repeat(200_000),
    }),
  );
  assert(manifest.length > 4 * 1024 * 1024);
  writeFileSync(join(directory, 'manifest.json'), manifest);
  const packed = await packWorkArchive(directory, [...backup.originals.keys()]);
  await withWorkArchive(packed.path, async extracted => {
    assert.deepEqual(readFileSync(join(extracted, 'manifest.json')), manifest);
    for (const [path, bytes] of backup.originals)
      assert.deepEqual(readFileSync(join(extracted, path)), bytes);
  });
});

test('one native extraction restores every original byte with private modes, without per-file decompression', async t => {
  const root = fixture(t),
    backup = await archive(root, 96),
    probe = listingProbe(root),
    previous = process.env.PATH,
    options = process.env.TAR_OPTIONS;
  process.env.PATH = `${probe.bin}:${previous}`;
  process.env.TAR_OPTIONS = '--transform=s,^,../escape/,';
  let capturedDirectory;
  try {
    await withWorkArchive(backup.path, async (directory, observed) => {
      capturedDirectory = directory;
      assert.deepEqual(observed, { sha256: backup.sha256, size: backup.size });
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      for (const [path, bytes] of backup.originals) {
        assert.deepEqual(readFileSync(join(directory, path)), bytes);
        assert.equal(statSync(join(directory, path)).mode & 0o777, 0o600);
      }
      assert.equal(statSync(join(directory, 'objects')).mode & 0o777, 0o700);
      assert.equal(readdirSync(join(directory, 'objects')).length, 96);
    });
  } finally {
    process.env.PATH = previous;
    if (options === undefined) delete process.env.TAR_OPTIONS;
    else process.env.TAR_OPTIONS = options;
  }
  assert.equal(existsSync(capturedDirectory), false);
  const operations = probe.operations();
  assert.equal(operations.filter(args => args.includes('-xzf')).length, 1);
  assert.deepEqual(
    operations.filter(args => args.includes('-xzOf')).map(args => args.at(-1)),
    ['manifest.json'],
  );
});

test('GNU and BSD C-locale tar sizes retain ordinary archive layouts and reject mismatches before extraction', () => {
  const files = [
    { path: 'manifest.json', size: 100 },
    { path: 'work.json', size: 17 },
  ];
  for (const lines of [
    '-rw------- user/group 100 2026-10-03 21:20 manifest.json\n-rw------- 123/456 17 1970-01-01 00:00 work.json\n',
    '-rw-------  0 user group 100 Oct  3 21:20 manifest.json\n-rw-r--r--  0 123 456 17 Jan  1  1970 work.json\n',
    '-rw------- user/group 100 2026-10-03 21:20:01 manifest.json\n-rw------- 0 user group 17 Oct 3 21:20:01 work.json\n',
  ])
    assert.doesNotThrow(() => validateArchiveEntrySizes(lines, files));
  assert.throws(
    () =>
      validateArchiveEntrySizes(
        '-rw------- user/group 101 2026-10-03 21:20 manifest.json\n-rw------- user/group 17 2026-10-03 21:20 work.json',
        files,
      ),
    invalid,
  );
  assert.throws(
    () =>
      validateArchiveEntrySizes(
        '-rw------- user/group 100 2026-10-03 21:20 manifest.json\n-rw------- user/group 100 2026-10-03 21:20 manifest.json',
        files,
      ),
    invalid,
  );
});

test('oversized and undersized entries are rejected before any extraction or consumer mutation', async t => {
  for (const delta of [-1, 1]) {
    const root = fixture(t),
      backup = await archive(root, 1, delta),
      probe = listingProbe(root),
      previous = process.env.PATH;
    process.env.PATH = `${probe.bin}:${previous}`;
    try {
      await assert.rejects(
        withWorkArchive(backup.path, async () => assert.fail('Invalid archive was exposed')),
        invalid,
      );
    } finally {
      process.env.PATH = previous;
    }
    assert.equal(probe.operations().filter(args => args.includes('-xzf')).length, 0);
  }
});

test('traversal, links, duplicate entries, truncated bytes and changed digests never reach consumers', async t => {
  const root = fixture(t),
    backup = await archive(root),
    original = gunzipSync(readFileSync(backup.path));
  const size = parseInt(original.toString('utf8', 124, 136).replace(/\0.*$/, '').trim(), 8),
    next = 512 + Math.ceil(size / 512) * 512;
  const traversal = Buffer.from(original);
  traversal.fill(0, 0, 100);
  traversal.write('../escape');
  checksum(traversal);
  const symbolic = Buffer.from(original);
  symbolic[156] = 50;
  symbolic.write('/tmp/never-followed', 157);
  checksum(symbolic);
  const hard = Buffer.from(original);
  hard[156] = 49;
  hard.write('work.json', 157);
  checksum(hard);
  const duplicate = Buffer.concat([original.subarray(0, next), original]);
  const changed = Buffer.from(original);
  changed[next + 512] ^= 1;
  const truncated = original.subarray(0, next + 513);
  for (const [name, bytes] of Object.entries({ traversal, symbolic, hard, duplicate, changed, truncated })) {
    const path = join(root, `${name}.tar.gz`);
    writeFileSync(path, gzipSync(bytes));
    await assert.rejects(
      withWorkArchive(path, async () => assert.fail(`${name} reached the consumer`)),
      invalid,
    );
  }
  const truncatedGzip = join(root, 'truncated-gzip.tar.gz');
  writeFileSync(truncatedGzip, readFileSync(backup.path).subarray(0, 40));
  await assert.rejects(
    withWorkArchive(truncatedGzip, async () => assert.fail('Incomplete gzip reached consumer')),
    invalid,
  );
});

test('exclusive destination preparation preserves the existing filesystem case-alias behavior', async t => {
  const root = fixture(t),
    directory = join(root, 'case-source');
  mkdirSync(directory);
  const bytes = Buffer.from('same original bytes');
  writeFileSync(join(directory, 'work.json'), bytes);
  const insensitive = existsSync(join(directory, 'WORK.JSON'));
  if (!insensitive) writeFileSync(join(directory, 'WORK.JSON'), bytes);
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      files: ['work.json', 'WORK.JSON'].map(path => ({ path, size: bytes.length, sha256: sha(bytes) })),
    }),
  );
  const backup = await packWorkArchive(directory, ['work.json', 'WORK.JSON']);
  if (insensitive)
    await assert.rejects(
      withWorkArchive(backup.path, async () => assert.fail('Case-alias destinations were overwritten')),
      error => error.code === 'EEXIST',
    );
  else
    await withWorkArchive(backup.path, async extracted => {
      assert.deepEqual(readWorkBytes(join(extracted, 'work.json')), bytes);
      assert.deepEqual(readFileSync(join(extracted, 'WORK.JSON')), bytes);
    });
});
