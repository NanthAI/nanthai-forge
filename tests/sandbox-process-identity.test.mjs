// SPDX-License-Identifier: Apache-2.0
// Issue 5909318b: agent harnesses (Codex, Claude Code sandbox mode, ...) run tools under macOS
// sandbox-exec, which refuses to exec setuid /bin/ps. Process identity must still be recorded,
// and must equal what an unsandboxed observer records for the same process.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const sandboxed = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const skip = sandboxed ? false : 'needs macOS /usr/bin/sandbox-exec';

// Minimal agent-style profile: everything denied except what a CLI needs to run; in particular
// setuid exec is refused by the kernel for any sandboxed process, as under Codex.
const PROFILE = `(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow file-read*)
(allow file-write* (subpath "/dev") (subpath "TMP"))
(allow sysctl-read)
(allow process-info* (target self))
(allow signal (target same-sandbox))
(allow mach-lookup)
`;

const CHILD = `
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
const [, , peerPid, testPid] = process.argv.map(Number);
const lp = await import(new URL('local-process.js', process.env.DIST));
const launcher = await import(new URL('cli-launcher.js', process.env.DIST));
const out = {};
try { execFileSync('/bin/ps', ['-p', String(process.pid)], { stdio: 'ignore' }); out.psRefused = false; }
catch (error) { out.psRefused = error.code === 'EPERM'; }
out.self = lp.processIdentity();
out.launcher = launcher.cliProcessIdentity();
out.peer = lp.processIdentity(peerPid);
out.test = lp.processIdentity(testPid);
out.alive = lp.processesAlive([out.peer, { ...out.peer, startTime: 'reused' }, out.test, { pid: peerPid }]);
out.aliveOne = lp.processAlive(out.peer);
const own = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true });
await once(own, 'spawn');
const ownIdentity = lp.processIdentity(own.pid);
out.groupRows = execFileSync('/usr/bin/perl', ['-e', lp.DARWIN_KERNEL_READER, '2', String(own.pid)], { encoding: 'utf8' });
out.ownPid = own.pid;
out.groupAlive = lp.processGroupAlive(own.pid, ownIdentity.startTime);
const exited = once(own, 'exit');
own.kill();
await exited;
out.groupAfterExit = lp.processGroupAlive(own.pid, ownIdentity.startTime);
out.aliveAfterExit = lp.processesAlive([ownIdentity, out.peer]);
out.missingAfterExit = lp.processStartTime(own.pid) ?? null;
process.stdout.write(JSON.stringify(out));
`;

test('process identity works inside a macOS sandbox that refuses setuid ps', { skip }, async t => {
  const { processIdentity } = await import(new URL('local-process.js', dist));
  const dir = mkdtempSync(join(tmpdir(), 'forge-sandbox-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = execFileSync('/bin/realpath', [dir], { encoding: 'utf8' }).trim();
  const profile = join(dir, 'agent.sb');
  writeFileSync(profile, PROFILE.replace('TMP', real));
  writeFileSync(join(dir, 'child.mjs'), CHILD);
  const peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  t.after(() => peer.kill());
  await once(peer, 'spawn');
  const result = JSON.parse(
    execFileSync(
      '/usr/bin/sandbox-exec',
      ['-f', profile, process.execPath, join(dir, 'child.mjs'), String(peer.pid), String(process.pid)],
      { encoding: 'utf8', env: { ...process.env, DIST: dist.href }, stdio: ['ignore', 'pipe', 'inherit'] },
    ),
  );
  assert.equal(result.psRefused, true, 'the profile must reproduce the setuid refusal');
  // Same text an unsandboxed ps observer records: locks written on either side stay comparable.
  assert.equal(result.peer.startTime, processIdentity(peer.pid).startTime);
  assert.equal(result.test.startTime, processIdentity().startTime);
  assert.match(result.self.startTime, /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
  assert.deepEqual(result.launcher, result.self);
  assert.deepEqual(result.alive, [true, false, true, true]);
  assert.equal(result.aliveOne, true);
  assert.match(result.groupRows, new RegExp(`^${result.ownPid} \\d+ \\d+\\n$`));
  assert.equal(result.groupAlive, true);
  assert.equal(result.groupAfterExit, false);
  assert.deepEqual(result.aliveAfterExit, [false, true]);
  assert.equal(result.missingAfterExit, null);
});

test(
  'the standalone launcher carries the same kernel reader',
  { skip: process.platform !== 'darwin' },
  async () => {
    const { DARWIN_KERNEL_READER } = await import(new URL('local-process.js', dist));
    const { LAUNCHER_KERNEL_READER } = await import(new URL('cli-launcher.js', dist));
    assert.equal(typeof DARWIN_KERNEL_READER, 'string');
    assert.equal(LAUNCHER_KERNEL_READER, DARWIN_KERNEL_READER);
    assert.doesNotMatch(DARWIN_KERNEL_READER, /\0/, 'argv cannot carry NUL bytes');
  },
);

test(
  'refused ps falls back to one kernel read per batch and keeps ambiguity conservative',
  { skip: process.platform !== 'darwin' },
  async t => {
    const { processesAlive, processIdentity, lstartText } = await import(new URL('local-process.js', dist));
    const self = processIdentity(),
      original = childProcess.execFileSync,
      calls = [];
    let kernel = null;
    childProcess.execFileSync = (file, args, options) => {
      calls.push(file);
      if (file === '/bin/ps')
        throw Object.assign(new Error('spawnSync /bin/ps EPERM'), { code: 'EPERM', status: null });
      if (file === '/usr/bin/perl' && kernel !== null) {
        if (kernel instanceof Error) throw kernel;
        return kernel;
      }
      return original(file, args, options);
    };
    syncBuiltinESMExports();
    t.after(() => {
      childProcess.execFileSync = original;
      syncBuiltinESMExports();
    });
    const seconds = Math.floor(Date.parse(`${self.startTime} UTC`) / 1000);
    assert.equal(lstartText(seconds), self.startTime);
    const identities = [self, { ...self, startTime: 'reused' }, { pid: self.pid }];
    kernel = `${self.pid} ${seconds} 2\n`;
    assert.deepEqual(processesAlive(identities), [true, false, true]);
    assert.deepEqual(calls, ['/bin/ps', '/usr/bin/perl']);
    kernel = `${self.pid} ${seconds} 5\n`; // SZOMB
    assert.deepEqual(processesAlive(identities), [false, false, false]);
    kernel = new Error('kernel reader failed');
    assert.deepEqual(processesAlive(identities), [true, true, true]);
    assert.deepEqual(
      calls,
      ['/bin/ps', '/usr/bin/perl', '/usr/bin/perl', '/usr/bin/perl'],
      'ps is not retried once refused',
    );
  },
);
