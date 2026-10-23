// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { readSource } from './files.js';
import { invariant } from './errors.js';

/** One operation owns these buffers and byte-only templates. Every workspace is
 * complete and independently writable. Cloning is optional and never reads
 * metadata from retained objects into a workspace. */
export class NativeWorkspaceFiles {
  private directory: string | undefined;
  private readonly prepared = new Map<string, string>();
  private readonly small = new Map<string, Buffer>();
  private retainedBytes = 0;
  private cloning: boolean | undefined;
  constructor(
    private readonly objects: string,
    private readonly read: (id: string) => Buffer,
    private readonly reuse = false,
  ) {}

  prepare(id: string) {
    if (this.prepared.has(id) || this.small.has(id)) return;
    const bytes = this.read(id);
    if (!this.reuse || this.cloning === false || bytes.length < 8 * 1024 * 1024) {
      // Recovery's reader already owns a bounded byte memo. Ordinary Lane/check
      // creation reuses its just-validated bytes without a second disk read.
      if (!this.reuse && this.retainedBytes + bytes.length <= 32 * 1024 * 1024) {
        this.small.set(id, bytes);
        this.retainedBytes += bytes.length;
      }
      return;
    }
    this.directory ??= mkdtempSync(join(dirname(this.objects), '.materialization-'));
    const path = join(this.directory, id);
    // Fresh bytes preserve the original materialization contract: no source
    // quarantine, ACL or immutable flags are copied into these private files.
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    if (this.cloning === undefined) {
      const probe = join(this.directory, 'clone-probe');
      this.cloning = cloneFile(path, probe, true);
      if (!this.cloning) {
        rmSync(path);
        return;
      }
      const cloned = readSource(this.directory, 'clone-probe', bytes.length, id);
      invariant(
        cloned && cloned.equals(bytes),
        'INVALID_NATIVE_SOURCE',
        'Workspace template copy differs from validated source; original work is retained.',
      );
      rmSync(probe);
    }
    this.prepared.set(id, path);
  }

  write(id: string, path: string, kind: 'file' | 'executable' | 'symlink') {
    if (kind === 'symlink') {
      symlinkSync(this.small.get(id) ?? this.read(id), path);
      return;
    }
    const template = this.prepared.get(id),
      mode = kind === 'executable' ? 0o700 : 0o600;
    if (template) {
      cloneFile(template, path, false);
      chmodSync(path, mode);
    } else writeFileSync(path, this.small.get(id) ?? this.read(id), { flag: 'wx', mode });
  }

  dispose() {
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.prepared.clear();
    this.small.clear();
    this.retainedBytes = 0;
  }
}

function cloneFile(source: string, destination: string, requireClone: boolean): boolean {
  if (process.platform === 'darwin') {
    // Node/libuv does not expose clonefile on macOS (FORCE reports ENOSYS).
    // The system utility accepts only our byte-only private templates. Absolute
    // arguments and no shell keep source text inert; failure uses normal copying.
    const temporary = mkdtempSync(join(dirname(destination), '.clone-'));
    try {
      const path = join(temporary, 'file');
      let copied = false;
      try {
        execFileSync('/bin/cp', ['-c', source, path], { stdio: 'pipe' });
        copied = true;
      } catch {
        if (requireClone) return false;
      }
      if (copied) {
        // Publication errors (especially EEXIST) are not clone availability.
        closeSync(openSync(destination, 'wx', 0o600));
        renameSync(path, destination);
        return true;
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  try {
    copyFileSync(
      source,
      destination,
      constants.COPYFILE_EXCL |
        (requireClone ? constants.COPYFILE_FICLONE_FORCE : constants.COPYFILE_FICLONE),
    );
    return true;
  } catch (error) {
    if (
      requireClone &&
      ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      return false;
    throw error;
  }
}
