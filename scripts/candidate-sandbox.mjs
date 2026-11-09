// SPDX-License-Identifier: Apache-2.0
// Started by the hosted check supervisor as `sudo -n unshare --mount --propagation private --
// node candidate-sandbox.mjs SPEC` (src/candidate-user.ts). Runs as root inside a private mount
// namespace, so nothing here is visible to the runner. Replaces the runner's home with an empty
// directory the Candidate user owns, binds back only the listed paths at their own paths
// (writable ones owned by that user, readable ones read-only, toolchain state folders as private
// copies; scripts/candidate-sandbox-plan.mjs), then runs the command as that user with no groups,
// no capabilities and no_new_privs. Plain Node and util-linux only.
import { spawn, spawnSync } from 'node:child_process';
import {
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { STATE_ROOT, gitSafeConfig, mountPlan } from './candidate-sandbox-plan.mjs';

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
rmSync(specPath, { force: true });
const home = spec.home;
const base = `/var/lib/forge-check/${process.pid}`;
const real = join(base, 'real');
// Paths in messages are relative to the home, so the retained log keeps them (it masks absolute paths).
const show = path =>
  path === home || path.startsWith(`${home}/`) ? `$HOME${path.slice(home.length)}` : path;
const fail = message => {
  console.error(`Forge: the Candidate user sandbox failed (${message}).`);
  process.exit(125);
};
const sh = (command, args, path) => {
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0) fail(`${command} ${args[0]}${path ? ` ${show(path)}` : ''}`);
};
const id = flag => Number(spawnSync('id', [flag, spec.user], { encoding: 'utf8' }).stdout.trim());
const uid = id('-u'),
  gid = id('-g');
if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) fail('no such user');
for (const path of spec.chown) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  sh('chown', ['-R', `${uid}:${gid}`, path]);
}
const swapped = home !== '/' && existsSync(home);
if (swapped) {
  mkdirSync(real, { recursive: true });
  mkdirSync(join(base, 'home'), { recursive: true });
  chownSync(join(base, 'home'), uid, gid);
  sh('mount', ['--bind', home, real]);
  sh('mount', ['--bind', join(base, 'home'), home]);
}
// Planned against the swapped view: the fresh home, the real one at `real`, the rest as it is.
const steps = mountPlan({
  home,
  real,
  writable: spec.writable,
  readable: spec.readable,
  copies: spec.copies ?? [],
  exists: existsSync,
  isDirectory: path => statSync(path).isDirectory(),
});
for (const step of steps) {
  const target = step.path ?? step.store;
  try {
    if (step.step === 'mkdir') {
      mkdirSync(step.path);
      chownSync(step.path, uid, gid);
    } else if (step.step === 'touch') writeFileSync(step.path, '');
    else if (step.step === 'copy') {
      // Once per job: later launches (pool units) reuse the copy and what the Candidate wrote there.
      if (existsSync(step.store)) continue;
      mkdirSync(STATE_ROOT, { recursive: true, mode: 0o711 });
      const temp = `${step.store}.${process.pid}`;
      mkdirSync(temp);
      sh('cp', ['-a', '--', `${step.source}/.`, temp], step.source);
      sh('chown', ['-R', `${uid}:${gid}`, temp], step.source);
      renameSync(temp, step.store);
    } else if (step.step === 'bind') sh('mount', ['--bind', step.source, step.path], step.path);
    else sh('mount', ['-o', 'remount,bind,ro', step.path], step.path);
  } catch (error) {
    fail(`${step.step} ${show(target)}: ${error.code ?? error.message}`);
  }
}
if (swapped) {
  const config = gitSafeConfig(home, spec.gitSafe ?? []);
  if (config && !existsSync(join(home, '.gitconfig'))) {
    writeFileSync(join(home, '.gitconfig'), config);
    chownSync(join(home, '.gitconfig'), uid, gid);
  }
  sh('umount', ['-l', real]);
}
const child = spawn(
  'setpriv',
  [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    '--clear-groups',
    '--no-new-privs',
    '--inh-caps=-all',
    '--bounding-set=-all',
    '--',
    ...spec.argv,
  ],
  { cwd: spec.cwd, env: spec.env, stdio: 'inherit' },
);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(127));
child.on('close', (code, signal) => {
  // Only this namespace saw these mounts; the Candidate home's own files go with it.
  if (existsSync(base)) {
    spawnSync('umount', ['-R', '-l', home], { stdio: 'ignore' });
    rmSync(base, { recursive: true, force: true });
  }
  process.exit(code ?? (signal ? 128 : 1));
});
