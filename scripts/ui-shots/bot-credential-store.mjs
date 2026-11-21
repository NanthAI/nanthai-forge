// SPDX-License-Identifier: Apache-2.0
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicPrivate, secretLocked } from '../../dist/sealed-local.js';
import { ShotError } from './options.mjs';

async function statIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function outsideRepositories(path) {
  for (let current = path; ; current = dirname(current)) {
    for (const marker of ['.git', '.forge', '.nforge', '.forge-client']) {
      if (await statIfExists(join(current, marker)))
        throw new ShotError('The bot credential directory must be outside repositories and Forge Lanes.');
    }
    if (current === dirname(current)) return;
  }
}

function privateBytes(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600)
      throw new ShotError('Existing bot credentials must be a user-owned 0600 regular file.');
    const bytes = readFileSync(fd);
    if (!bytes.length) throw new ShotError('Invalid bot credentials file.');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export async function openBotCredentialStore(home) {
  const realHome = await realpath(home);
  const config = join(realHome, '.config');
  await outsideRepositories(realHome);
  if (!(await statIfExists(config))) await mkdir(config, { mode: 0o700 }).catch(existingDirectory);
  const parent = await realpath(config);
  await outsideRepositories(parent);
  const dir = join(parent, 'forge-ui-bot');
  await mkdir(dir, { mode: 0o700 }).catch(existingDirectory);
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new ShotError('The bot credential directory must be user-owned.');
  if ((info.mode & 0o777) !== 0o700) await chmod(dir, 0o700);

  const file = join(dir, 'credentials.json');
  let original = privateBytes(file);
  const data = original.length ? JSON.parse(original.toString('utf8')) : {};
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new ShotError('Invalid bot credentials file.');

  return {
    data,
    save() {
      return secretLocked(join(dir, '.setup-lock'), () => {
        const current = privateBytes(file);
        if (!current.equals(original))
          throw new ShotError('Another setup changed the bot credentials. Rerun with the saved credential.');
        const next = Buffer.from(JSON.stringify(data) + '\n');
        if (!next.equals(current)) atomicPrivate(file, next);
        original = next;
      });
    },
  };
}

function existingDirectory(error) {
  if (error.code !== 'EEXIST') throw error;
}
