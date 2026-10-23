// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommand, gitFailure, gitTimeout } from './work-git-command.js';

/** One ordered request at a time; idle workers hold no timeout or pending request. */
export function nativeGitBatch(root: string, args: string[], activity: (pid?: number) => void) {
  const command = gitCommand(root, args),
    child = spawn('git', command.args, {
      env: command.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  let pending: { resolve: (id: string) => void; reject: (error: unknown) => void } | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    timedOut = false,
    failure: NodeJS.ErrnoException | undefined,
    closed = false,
    stderrBytes = 0,
    stdoutBytes = 0;
  const stderr: Buffer[] = [];
  const kill = () => {
    try {
      if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
    }
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, gitTimeout());
  };
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', error => {
      failure = error;
    });
    child.on('close', (status, signal) => {
      closed = true;
      clearTimeout(timer);
      const request = pending;
      pending = undefined;
      activity();
      if (failure || timedOut || status !== 0 || request) {
        const error = gitFailure(
          { status, signal, code: timedOut ? 'ETIMEDOUT' : failure?.code, stderr: Buffer.concat(stderr) },
          args,
          timedOut,
        );
        request?.reject(error);
        reject(error);
      } else resolve();
    });
  });
  // A worker can exit between requests. Retain the failure for request()/finish().
  void done.catch(() => {});
  child.stderr.on('data', (bytes: Buffer) => {
    stderrBytes += bytes.length;
    if (stderrBytes <= 4 * 1024 * 1024) stderr.push(bytes);
    else {
      failure = Object.assign(new Error('Git stderr exceeded buffer'), { code: 'ENOBUFS' });
      kill();
    }
  });
  child.stdin.on('error', () => {
    // close carries the process status and redacted diagnostic.
  });
  child.stdout.on('data', (bytes: Buffer) => {
    stdoutBytes += bytes.length;
    if (stdoutBytes > 4 * 1024 * 1024) {
      failure = Object.assign(new Error('Git stdout exceeded buffer'), { code: 'ENOBUFS' });
      kill();
    }
  });
  createInterface({ input: child.stdout }).on('line', line => {
    if (!pending || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line)) {
      failure = Object.assign(new Error('Invalid Git batch response'), { code: 'EPROTO' });
      kill();
      return;
    }
    clearTimeout(timer);
    const request = pending;
    pending = undefined;
    activity();
    request.resolve(line);
  });
  return {
    async request(bytes: Buffer | string): Promise<string> {
      if (closed || failure || timedOut) {
        await done;
        throw gitFailure({ code: 'EPIPE' }, args);
      }
      if (pending) throw new Error('Concurrent Git batch requests');
      stdoutBytes = 0;
      activity(child.pid);
      arm();
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        child.stdin.write(bytes);
      });
    },
    async finish() {
      if (!closed) {
        arm();
        child.stdin.end();
      }
      await done;
    },
    async abort() {
      if (!closed) kill();
      await done.catch(() => {});
    },
  };
}

/** Hash-object's path protocol keeps arbitrary binary bytes out of its control stream. */
export function batchObjectWriter(
  scratch: string,
  batch: (args: string[]) => ReturnType<typeof nativeGitBatch>,
) {
  const path = join(scratch, 'object-input');
  // Git's C quoting accepts octal bytes, including paths with tabs/newlines/non-ASCII.
  const quoted =
    '"' + [...Buffer.from(path)].map(byte => '\\' + byte.toString(8).padStart(3, '0')).join('') + '"\n';
  const workers = new Map<string, ReturnType<typeof nativeGitBatch>>();
  return async (kind: 'blob' | 'commit', bytes: Buffer) => {
    let worker = workers.get(kind);
    if (!worker) {
      // New blobs must be loose: the persistent mktree process cannot discover
      // packs written after its first request. --literally does not prevent
      // packing on Git 2.52. Cover every Buffer length in this worker only.
      worker = batch([
        ...(kind === 'blob' ? ['-c', `core.bigFileThreshold=${Number.MAX_SAFE_INTEGER}`] : []),
        'hash-object',
        '-t',
        kind,
        '-w',
        '--stdin-paths',
        '--no-filters',
      ]);
      workers.set(kind, worker);
    }
    writeFileSync(path, bytes, { mode: 0o600 });
    return worker.request(quoted);
  };
}
