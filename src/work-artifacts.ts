// SPDX-License-Identifier: Apache-2.0
import {
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  openSync,
  closeSync,
  lstatSync,
  realpathSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { safeRelative, fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import type { CheckRun } from './work-types.js';

export async function captureArtifacts(workspace: string, directory: string, paths: string[]) {
  const artifacts: NonNullable<CheckRun['artifacts']> = [];
  if (!paths.length) return artifacts;
  mkdirSync(join(directory, 'artifacts'), { mode: 0o700 });
  for (const [index, sourcePath] of paths.entries()) {
    let input: number | undefined, output: number | undefined;
    try {
      invariant(
        safeRelative(sourcePath) && !sourcePath.toLowerCase().split('/').includes('.git'),
        'UNSAFE_PATH',
        'Select a contained build-output file.',
      );
      let path = workspace;
      for (const part of sourcePath.split('/')) {
        path = join(path, part);
        invariant(
          !lstatSync(path).isSymbolicLink(),
          'UNSAFE_PATH',
          'Build-output symlinks are not captured.',
        );
      }
      invariant(realpathSync(path) === path, 'UNSAFE_PATH', 'Build-output path changed.');
      input = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const before = fstatSync(input);
      invariant(
        before.isFile() && before.nlink === 1,
        'UNSAFE_PATH',
        'Select an ordinary build-output file with one hard link.',
      );
      const filename = `artifact-${index}.bin`,
        destination = join(directory, 'artifacts', filename),
        hash = createHash('sha256');
      output = openSync(destination, 'wx', 0o600);
      await pipeline(
        createReadStream(path, { fd: input, autoClose: false }),
        new Transform({
          transform(bytes, _encoding, done) {
            hash.update(bytes);
            done(null, bytes);
          },
        }),
        createWriteStream(destination, { fd: output, autoClose: false }),
      );
      const after = fstatSync(input),
        copied = fstatSync(output);
      invariant(
        before.size === after.size &&
          before.size === copied.size &&
          before.mtimeMs === after.mtimeMs &&
          before.ctimeMs === after.ctimeMs &&
          realpathSync(path) === path,
        'ARTIFACT_CHANGED',
        'Build-output bytes changed during capture.',
      );
      artifacts.push({
        status: 'retained',
        sourcePath,
        filename,
        size: copied.size,
        sha256: hash.digest('hex'),
      });
    } catch {
      artifacts.push({
        status: 'unavailable',
        sourcePath,
        details:
          'Selected output could not be captured safely. Any workspace/partial bytes are retained; the command is not repeated.',
      });
    } finally {
      if (input !== undefined) closeSync(input);
      if (output !== undefined) closeSync(output);
    }
  }
  return artifacts;
}

export async function inspectArtifacts(directory: string, run: CheckRun) {
  return Promise.all(
    (run.artifacts ?? [])
      .filter(item => item.status === 'retained')
      .map(async item => {
        const folder = join(directory, 'artifacts');
        invariant(
          lstatSync(folder).isDirectory() &&
            !lstatSync(folder).isSymbolicLink() &&
            realpathSync(folder) === folder,
          'ARTIFACT_CHANGED',
          'Retained build-output directory changed. Original source and metadata remain available.',
        );
        const path = join(folder, item.filename),
          observed = await fingerprintPrivateFile(path, 'ARTIFACT_CHANGED');
        invariant(
          observed.sha256 === item.sha256 && observed.size === item.size,
          'ARTIFACT_CHANGED',
          'Retained build-output bytes differ from the original run.',
        );
        return { ...item, path, exportFilename: `check-${run.id}-${item.filename}` };
      }),
  );
}
