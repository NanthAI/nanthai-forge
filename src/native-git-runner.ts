// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { gitCommand, gitFailure, gitPhase, gitTimeout } from './work-git-command.js';

/** One lock-free export session. Keep stderr progress alive during Git subprocess waits. */
export function nativeGitRunner() {
  const began = Date.now();
  let phase = 'reading immutable States',
    pid: number | undefined,
    commandBegan = began,
    commands = 0;
  const progress = setInterval(() => {
    process.stderr.write(
      `export-native-git: ${phase}; holder=git pid=${pid ?? 'none'}; commandWait=${Math.floor((Date.now() - commandBegan) / 1000)}s; commands=${commands}; elapsed=${Math.floor((Date.now() - began) / 1000)}s\n`,
    );
  }, 10_000);
  return {
    close: () => clearInterval(progress),
    git(root: string, args: string[], input?: string | Buffer): Promise<string> {
      phase = `waiting for Git ${gitPhase(args)}`;
      commandBegan = Date.now();
      commands++;
      const command = gitCommand(root, args),
        timeout = gitTimeout();
      return new Promise((resolve, reject) => {
        let timedOut = false,
          failure: NodeJS.ErrnoException | undefined;
        const stdout: Buffer[] = [],
          stderr: Buffer[] = [];
        let stdoutBytes = 0,
          stderrBytes = 0;
        const child = spawn('git', command.args, {
          env: command.env,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const kill = () => {
          // Helpers inherit Git's output pipes: kill the disposable group as well.
          try {
            if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
          }
        };
        pid = child.pid;
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeout);
        child.stdout.on('data', (bytes: Buffer) => {
          stdoutBytes += bytes.length;
          if (stdoutBytes <= 4 * 1024 * 1024) stdout.push(bytes);
          else {
            failure = Object.assign(new Error('Git stdout exceeded buffer'), { code: 'ENOBUFS' });
            kill();
          }
        });
        child.stderr.on('data', (bytes: Buffer) => {
          stderrBytes += bytes.length;
          if (stderrBytes <= 4 * 1024 * 1024) stderr.push(bytes);
          else {
            failure = Object.assign(new Error('Git stderr exceeded buffer'), { code: 'ENOBUFS' });
            kill();
          }
        });
        child.on('error', error => {
          failure = error;
        });
        child.on('close', (status, signal) => {
          clearTimeout(timer);
          pid = undefined;
          phase = 'projecting immutable States';
          if (failure || timedOut || status !== 0)
            reject(
              gitFailure(
                {
                  status,
                  code: timedOut ? 'ETIMEDOUT' : failure?.code,
                  signal,
                  stderr: Buffer.concat(stderr),
                },
                args,
                timedOut,
              ),
            );
          else resolve(Buffer.concat(stdout).toString('utf8'));
        });
        child.stdin?.on('error', () => {
          /* The completion callback reports Git failure. */
        });
        child.stdin?.end(input);
      });
    },
  };
}
