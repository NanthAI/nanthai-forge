// SPDX-License-Identifier: Apache-2.0
// Cross-platform CLI smoke (Windows, macOS, Linux). Forge has one client mode (hosted), so the
// built CLI (dist/cli-entry.js) must refuse a folder without a hosted marker with one next step.
// The shared source kernel that hosted clones and Lanes use (dist/native-source.js) then captures
// an edited CRLF file and a path with a space, a case-only rename, an executable file and a
// symlink into a State and materializes it into a fresh folder, checking bytes and modes. It then
// runs the self-hosted runner's exact-source check of one fixed commit on this OS and the runner
// contract test on both adapters (Issue 1444471f).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeSource } from '../dist/native-source.js';

const cli = fileURLToPath(new URL('../dist/cli-entry.js', import.meta.url));
const report = { platform: process.platform, node: process.version, steps: [], differences: [] };
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
};
const crlf = Buffer.from('first line\r\nsecond line\r\n');

function forge(args, options = {}) {
  const started = Date.now();
  const reply = spawnSync(process.execPath, [cli, ...args], {
    env,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 600_000,
  });
  const step = { args: args.slice(0, 3), status: reply.status, ms: Date.now() - started };
  report.steps.push(step);
  if (reply.status !== 0 && !options.allowFailure) {
    const detail = `${reply.stderr ?? ''}\n${reply.stdout ?? ''}`.trim().slice(-4000);
    throw new Error(`nforge ${args.slice(0, 3).join(' ')} exited ${reply.status}: ${detail || reply.error}`);
  }
  return reply;
}
function edit(lane) {
  writeFileSync(join(lane, 'answer.txt'), 'two\n');
  mkdirSync(join(lane, 'dir with space'), { recursive: true });
  writeFileSync(join(lane, 'dir with space', 'crlf file.txt'), crlf);
  // An edit to an executable file keeps it executable; a new file asks for the bit with chmod.
  writeFileSync(join(lane, 'tool.sh'), '#!/bin/sh\necho tool edited\n');
  writeFileSync(join(lane, 'new.sh'), '#!/bin/sh\necho new\n');
  chmodSync(join(lane, 'new.sh'), 0o755);
  renameSync(join(lane, 'Case.txt'), join(lane, 'CASE.txt'));
  try {
    symlinkSync('answer.txt', join(lane, 'link.txt'));
    return true;
  } catch (error) {
    report.differences.push(`symlink creation refused by the OS (${error.code}); symlink step skipped`);
    return false;
  }
}

function refusal() {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'forge smoke plain ')));
  const reply = forge(['agent', plain, 'status', '{}'], { allowFailure: true });
  assert.equal(reply.status, 1, 'a folder without a hosted marker is refused');
  const error = JSON.parse(reply.stderr).error;
  assert.equal(error.code, 'FORGE_ROOT_UNAVAILABLE');
  assert.match(error.message, /nforge host/);
  rmSync(plain, { recursive: true, force: true, maxRetries: 5 });
}

function kernel() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'forge smoke ')));
  const store = new NativeSource(base);
  const at = new Date().toISOString();
  const file = (path, text, mode = 'file') => ({ path, blob: store.put(Buffer.from(text)), mode });
  // Start from a State with an executable file: Windows cannot create the bit on disk itself.
  const start = store.writeState(
    [
      file('answer.txt', 'one\n'),
      file('Case.txt', 'case\n'),
      file('tool.sh', '#!/bin/sh\necho tool\n', 'executable'),
    ],
    [],
    'base',
    at,
  );
  const lane = join(base, 'lane one');
  store.materialize(start, lane, false);
  const linked = edit(lane);
  const head = store.writeState(store.capture(lane, true, start), [start], 'Smoke edits', at);
  const saved = new Map(store.state(head).files.map(entry => [entry.path, entry]));
  assert.deepEqual(store.object(saved.get('dir with space/crlf file.txt').blob), crlf, 'saved CRLF bytes');
  assert.equal(store.object(saved.get('answer.txt').blob).toString(), 'two\n');
  assert.ok(saved.has('CASE.txt') && !saved.has('Case.txt'), `case rename: ${[...saved.keys()]}`);
  assert.equal(saved.get('tool.sh').mode, 'executable', 'edited executable keeps its mode');
  assert.equal(saved.get('dir with space/crlf file.txt').mode, 'file');
  if (linked) assert.equal(saved.get('link.txt')?.mode, 'symlink', 'symlink recorded as a link');
  if (process.platform === 'win32') {
    assert.equal(saved.get('new.sh').mode, 'file', 'Windows stores no executable bit for a new file');
    report.differences.push('a new file cannot be made executable from Windows (no executable bit on disk)');
  } else assert.equal(saved.get('new.sh').mode, 'executable');
  // "Pull": a fresh folder materializes the saved State.
  const next = join(base, 'lane two');
  store.materialize(head, next, false);
  const names = readdirSync(next);
  assert.ok(names.includes('CASE.txt') && !names.includes('Case.txt'), `case rename: ${names}`);
  assert.deepEqual(readFileSync(join(next, 'dir with space', 'crlf file.txt')), crlf, 'materialized CRLF');
  if (linked) {
    const link = lstatSync(join(next, 'link.txt'));
    if (link.isSymbolicLink()) assert.equal(readlinkSync(join(next, 'link.txt')), 'answer.txt');
    else report.differences.push('symlink materialized as a regular file');
  }
  if (linked && process.platform === 'win32') {
    // Without link rights Windows gets the link as a file holding its target; capturing it is no change.
    rmSync(join(next, 'link.txt'));
    writeFileSync(join(next, 'link.txt'), 'answer.txt');
    assert.equal(
      store.tree(store.capture(next, false, head)),
      store.tree(store.state(head).files),
      'a link held as its target file captures unchanged',
    );
  }
  report.steps.push({ args: ['kernel', 'capture', 'materialize'], status: 0 });
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

/** The self-hosted runner checks one fixed commit on this OS against the in-process backend fixture
 * (tests/hosted-mac-runner.test.mjs, no OS mocks; its qualification line names date, OS and outcome),
 * and the landing queue's runner contract passes on GitHub Actions and the self-hosted adapter. */
function selfHostedCheck() {
  const started = Date.now();
  const reply = spawnSync(
    process.execPath,
    [
      '--import',
      './tests/check-runtime.mjs',
      '--test',
      '--test-name-pattern=1444471f',
      '--test-name-pattern=^runner contract on',
      'tests/hosted-mac-runner.test.mjs',
      'tests/hosted-landing-prequeue.test.mjs',
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    },
  );
  report.steps.push({
    args: ['self-hosted', 'exact-source'],
    status: reply.status,
    ms: Date.now() - started,
  });
  report.selfHosted = /qualification [^\n]*/.exec(reply.stdout ?? '')?.[0] ?? null;
  if (reply.status !== 0)
    throw new Error(
      `self-hosted exact-source check exited ${reply.status}: ${`${reply.stdout ?? ''}${reply.stderr ?? ''}`.slice(-4000) || reply.error}`,
    );
}

try {
  refusal();
  kernel();
  selfHostedCheck();
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack ?? error).slice(0, 6000);
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
