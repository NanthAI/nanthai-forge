// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function packageNpm(env = process.env) {
  if (env.npm_execpath) return realpathSync(env.npm_execpath);
  try {
    return realpathSync(createRequire(import.meta.url).resolve('npm/bin/npm-cli.js'));
  } catch {
    // Preflight runs the package probe directly, outside an npm script.
    const prefix = dirname(dirname(process.execPath));
    return realpathSync(join(prefix, 'lib/node_modules/npm/bin/npm-cli.js'));
  }
}

function optionalBytes(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

/** Hash configuration files privately. Registry configuration may carry account credentials. */
export function packageNpmKey(root, { env = process.env, npm = packageNpm(env) } = {}) {
  const npmRoot = dirname(dirname(npm));
  const hash = createHash('sha256');
  function add(bytes) {
    hash.update(`${bytes.length}\0`).update(bytes);
  }
  for (const value of [realpathSync(npm), readFileSync(npm), optionalBytes(join(npmRoot, 'package.json'))])
    add(value);

  const flags = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase().startsWith('npm_config_')) flags.set(name.toLowerCase().slice(11), value);
  }
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const prefix = flags.get('prefix') ?? env.PREFIX ?? dirname(dirname(process.execPath));
  for (const file of [
    join(npmRoot, 'npmrc'),
    flags.get('globalconfig') ?? join(prefix, 'etc/npmrc'),
    flags.get('userconfig') ?? join(home, '.npmrc'),
    join(root, '.npmrc'),
  ])
    add(optionalBytes(resolve(root, file)));
  // npm lifecycle metadata and options displaced by the pack/install flags do not change
  // the locked bytes. Config-file paths are already represented by their contents above.
  for (const name of [
    'allow_scripts',
    'cache',
    'global_prefix',
    'globalconfig',
    'init_module',
    'local_prefix',
    'loglevel',
    'node_gyp',
    'noproxy',
    'npm_version',
    'prefix',
    'user_agent',
    'userconfig',
  ])
    flags.delete(name);
  add(JSON.stringify([...flags.entries()].sort()));
  add(JSON.stringify([env.NODE_ENV, env.NODE_OPTIONS]));
  return hash.digest('hex');
}
