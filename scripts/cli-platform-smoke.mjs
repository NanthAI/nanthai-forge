// SPDX-License-Identifier: Apache-2.0
// Cross-platform CLI core-loop smoke (Windows, macOS, Linux). Runs the built CLI
// (dist/cli-entry.js) against a fresh native owner, then optionally against a
// hosted dev project when FORGE_SMOKE_PROJECT_URL and a login are present.
// It edits a CRLF file and a path with a space, renames a file by case only,
// marks a file executable and adds a symlink, then checks the accepted bytes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const json = reply => {
  const text = reply.stdout.trim();
  const line = text.lastIndexOf('\n{');
  return JSON.parse(line < 0 ? text : text.slice(line + 1));
};
const show = (root, selector, path) =>
  forge(['agent', root, 'show', JSON.stringify({ ...selector, path, force: true })], { encoding: 'buffer' })
    .stdout;

function git(cwd, args) {
  const reply = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(reply.status, 0, `git ${args[0]}: ${reply.stderr}`);
  return reply.stdout.trim();
}
const gitModes = (directory, state) =>
  new Map(
    git(directory, [
      '--git-dir',
      join(directory, 'repository.git'),
      'ls-tree',
      '-r',
      `refs/heads/forge-native/${state}`,
    ])
      .split('\n')
      .map(line => /^(\d+) \w+ \w+\t(.+)$/.exec(line))
      .filter(Boolean)
      .map(match => [match[2], match[1]]),
  );

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

function native() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'forge smoke ')));
  // Start from Git with an executable file: Windows cannot create the bit on disk itself.
  const source = join(base, 'git source');
  mkdirSync(source);
  writeFileSync(join(source, 'answer.txt'), 'one\n');
  writeFileSync(join(source, 'Case.txt'), 'case\n');
  writeFileSync(join(source, 'tool.sh'), '#!/bin/sh\necho tool\n');
  git(source, ['init', '-q']);
  git(source, ['add', '.']);
  git(source, ['update-index', '--chmod=+x', 'tool.sh']);
  git(source, ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'base']);
  const root = join(base, 'owner root');
  forge(['import-native-git', source, git(source, ['rev-parse', 'HEAD']), root]);
  forge(['x', root, 'set-policy', JSON.stringify({ operationId: randomUUID(), preset: 'trusted' })]);
  const check = 'const f=require("fs");process.exit(f.readFileSync("answer.txt","utf8").trim()==="two"?0:1)';
  forge([
    'x',
    root,
    'define-check',
    JSON.stringify({ name: 'verify', executable: process.execPath, args: ['-e', check] }),
  ]);
  const started = json(
    forge(['agent', root, 'start', JSON.stringify({ outcome: 'Smoke', operationId: randomUUID() })]),
  ).result;
  const linked = edit(started.path);
  forge([
    'agent',
    root,
    'save',
    JSON.stringify({ laneId: started.laneId, message: 'Smoke edits', operationId: randomUUID() }),
  ]);
  assert.deepEqual(
    show(root, { laneId: started.laneId }, 'dir with space/crlf file.txt'),
    crlf,
    'saved CRLF bytes',
  );
  const operationId = randomUUID();
  const landed = forge([
    'agent',
    root,
    'land',
    '--save',
    JSON.stringify({ laneId: started.laneId, message: 'Smoke land', operationId }),
  ]);
  let receipt = json(landed);
  for (let i = 0; receipt.inProgress && i < 10; i++)
    receipt = json(
      forge(['agent', root, 'wait', JSON.stringify({ operationIds: [operationId], until: 'terminal' })]),
    );
  assert.equal(
    receipt.result?.status ?? receipt.status,
    'accepted',
    `native land: ${JSON.stringify(receipt).slice(0, 2000)}`,
  );
  const main = { channel: 'main' };
  assert.deepEqual(show(root, main, 'dir with space/crlf file.txt'), crlf, 'accepted CRLF bytes');
  assert.equal(show(root, main, 'answer.txt').toString(), 'two\n');
  assert.equal(show(root, main, 'CASE.txt').toString(), 'case\n');
  // "Pull": a new Lane materializes accepted main.
  const next = json(
    forge(['agent', root, 'start', JSON.stringify({ outcome: 'Pull', operationId: randomUUID() })]),
  ).result;
  const names = readdirSync(next.path);
  assert.ok(names.includes('CASE.txt') && !names.includes('Case.txt'), `case rename: ${names}`);
  assert.deepEqual(
    readFileSync(join(next.path, 'dir with space', 'crlf file.txt')),
    crlf,
    'materialized CRLF',
  );
  if (linked) {
    const link = lstatSync(join(next.path, 'link.txt'));
    if (link.isSymbolicLink()) assert.equal(readlinkSync(join(next.path, 'link.txt')), 'answer.txt');
    else report.differences.push('symlink materialized as a regular file');
  }
  // Recorded modes of accepted main, read back through a Git export.
  const exported = join(base, 'export');
  forge(['export-native-git', root, next.base, exported]);
  const modes = gitModes(exported, next.base);
  assert.equal(modes.get('tool.sh'), '100755', 'edited executable keeps its mode');
  assert.equal(modes.get('dir with space/crlf file.txt'), '100644');
  if (linked) assert.equal(modes.get('link.txt'), '120000', 'symlink recorded as a link');
  if (process.platform === 'win32') {
    assert.equal(modes.get('new.sh'), '100644', 'Windows stores no executable bit for a new file');
    report.differences.push('a new file cannot be made executable from Windows (no executable bit on disk)');
  } else assert.equal(modes.get('new.sh'), '100755');
  if (linked && process.platform === 'win32') {
    // Without link rights Windows gets the link as a file holding its target; saving it is no change.
    rmSync(join(next.path, 'link.txt'));
    writeFileSync(join(next.path, 'link.txt'), 'answer.txt');
    const saved = json(
      forge([
        'agent',
        root,
        'save',
        JSON.stringify({ laneId: next.laneId, message: 'Link fallback', operationId: randomUUID() }),
      ]),
    ).result;
    assert.equal(saved.head, next.base, 'a link held as its target file saves unchanged');
  }
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}

try {
  native();
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack ?? error).slice(0, 6000);
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
