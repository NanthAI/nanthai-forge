// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  symlinkSync,
  statSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invariant } from './errors.js';
import { releaseJson, releaseSave, releaseQuote, releaseWrite } from './maintainer-release-files.js';

const suffix = '/node_modules/@nanthai/forge/dist/cli.js';
const schema = z.object({
  path: z.string(),
  installed: z.string(),
  previous: z.string(),
  kind: z.enum(['directory', 'symlink', 'file', 'unchanged']),
  dev: z.number(),
  ino: z.number(),
});
/** Pin the entire install, never patch a file inside an older package. */
export function selectOwnerInstall(directory: string, cli: string, install: string) {
  const planPath = join(directory, 'owner-install-selection.json');
  const packageEntry = cli.endsWith(suffix);
  const installed = realpathSync(packageEntry ? install : join(install, suffix.slice(1)));
  let plan: z.infer<typeof schema>;
  if (existsSync(planPath)) plan = schema.parse(releaseJson(planPath));
  else {
    const path = packageEntry ? cli.slice(0, -suffix.length) : cli;
    const stat = lstatSync(path);
    invariant(
      stat.isDirectory() || stat.isSymbolicLink() || (!packageEntry && stat.isFile()),
      'RELEASE_OWNER_PATH',
      'Owner selection must name an install directory, file or symlink.',
    );
    const backup = `${path}.previous-${randomUUID()}${stat.isFile() ? '.js' : ''}`;
    if (stat.isFile()) releaseWrite(backup, readFileSync(path), stat.mode & 0o777);
    plan = {
      path,
      installed,
      previous: path === installed ? installed : stat.isSymbolicLink() ? realpathSync(path) : backup,
      kind:
        path === installed
          ? 'unchanged'
          : stat.isSymbolicLink()
            ? 'symlink'
            : stat.isFile()
              ? 'file'
              : 'directory',
      dev: stat.dev,
      ino: stat.ino,
    };
    releaseSave(planPath, plan); // Before moving the legacy directory, including crash recovery.
  }
  invariant(plan.installed === installed, 'WORK_OPERATION_CHANGED', 'Retain the selected owner install.');
  let current;
  try {
    current = lstatSync(plan.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const selected =
    current &&
    realpathSync(plan.path) === installed &&
    (current.isSymbolicLink() || plan.kind === 'unchanged');
  if (!selected) {
    invariant(
      !current || (current.dev === plan.dev && current.ino === plan.ino),
      'OWNER_SELECTION_CHANGED',
      'Owner install changed during release; the current install is preserved.',
    );
    if (plan.kind === 'directory') {
      if (current) renameSync(plan.path, plan.previous);
      const previous = statSync(plan.previous);
      invariant(
        previous.dev === plan.dev && previous.ino === plan.ino,
        'OWNER_SELECTION_CHANGED',
        'The retained previous owner install changed.',
      );
    } else invariant(current, 'OWNER_SELECTION_CHANGED', 'The previous owner selection disappeared.');
    const temporary = join(dirname(plan.path), `.owner-select-${randomUUID()}`);
    symlinkSync(installed, temporary);
    renameSync(temporary, plan.path);
    const fd = openSync(dirname(plan.path), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  // A command the operator can execute without rewriting any package bytes.
  const temporary = `${plan.path}.rollback-${randomUUID()}`;
  const rollbackScript = `const fs=require('node:fs');if(fs.realpathSync(${JSON.stringify(plan.path)})!==${JSON.stringify(installed)})throw Error('Owner selection changed');fs.symlinkSync(${JSON.stringify(plan.previous)},${JSON.stringify(temporary)});fs.renameSync(${JSON.stringify(temporary)},${JSON.stringify(plan.path)});`;
  const rollbackCommand =
    plan.kind === 'unchanged' ? ':' : `${releaseQuote(process.execPath)} -e ${releaseQuote(rollbackScript)}`;
  return { selectionPath: plan.path, previousInstall: plan.previous, installed, rollbackCommand };
}
