// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { childEnv, toolchainEnvAllow } from '../scripts/child-env.mjs';
import { DEPS_SEED_PROGRAM } from './actions-toolchains.js';
import {
  candidateIsolation,
  homePaths,
  toolchainReadable,
  type CandidateIsolation,
} from './candidate-user.js';

/** The workflow's seed step (`hosted-actions-job.mjs seed`, Issue 432164bf): runs before any
 * Candidate step of a main audit with a dependency-cache miss. The seed program reads the
 * Candidate's lockfiles as data and downloads with the Candidate user's rights: it may write only
 * the declared cache paths. It never fails the job; the save step that follows saves what it got. */
export async function seedDependencyCache(
  env: NodeJS.ProcessEnv = process.env,
  isolation: CandidateIsolation = candidateIsolation({ env }),
) {
  const directory = resolve(env.FORGE_CANDIDATE ?? '.');
  const home = env.HOME ?? '';
  const command = [process.execPath, '-e', DEPS_SEED_PROGRAM, directory, env.FORGE_DEPS_SEED ?? ''];
  const childVars = childEnv({ allow: ['CI', 'PATH', ...toolchainEnvAllow(env)], source: env }) as Record<
    string,
    string
  >;
  const argv =
    isolation.mode === 'user'
      ? isolation.command(command, childVars, tmpdir(), {
          writable: homePaths((env.FORGE_DEPS_PATHS ?? '').split('\n').filter(Boolean), home),
          readable: [directory, ...toolchainReadable(env, home)],
        })
      : command;
  console.log(
    isolation.mode === 'user'
      ? `Forge seed: runs as ${isolation.user}.`
      : `Forge seed: runs as the runner user (${isolation.reason}).`,
  );
  const code = await new Promise<number>(done => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: tmpdir(), env: childVars, stdio: 'inherit' });
    child.on('error', () => done(127));
    child.on('close', code => done(code ?? 1));
  });
  if (code !== 0) console.log(`Forge seed: skipped (exit ${code}); the check runs without a seeded cache.`);
  return 0;
}
