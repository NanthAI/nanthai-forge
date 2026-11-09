// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { toolchainEnvNames, toolchainEnvPattern } from '../scripts/child-env.mjs';

/** The system user a hosted check's Candidate children run as on Linux (Issue 432164bf). */
export const CANDIDATE_USER = 'forge-check';
const SANDBOX = join(import.meta.dirname, '../scripts/candidate-sandbox.mjs');

/** What a Candidate child may see under the runner's home: writable paths become the
 * Candidate's own; readable paths are bound back read-only at the same path. Anything else under
 * the home (the runner's credentials, step-command files, other caches) is not there. */
export type CandidatePaths = { writable: readonly string[]; readable: readonly string[] };
export type CandidateIsolation =
  | {
      mode: 'user';
      user: string;
      /** argv for spawn: the launcher runs `argv` as the Candidate user with exactly `env`. */
      command(
        argv: readonly string[],
        env: Record<string, string>,
        cwd: string,
        paths: CandidatePaths,
      ): string[];
      /** Removes a path the Candidate user owns now (the supervisor cannot). Best effort. */
      remove(path: string): void;
    }
  | { mode: 'shared'; reason: string };

type Run = (command: string, args: string[]) => { status: number | null };
const run: Run = (command, args) => spawnSync(command, args, { stdio: 'ignore', timeout: 20_000 });

/**
 * Linux runners where the runner user has passwordless sudo (GitHub-hosted Ubuntu) start every
 * Candidate child as `forge-check` in a private mount namespace (scripts/candidate-sandbox.mjs).
 * The child cannot read the supervisor's or the runner's environment, the runner's credentials or
 * step-command files, and cannot use sudo. Anywhere else the child runs as the runner user, and the
 * job log says why. A launch self-test decides; a failed probe never breaks the check.
 */
export function candidateIsolation(
  input: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; run?: Run } = {},
): CandidateIsolation {
  const env = input.env ?? process.env,
    platform = input.platform ?? process.platform,
    exec = input.run ?? run;
  if (env.FORGE_CANDIDATE_USER === 'off')
    return { mode: 'shared', reason: 'turned off for this runner (FORGE_CANDIDATE_USER=off)' };
  if (platform !== 'linux') return { mode: 'shared', reason: `${platform} runner` };
  if (exec('sudo', ['-n', 'true']).status !== 0)
    return { mode: 'shared', reason: 'the runner user has no passwordless sudo' };
  if (
    exec('sudo', ['-n', 'sh', '-c', 'command -v unshare && command -v setpriv && command -v mount'])
      .status !== 0
  )
    return { mode: 'shared', reason: 'unshare, setpriv or mount is missing' };
  const home = resolve(env.HOME ?? '/');
  // The account's home is the home the child sees: inside the sandbox the runner's home path is
  // the Candidate's own empty, writable folder. Code that reads the password database instead of
  // HOME (os.userInfo().homedir) then lands in the same place, not in a folder that does not exist.
  const accountHome = home === '/' ? '/nonexistent' : home;
  const account = exec('id', ['-u', CANDIDATE_USER]).status === 0;
  if (
    // No home directory is created: creating one costs about 30 s on GitHub's Ubuntu image (measured).
    exec(
      'sudo',
      account
        ? ['-n', 'usermod', '--home', accountHome, CANDIDATE_USER]
        : [
            '-n',
            'useradd',
            '--system',
            '--no-create-home',
            '--user-group',
            '--home-dir',
            accountHome,
            '--shell',
            '/usr/sbin/nologin',
            CANDIDATE_USER,
          ],
    ).status !== 0
  )
    return {
      mode: 'shared',
      reason: `could not ${account ? 'set up' : 'create'} the ${CANDIDATE_USER} user`,
    };
  const specs = mkdtempSync(join(tmpdir(), 'forge-candidate-'));
  chmodSync(specs, 0o700);
  let launches = 0;
  const owned = new Set<string>();
  const isolation: CandidateIsolation = {
    mode: 'user',
    user: CANDIDATE_USER,
    command(argv, childEnv, cwd, paths) {
      const spec = join(specs, `${++launches}.json`);
      const writable = paths.writable.map(path => resolve(path));
      writeFileSync(
        spec,
        JSON.stringify({
          user: CANDIDATE_USER,
          home,
          cwd,
          argv,
          env: { ...childEnv, USER: CANDIDATE_USER, LOGNAME: CANDIDATE_USER },
          writable,
          readable: paths.readable.map(path => resolve(path)),
          // Ownership moves once per path; later parts of the same job (shard pool units) reuse it.
          chown: writable.filter(path => !owned.has(path)),
        }),
        { mode: 0o600 },
      );
      for (const path of writable) owned.add(path);
      return [
        'sudo',
        '-n',
        '--',
        'unshare',
        '--mount',
        '--propagation',
        'private',
        '--',
        process.execPath,
        SANDBOX,
        spec,
      ];
    },
    remove(path) {
      exec('sudo', ['-n', 'rm', '-rf', '--', path]);
    },
  };
  // Self-test: one launch of `true` through the same path the check takes (about 0.1 s).
  const test = isolation.command(['/bin/true'], { PATH: '/usr/bin:/bin' }, '/', {
    writable: [],
    readable: [],
  });
  if (exec(test[0]!, test.slice(1)).status !== 0)
    return { mode: 'shared', reason: 'the Candidate user launch self-test failed' };
  return isolation;
}

/** Variables naming a toolchain's own install (read-only); data homes such as CARGO_HOME,
 * GOPATH or GRADLE_USER_HOME are left out, so the Candidate gets fresh writable ones. */
const dataHomes = new Set([
  'CARGO_HOME',
  'GOPATH',
  'GOMODCACHE',
  'GOCACHE',
  'NUGET_PACKAGES',
  'GRADLE_USER_HOME',
]);

/** Toolchain folders under the runner's home that a Candidate child reads: PATH entries,
 * toolchain-install variables and rustup's default home (GitHub's image installs Rust there). */
export function toolchainReadable(env: NodeJS.ProcessEnv, home = env.HOME ?? '') {
  if (!home) return [];
  const root = resolve(home);
  const under = (path: string) => path.startsWith(`${root}/`);
  const out = new Set<string>();
  for (const entry of (env.PATH ?? '').split(delimiter))
    if (entry && under(resolve(entry))) out.add(resolve(entry));
  for (const [name, value] of Object.entries(env)) {
    if (!value || dataHomes.has(name)) continue;
    if (!toolchainEnvNames.includes(name) && !toolchainEnvPattern.test(name)) continue;
    for (const entry of value.split(delimiter)) if (entry && under(resolve(entry))) out.add(resolve(entry));
  }
  if (!env.RUSTUP_HOME) out.add(join(root, '.rustup'));
  return [...out].filter(path => existsSync(path)).sort();
}

/** `~/…` cache paths expanded against the runner's home. */
export const homePaths = (paths: readonly string[], home = process.env.HOME ?? '') =>
  paths.map(path => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path));
