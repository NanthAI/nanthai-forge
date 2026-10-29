// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeSource, nativeMarker } from '../dist/native-source.js';
import { exportNativeGit } from '../dist/native-git.js';
import { nativeGitBatch } from '../dist/native-git-batch.js';
import { processAlive } from '../dist/local-process.js';
import { workGit } from '../dist/work-git.js';
import { referenceExport } from './helpers/native-git-reference.mjs';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-batch-')),
    root = join(dir, 'owner');
  mkdirSync(root);
  nativeMarker(root);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { dir, root, source: new NativeSource(root) };
}
function trackedGit(f, behavior = '') {
  const bin = join(f.dir, 'bin'),
    log = join(f.dir, 'calls');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}
const {spawn}=require('node:child_process'), {appendFileSync}=require('node:fs');
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,args})+'\\n');
${behavior}
const git=spawn(${JSON.stringify(realGit)},args,{stdio:['pipe','inherit','inherit']});
let input='';
process.stdin.on('data',bytes=>{
 if(args.includes('--stdin-paths')){
  input+=bytes;
  let end;
  while((end=input.indexOf('\\n'))!==-1){
   appendFileSync(${JSON.stringify(log)},JSON.stringify({object:args[args.indexOf('-t')+1]})+'\\n');
   input=input.slice(end+1);
  }
 }
});
process.stdin.pipe(git.stdin);
git.on('close',code=>process.exit(code??1));
`,
    { mode: 0o700 },
  );
  return { PATH: bin + ':' + process.env.PATH, log };
}
async function withPath(path, run) {
  const before = process.env.PATH;
  try {
    process.env.PATH = path;
    return await run();
  } finally {
    process.env.PATH = before;
  }
}
function same(a, b) {
  assert.deepEqual(readFileSync(join(a.path, 'mapping.json')), readFileSync(join(b.path, 'mapping.json')));
  assert.deepEqual(readFileSync(a.bundle.path), readFileSync(b.bundle.path));
}

test('batched export matches pre-batch objects, mapping and bundle bytes for rich merge history', async t => {
  const f = fixture(t),
    at = '2026-01-01T00:00:00Z';
  const file = (path, bytes, mode = 'file') => ({ path, blob: f.source.put(Buffer.from(bytes)), mode });
  const empty = f.source.writeState([], [], 'Empty root', at);
  const files = [
    file('a.b', 'prefix ordering'),
    file('a/é\t".txt', 'odd filename'),
    file('run.sh', '#!/bin/sh\n', 'executable'),
    file('link', 'a.b', 'symlink'),
    file('binary', Buffer.from([0, 255, 128, 10])),
    file('large', Buffer.alloc(2 * 1024 * 1024, 129)),
  ];
  const base = f.source.writeState(files, [empty], 'Files\nwith multiline message and é', at);
  const left = f.source.writeState(
    files.filter(file => file.path !== 'binary'),
    [base],
    'Delete binary',
    at,
  );
  const right = f.source.writeState([...files, file('added', 'side')], [base], 'Side', at);
  const head = f.source.writeState(
    [file('was-directory', 'replacement'), ...files.filter(f => !f.path.startsWith('a/'))],
    [left, right, base, base],
    'Merge, ordered duplicate parents',
    at,
  );
  const expected = await referenceExport(f.root, head, join(f.dir, 'reference'));
  const tracking = trackedGit(f);
  const actual = await withPath(tracking.PATH, () => exportNativeGit(f.root, head, join(f.dir, 'actual')));
  same(expected, actual);
  const calls = readFileSync(tracking.log, 'utf8').trim().split('\n').map(JSON.parse);
  const writes = calls.filter(c => c.args?.includes('hash-object') || c.args?.includes('mktree'));
  assert.equal(writes.length, 3);
  assert.equal(
    calls.filter(c => c.object === 'blob').length,
    new Set([empty, base, left, right, head].flatMap(id => f.source.state(id).files.map(f => f.blob))).size,
  );
  assert.equal(calls.filter(c => c.object === 'commit').length, 5);
  const prior = await exportNativeGit(f.root, base, join(f.dir, 'prior'));
  const incremental = await exportNativeGit(f.root, head, join(f.dir, 'incremental'), prior.path);
  same(expected, incremental);
  assert.equal(workGit(join(actual.path, 'repository.git'), ['fsck', '--full']).trim(), '');
});

test('a failed commit batch aborts the other workers and never publishes a partial export', async t => {
  const f = fixture(t),
    blob = f.source.put(Buffer.from('synthetic'));
  const head = f.source.writeState([{ path: 'a', blob, mode: 'file' }], [], 'Source', '2026-01-01T00:00:00Z');
  const target = join(f.dir, 'failed');
  const tracking = trackedGit(
    f,
    "if(args.includes('commit')){process.stderr.write('synthetic batch failure');process.exit(73);}",
  );
  await withPath(tracking.PATH, () =>
    assert.rejects(
      exportNativeGit(f.root, head, target),
      e => e.code === 'WORK_GIT_FAILED' && /status=73/.test(e.message),
    ),
  );
  assert.equal(existsSync(target), false);
  const calls = readFileSync(tracking.log, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter(c => c.pid);
  assert.ok(calls.length >= 4);
  assert.ok(
    calls.every(c => !processAlive({ pid: c.pid })),
    'all batch workers were reaped',
  );
  const recovered = await exportNativeGit(f.root, head, target);
  assert.equal(recovered.states.length, 1);
});

for (const behavior of [
  'process.exit(0)',
  "process.stdout.write('invalid response\\n');setInterval(()=>{},1000)",
])
  test(`batch protocol rejects early exit or invalid response: ${behavior}`, async t => {
    const f = fixture(t),
      tracking = trackedGit(f, behavior);
    await withPath(tracking.PATH, async () => {
      const worker = nativeGitBatch(f.root, ['hash-object', '-w', '--stdin-paths'], () => {});
      try {
        await assert.rejects(worker.request('unused\n'), e => e.code === 'WORK_GIT_FAILED');
      } finally {
        await worker.abort();
      }
    });
  });

test('NUL in a commit message retains the pre-batch Git rejection and leaves no destination', async t => {
  const f = fixture(t),
    head = f.source.writeState([], [], 'Invalid\0message', '2026-01-01T00:00:00Z');
  await assert.rejects(
    referenceExport(f.root, head, join(f.dir, 'reference')),
    e => e.code === 'WORK_GIT_FAILED',
  );
  await assert.rejects(
    exportNativeGit(f.root, head, join(f.dir, 'actual')),
    e => e.code === 'WORK_GIT_FAILED',
  );
  assert.equal(existsSync(join(f.dir, 'actual')), false);
});

test('batch input paths preserve spaces, tabs, newlines and UTF-8 in the export directory', async t => {
  const f = fixture(t),
    dir = join(f.dir, 'space é\t\n');
  mkdirSync(dir);
  const blob = f.source.put(Buffer.from([0, 255, 10]));
  const head = f.source.writeState(
    [{ path: 'data', blob, mode: 'file' }],
    [],
    'Bytes',
    '2026-01-01T00:00:00Z',
  );
  const actual = await exportNativeGit(f.root, head, join(dir, 'export'));
  const expected = await referenceExport(f.root, head, join(f.dir, 'reference'));
  same(expected, actual);
});

test('a stalled batch request times out and reaps a pipe-holding helper', async t => {
  const f = fixture(t),
    pids = join(f.dir, 'pids');
  const tracking = trackedGit(
    f,
    `
    const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, helper.pid]));
    process.stdin.resume();
    setInterval(()=>{},1000);
    return;
  `,
  );
  const prior = process.env.FORGE_GIT_TIMEOUT_MS;
  try {
    process.env.FORGE_GIT_TIMEOUT_MS = '1000';
    await withPath(tracking.PATH, async () => {
      const worker = nativeGitBatch(f.root, ['hash-object', '-w', '--stdin-paths'], () => {});
      try {
        await assert.rejects(worker.request('unused\n'), e => e.code === 'WORK_GIT_TIMEOUT');
      } finally {
        await worker.abort();
      }
    });
  } finally {
    if (prior === undefined) delete process.env.FORGE_GIT_TIMEOUT_MS;
    else process.env.FORGE_GIT_TIMEOUT_MS = prior;
  }
  const processes = JSON.parse(readFileSync(pids, 'utf8'));
  for (let attempt = 0; attempt < 100 && processes.some(pid => processAlive({ pid })); attempt++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(processes.every(pid => !processAlive({ pid })));
});

test('global Git attributes cannot normalize raw blob or commit bytes', async t => {
  const f = fixture(t),
    config = join(f.dir, 'config');
  mkdirSync(join(config, 'git'), { recursive: true });
  writeFileSync(join(config, 'git', 'attributes'), '* text eol=lf\n');
  const text = Buffer.from('line\r\n'),
    binary = Buffer.from([0, 13, 10, 255]);
  const head = f.source.writeState(
    [
      { path: 'text', blob: f.source.put(text), mode: 'file' },
      { path: 'binary', blob: f.source.put(binary), mode: 'file' },
    ],
    [],
    'Raw message\r\n',
    '2026-01-01T00:00:00Z',
  );
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = config;
    const expected = await referenceExport(f.root, head, join(f.dir, 'reference'));
    const actual = await exportNativeGit(f.root, head, join(f.dir, 'actual'));
    same(expected, actual);
    for (const [path, bytes] of [
      ['text', text],
      ['binary', binary],
    ])
      assert.deepEqual(
        workGit(
          join(actual.path, 'repository.git'),
          ['cat-file', 'blob', actual.commit + ':' + path],
          undefined,
          false,
          true,
        ),
        bytes,
      );
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test('large-file Git storage threshold preserves objects, exact bundles and reuse with three workers', async t => {
  const f = fixture(t),
    at = '2026-01-01T00:00:00Z';
  const base = f.source.writeState(
    [{ path: 'data', blob: f.source.put(Buffer.from('base bytes\r\n')), mode: 'file' }],
    [],
    'Base',
    at,
  );
  const head = f.source.writeState(
    [{ path: 'data', blob: f.source.put(Buffer.from('changed bytes\r\n')), mode: 'file' }],
    [base],
    'Changed',
    at,
  );
  const tracking = trackedGit(f, "args.unshift('-c', 'core.bigFileThreshold=1');");
  await withPath(tracking.PATH, async () => {
    const prior = await exportNativeGit(f.root, base, join(f.dir, 'prior'));
    const oid = workGit(join(prior.path, 'repository.git'), ['rev-parse', prior.commit + ':data']).trim();
    workGit(join(prior.path, 'repository.git'), ['cat-file', '-e', oid]);
    const expected = await referenceExport(f.root, head, join(f.dir, 'reference'));
    const fullOffset = readFileSync(tracking.log, 'utf8').trim().split('\n').length;
    const full = await exportNativeGit(f.root, head, join(f.dir, 'full'));
    same(expected, full);
    const fullCalls = readFileSync(tracking.log, 'utf8').trim().split('\n').slice(fullOffset).map(JSON.parse);
    assert.equal(
      fullCalls.filter(c => c.args?.includes('hash-object') || c.args?.includes('mktree')).length,
      3,
      'full export retains three persistent object writers across States',
    );
    const offset = readFileSync(tracking.log, 'utf8').trim().split('\n').length;
    const incremental = await exportNativeGit(f.root, head, join(f.dir, 'incremental'), prior.path);
    same(expected, incremental);
    const calls = readFileSync(tracking.log, 'utf8').trim().split('\n').slice(offset).map(JSON.parse);
    assert.equal(
      calls.filter(c => c.args?.includes('init')).length,
      1,
      'valid large-object reuse does not fall back to a fresh repository',
    );
    assert.equal(
      calls.filter(c => c.args?.includes('hash-object') || c.args?.includes('mktree')).length,
      3,
      'incremental export retains three persistent object writers',
    );
    for (const result of [prior, full, incremental]) {
      const repo = join(result.path, 'repository.git');
      workGit(repo, ['cat-file', '-e', result.commit + ':data']);
      assert.equal(workGit(repo, ['fsck', '--full', '--strict']).trim(), '');
    }
  });
});
