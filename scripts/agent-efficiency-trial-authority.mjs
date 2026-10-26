// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = rows =>
  rows
    .map(r => ({ path: r.path, blob: r.blob, mode: r.mode }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
export function sameAuthority(git, native) {
  return JSON.stringify(canonical(git)) === JSON.stringify(canonical(native));
}
function gitFiles(root, head) {
  const r = spawnSync('git', ['ls-tree', '-rz', '--full-tree', head], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(r.status, 0);
  const records = r.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(line => {
      const i = line.indexOf('\t'),
        [mode, type, oid] = line.slice(0, i).split(' ');
      assert.equal(type, 'blob');
      assert(['100644', '100755', '120000'].includes(mode));
      return {
        path: line.slice(i + 1),
        mode: mode === '100755' ? 'executable' : mode === '120000' ? 'symlink' : 'file',
        oid,
      };
    });
  const bytes = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: records.map(r => r.oid).join('\n') + '\n',
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(bytes.status, 0);
  let offset = 0;
  return records.map(record => {
    const end = bytes.stdout.indexOf(10, offset),
      header = bytes.stdout.subarray(offset, end).toString('ascii').split(' ');
    assert.equal(header[0], record.oid);
    assert.equal(header[1], 'blob');
    const size = Number(header[2]),
      body = bytes.stdout.subarray(end + 1, end + 1 + size);
    assert.equal(body.length, size);
    offset = end + 2 + size;
    return { path: record.path, mode: record.mode, blob: sha(body) };
  });
}
const [configPath, flag] = process.argv.slice(2);
if (flag === '--selftest') {
  const files = [
    { path: 'src/a.ts', mode: 'file', blob: 'a'.repeat(64) },
    { path: 'scripts/run', mode: 'executable', blob: 'b'.repeat(64) },
  ];
  assert(sameAuthority(files, [...files].reverse()));
  assert(
    sameAuthority(
      files,
      files.map(r => ({ blob: r.blob, mode: r.mode, path: r.path })),
    ),
  );
  assert(!sameAuthority(files, files.slice(1)));
  assert(!sameAuthority(files, [...files, { path: 'src/extra.ts', mode: 'file', blob: 'c'.repeat(64) }]));
  assert(
    !sameAuthority(
      files,
      files.map((f, i) => (i ? f : { ...f, mode: 'executable' })),
    ),
  );
  assert(
    !sameAuthority(
      files,
      files.map((f, i) => (i ? f : { ...f, blob: 'd'.repeat(64) })),
    ),
  );
  console.log(JSON.stringify({ passed: true, positive: 1, negativeCases: 4 }));
} else {
  const config = JSON.parse(readFileSync(configPath)),
    base = config.output,
    plan = JSON.parse(readFileSync(join(base, 'plan.json'))),
    { NativeSource } = await import(
      pathToFileURL(config.cli.replace(/\/cli\.js$/, '/native-source.js')).href
    ),
    results = [];
  for (const task of plan.pairs) {
    const git = JSON.parse(readFileSync(join(base, task.id, 'git/prepared.json'))),
      native = JSON.parse(readFileSync(join(base, task.id, 'forge/prepared.json'))),
      head =
        git.setup.initialGitCommit ??
        spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
          cwd: git.root,
          encoding: 'utf8',
        }).stdout.trim();
    const expected = gitFiles(git.root, head),
      source = new NativeSource(native.root),
      files = source.state(native.setup.nativeInitial).files;
    for (const file of files) assert.equal(sha(source.object(file.blob)), file.blob);
    const passed = sameAuthority(expected, files),
      missing = expected.filter(f => !files.some(n => n.path === f.path)).map(f => f.path),
      extra = files.filter(f => !expected.some(g => g.path === f.path)).map(f => f.path);
    results.push({
      taskId: task.id,
      passed,
      gitCommit: head,
      nativeState: native.setup.nativeInitial,
      gitFiles: expected.length,
      nativeFiles: files.length,
      exactBytesAndFileExecutableModes: passed,
      gitManifestSha256: sha(JSON.stringify(canonical(expected))),
      nativeManifestSha256: sha(JSON.stringify(canonical(files))),
      missing,
      extra,
    });
  }
  const receipt = { passed: results.every(r => r.passed), results, at: new Date().toISOString() };
  writeFileSync(join(base, 'authority-validation.json'), JSON.stringify(receipt, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify(receipt));
  if (!receipt.passed) process.exitCode = 1;
}
