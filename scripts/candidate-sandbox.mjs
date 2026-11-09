// SPDX-License-Identifier: Apache-2.0
// Started by the hosted check supervisor as `sudo -n unshare --mount --propagation private --
// node candidate-sandbox.mjs SPEC` (src/candidate-user.ts). Runs as root inside a private mount
// namespace, so nothing here is visible to the runner. Replaces the runner's home with an empty
// directory the Candidate user owns, binds back only the listed paths at their own paths
// (writable ones owned by that user, readable ones read-only), then runs the command as that
// user with no groups, no capabilities and no_new_privs. Plain Node and util-linux only.
import { spawn, spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const specPath = process.argv[2];
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
rmSync(specPath, { force: true });
const fail = message => {
  console.error(`Forge: the Candidate user sandbox failed (${message}).`);
  process.exit(125);
};
const sh = (command, args) => {
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0) fail(`${command} ${args[0]}`);
};
const id = flag => Number(spawnSync('id', [flag, spec.user], { encoding: 'utf8' }).stdout.trim());
const uid = id('-u'),
  gid = id('-g');
if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) fail('no such user');
for (const path of spec.chown) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  sh('chown', ['-R', `${uid}:${gid}`, path]);
}
const home = spec.home;
const under = path => path.startsWith(`${home}/`);
const base = `/var/lib/forge-check/${process.pid}`;
if (home !== '/' && existsSync(home)) {
  mkdirSync(join(base, 'real'), { recursive: true });
  mkdirSync(join(base, 'home'), { recursive: true });
  chownSync(join(base, 'home'), uid, gid);
  sh('mount', ['--bind', home, join(base, 'real')]);
  sh('mount', ['--bind', join(base, 'home'), home]);
  // Parents first, so a writable cache inside a read-only toolchain folder (or the reverse) nests.
  const entries = [
    ...spec.writable.filter(under).map(path => [path, true]),
    ...spec.readable.filter(under).map(path => [path, false]),
  ].sort(([a], [b]) => a.length - b.length);
  for (const [path, writable] of entries) {
    const source = join(base, 'real', path.slice(home.length));
    if (!existsSync(source)) continue;
    // Mount points inside the Candidate's home belong to the Candidate, like any home folder.
    let parent = home;
    for (const part of dirname(path).slice(home.length).split('/').filter(Boolean)) {
      parent = join(parent, part);
      if (!existsSync(parent)) {
        mkdirSync(parent);
        chownSync(parent, uid, gid);
      }
    }
    if (statSync(source).isDirectory()) {
      if (!existsSync(path)) mkdirSync(path);
      chownSync(path, uid, gid);
    } else if (!existsSync(path)) writeFileSync(path, '');
    sh('mount', ['--bind', source, path]);
    if (!writable) sh('mount', ['-o', 'remount,bind,ro', path]);
  }
  sh('umount', ['-l', join(base, 'real')]);
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
