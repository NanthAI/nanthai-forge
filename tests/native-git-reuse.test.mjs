// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportNativeGit, importNativeGit } from '../dist/native-git.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { workGit } from '../dist/work-git.js';
import { digest } from '../dist/hash.js';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-native-reuse-')),
    root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'base.txt'), 'unchanged source\n');
  const { head } = initNative(root);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { dir, root, source: new NativeSource(root), head };
}
function next(f, parents = [f.head], message = 'Synthetic edit') {
  const files = [
    ...f.source.state(parents[0]).files.filter(file => file.path !== 'nested/a.txt'),
    { path: 'nested/a.txt', mode: 'file', blob: f.source.put(Buffer.from(message)) },
  ];
  f.head = f.source.writeState(files, parents, message, '2026-01-01T00:00:00.000Z');
  return f.head;
}
function trackedGit(dir) {
  const bin = join(dir, 'bin'),
    log = join(dir, 'git-commands');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}\nconst { appendFileSync } = require('node:fs');\nconst { spawnSync } = require('node:child_process');\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nconst r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\nprocess.exit(r.status ?? 1);\n`,
    { mode: 0o700 },
  );
  return { PATH: bin + ':' + process.env.PATH, log };
}
async function cli(f, target, reuse, env = {}) {
  const child = spawn(
    process.execPath,
    ['dist/cli.js', 'export-native-git', f.root, f.head, target, ...(reuse ? ['--reuse', reuse] : [])],
    { env: { ...process.env, ...env } },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', bytes => (stdout += bytes));
  child.stderr.on('data', bytes => (stderr += bytes));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0, stderr);
  return { result: JSON.parse(stdout), stderr };
}
function onlyProgress(stderr) {
  // Successful exports can exceed the documented ten-second heartbeat interval.
  // Reject fallback/errors while retaining exact byte and command-count checks below.
  for (const line of stderr.split('\n').filter(Boolean))
    assert.match(
      line,
      /^export-native-git: (?:waiting for Git [^;\r\n]+|reading immutable States|projecting immutable States); holder=git pid=(?:\d+|none); commandWait=\d+s; commands=\d+; elapsed=\d+s$/,
    );
}
function same(full, incremental) {
  assert.equal(incremental.commit, full.commit);
  assert.deepEqual(incremental.states, full.states);
  assert.equal(incremental.bundleSha256, full.bundleSha256);
  assert.deepEqual(readFileSync(incremental.bundle.path), readFileSync(full.bundle.path));
  assert.deepEqual(
    readFileSync(join(incremental.path, 'mapping.json')),
    readFileSync(join(full.path, 'mapping.json')),
  );
}

test('incremental CLI exports only new States with byte-identical merge history and bundles', async t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) next(f, [f.head], `old-${i}`);
  const old = f.head,
    previous = await exportNativeGit(f.root, old, join(f.dir, 'previous'));
  const before = readFileSync(join(previous.path, 'mapping.json'));
  const unrelatedObject = workGit(
    join(previous.path, 'repository.git'),
    ['hash-object', '-w', '--stdin'],
    Buffer.from('unrelated synthetic cached bytes'),
  ).trim();
  const left = next(f, [old], 'left'),
    right = next(f, [old], 'right');
  next(f, [left, right], 'merge');
  const full = await exportNativeGit(f.root, f.head, join(f.dir, 'full')),
    tracking = trackedGit(f.dir),
    incremental = await cli(f, join(f.dir, 'incremental'), previous.path, { PATH: tracking.PATH });
  onlyProgress(incremental.stderr);
  same(full, incremental.result);
  assert.throws(() =>
    workGit(join(incremental.result.path, 'repository.git'), ['cat-file', '-e', unrelatedObject]),
  );
  const commands = readFileSync(tracking.log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(commands.filter(args => args.includes('hash-object') && args.includes('commit')).length, 1);
  assert.equal(commands.filter(args => args.includes('mktree')).length, 1);
  assert.equal(commands.filter(args => args.includes('hash-object') && !args.includes('commit')).length, 1);
  assert.deepEqual(readFileSync(join(previous.path, 'mapping.json')), before);
  rmSync(previous.path, { recursive: true });
  assert.equal(workGit(join(incremental.result.path, 'repository.git'), ['fsck', '--full']).trim(), '');
  const unchanged = await cli(f, join(f.dir, 'unchanged'), incremental.result.path, { PATH: tracking.PATH });
  same(full, unchanged.result);
  const later = readFileSync(tracking.log, 'utf8')
    .trim()
    .split('\n')
    .slice(commands.length)
    .map(line => JSON.parse(line));
  assert.equal(later.filter(args => args.includes('hash-object') || args.includes('mktree')).length, 0);
});

for (const format of ['sha1', 'sha256'])
  test(`incremental ${format} imported history retains original refs and file modes`, async t => {
    const f = fixture(t),
      original = join(f.dir, 'git');
    workGit(f.dir, ['init', '--template=', `--object-format=${format}`, '--initial-branch=main', original]);
    writeFileSync(join(original, 'a.txt'), 'a\n');
    writeFileSync(join(original, 'a.b'), 'file before directory\n');
    mkdirSync(join(original, 'a'));
    writeFileSync(join(original, 'a', 'é\t.txt'), 'unicode and tab\n');
    workGit(original, ['add', '.']);
    workGit(original, ['commit', '-m', 'Original']);
    workGit(original, ['tag', 'retained-tag']);
    const imported = await importNativeGit(
      original,
      workGit(original, ['rev-parse', 'HEAD']).trim(),
      join(f.dir, 'imported'),
    );
    f.root = imported.root;
    f.source = new NativeSource(f.root);
    f.head = imported.head;
    next(f);
    const files = f.source.state(f.head).files;
    f.head = f.source.writeState(
      [
        ...files.map(file => (file.path === 'a.txt' ? { ...file, mode: 'executable' } : file)),
        { path: 'link', mode: 'symlink', blob: f.source.put(Buffer.from('a.txt')) },
      ],
      [f.head],
      'Modes',
      '2026-01-02T00:00:00Z',
    );
    const previous = await exportNativeGit(f.root, f.head, join(f.dir, 'previous'));
    next(f, [f.head], 'new');
    const full = await exportNativeGit(f.root, f.head, join(f.dir, 'full')),
      incremental = await cli(f, join(f.dir, 'incremental'), previous.path);
    onlyProgress(incremental.stderr);
    same(full, incremental.result);
    writeFileSync(join(previous.path, 'mapping.json'), '{}');
    const fallback = await cli(f, join(f.dir, 'fallback'), previous.path);
    assert.match(fallback.stderr, /falling back to full export/);
    same(full, fallback.result);
    assert.equal(
      workGit(join(incremental.result.path, 'repository.git'), [
        'rev-parse',
        'refs/tags/retained-tag',
      ]).trim(),
      imported.commit,
    );
  });

for (const corruption of [
  'schema',
  'invalid-json',
  'bad-state-entry',
  'loose-object',
  'missing-loose-object',
  'format',
  'duplicate',
  'missing-state',
  'wrong-commit',
  'digest',
  'pack',
  'missing-commit',
  'missing-file',
  'unrelated',
])
  test(`unusable reuse (${corruption}) falls back to an identical full export`, async t => {
    const f = fixture(t);
    next(f, [f.head], 'base');
    const previous = await exportNativeGit(f.root, f.head, join(f.dir, 'previous')),
      mappingPath = join(previous.path, 'mapping.json'),
      mapping = JSON.parse(readFileSync(mappingPath, 'utf8'));
    if (corruption === 'schema') mapping.schema = 2;
    if (corruption === 'bad-state-entry') mapping.states[0] = { state: null };
    if (['loose-object', 'missing-loose-object'].includes(corruption)) {
      const path = join(
        previous.path,
        'repository.git',
        'objects',
        mapping.commit.slice(0, 2),
        mapping.commit.slice(2),
      );
      if (corruption === 'loose-object') {
        chmodSync(path, 0o600);
        writeFileSync(path, 'corrupt loose commit');
      } else rmSync(path);
    }
    if (corruption === 'format') mapping.format = 'sha256';
    if (corruption === 'duplicate') mapping.states.push(mapping.states[0]);
    if (corruption === 'missing-state') mapping.states.shift();
    if (corruption === 'wrong-commit') mapping.states[0].commit = mapping.commit;
    if (corruption === 'digest') mapping.bundleSha256 = '0'.repeat(64);
    if (corruption === 'pack') {
      const bundle = readFileSync(previous.bundle.path);
      bundle[bundle.length - 1] ^= 1;
      writeFileSync(previous.bundle.path, bundle);
      mapping.bundleSha256 = digest(bundle);
    }
    if (corruption === 'missing-commit') {
      // A valid self-contained bundle from an earlier State cannot supply the mapped tip.
      const earlier = await exportNativeGit(f.root, mapping.states[0].state, join(f.dir, 'earlier'));
      const bundle = readFileSync(earlier.bundle.path);
      writeFileSync(previous.bundle.path, bundle);
      mapping.bundleSha256 = digest(bundle);
    }
    writeFileSync(mappingPath, corruption === 'invalid-json' ? '{invalid-json' : JSON.stringify(mapping));
    if (corruption === 'missing-file') rmSync(previous.bundle.path);
    if (corruption === 'unrelated') {
      const root = join(f.dir, 'other');
      mkdirSync(root);
      writeFileSync(join(root, 'unrelated.txt'), 'unrelated synthetic project');
      f.head = initNative(root).head;
      f.root = root;
      f.source = new NativeSource(root);
    }
    next(f, [f.head], 'latest');
    const full = await exportNativeGit(f.root, f.head, join(f.dir, 'full')),
      incremental = await cli(f, join(f.dir, 'incremental'), previous.path);
    assert.match(incremental.stderr, /reuse source is unusable; falling back to full export/);
    same(full, incremental.result);
    assert.equal(
      existsSync(join(incremental.result.path, 'repository.git', 'objects', 'info', 'alternates')),
      false,
    );
  });
