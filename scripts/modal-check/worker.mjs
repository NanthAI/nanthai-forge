// SPDX-License-Identifier: Apache-2.0
// Installed controller helper, outside the candidate snapshot. Streams selected
// outputs after the command without loading whole artifacts into controller memory.
import { spawn } from 'node:child_process';
import { openSync, closeSync, fstatSync, lstatSync, realpathSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const started = performance.now();
const plan = JSON.parse(process.env.FORGE_MODAL_COMMAND);
delete process.env.FORGE_MODAL_COMMAND;
const child = spawn(plan.command[0], plan.command.slice(1), { stdio: 'inherit' });
const code = await new Promise(resolve => {
  child.once('error', () => resolve(1));
  child.once('close', (code, signal) => resolve(signal === 'SIGKILL' ? 137 : (code ?? 1)));
});
const emit = value => process.stdout.write(`__FORGE_ARTIFACT__${JSON.stringify(value)}\n`);
for (const [index, sourcePath] of (code === 137 ? [] : plan.artifacts).entries()) {
  let fd;
  try {
    if (
      !sourcePath ||
      sourcePath.includes('\\') ||
      sourcePath.split('/').some(part => !part || ['.', '..', '.git'].includes(part))
    )
      throw Error();
    let path = realpathSync(process.cwd());
    for (const part of sourcePath.split('/')) {
      path = join(path, part);
      if (lstatSync(path).isSymbolicLink()) throw Error();
    }
    if (resolve(path) !== realpathSync(path)) throw Error();
    fd = openSync(path, 'r');
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw Error();
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(48 * 1024);
    let offset = 0,
      size;
    while ((size = readSync(fd, bytes, 0, bytes.length, null))) {
      const chunk = bytes.subarray(0, size);
      hash.update(chunk);
      emit({ kind: 'artifactChunk', index, sourcePath, offset, base64: chunk.toString('base64') });
      offset += size;
    }
    const after = fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      realpathSync(path) !== path
    )
      throw Error();
    emit({ kind: 'artifactEnd', index, sourcePath, size: offset, sha256: hash.digest('hex') });
  } catch {
    emit({ kind: 'artifactUnavailable', index, sourcePath });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
process.stdout.write(`__FORGE_USAGE__${JSON.stringify({ seconds: (performance.now() - started) / 1000 })}\n`);
process.exitCode = code;
