// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeError } from './errors.js';

export async function streamGit(
  directory: string,
  endpoint: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  hooksPath = '/dev/null',
) {
  const advertisement = endpoint === 'info/refs',
    receive = url.search === '?service=git-receive-pack' || endpoint === 'git-receive-pack';
  const service = receive ? 'git-receive-pack' : 'git-upload-pack';
  const env = {
    ...childEnv(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PROJECT_ROOT: directory,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/source.git/${endpoint}`,
    REQUEST_METHOD: request.method!,
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: request.headers['content-type'] ?? '',
    CONTENT_LENGTH: request.headers['content-length'] ?? '',
    ...(typeof request.headers['git-protocol'] === 'string'
      ? { GIT_PROTOCOL: request.headers['git-protocol'] }
      : {}),
    ...(typeof request.headers['content-encoding'] === 'string'
      ? { HTTP_CONTENT_ENCODING: request.headers['content-encoding'] }
      : {}),
  };
  const child = spawn(
    'git',
    [
      '--no-replace-objects',
      '-c',
      `core.hooksPath=${hooksPath}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      `http.receivepack=${receive}`,
      '-c',
      'http.getanyfile=false',
      'http-backend',
    ],
    {
      cwd: directory,
      env,
      detached: receive && process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
    },
  );
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () =>
      reject(
        new ForgeError('WORK_GIT_FAILED', 'Native Git HTTP could not start. Original source is retained.'),
      ),
    );
    child.once('close', code =>
      code === 0
        ? resolve()
        : reject(
            new ForgeError(
              'WORK_GIT_FAILED',
              'Native Git HTTP did not complete. Original source is retained.',
            ),
          ),
    );
  });
  // Only native CGI headers are buffered. Git packs stream with backpressure; no source-pack size ceiling is added.
  let headers = Buffer.alloc(0),
    started = false;
  const body = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (started) {
        callback(null, chunk);
        return;
      }
      headers = Buffer.concat([headers, chunk]);
      const end = headers.indexOf('\r\n\r\n');
      if (end < 0) {
        if (headers.length > 65536)
          callback(new ForgeError('WORK_GIT_FAILED', 'Native Git returned invalid CGI headers.'));
        else callback();
        return;
      }
      const lines = headers.subarray(0, end).toString('latin1').split('\r\n'),
        type = lines
          .find(line => /^Content-Type:/i.test(line))
          ?.split(':')
          .slice(1)
          .join(':')
          .trim();
      if (type !== `application/x-${service}-${advertisement ? 'advertisement' : 'result'}`) {
        callback(new ForgeError('WORK_GIT_FAILED', 'Native Git did not return the selected Git service.'));
        return;
      }
      response.writeHead(200, { 'Content-Type': type });
      started = true;
      callback(null, headers.subarray(end + 4));
      headers = Buffer.alloc(0);
    },
    flush(callback) {
      callback(started ? null : new ForgeError('WORK_GIT_FAILED', 'Native Git returned no CGI response.'));
    },
  });
  const stop = () => {
    try {
      if (receive && child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      /* Exited native process group. */
    }
  };
  const abort = () => {
    if (!response.writableFinished) stop();
  };
  response.once('close', abort);
  request.once('aborted', abort);
  child.stdin.on('error', () => {
    /* Native exit/stream failure owns the outcome; do not print source or credentials. */
  });
  if (advertisement) child.stdin.end();
  else request.pipe(child.stdin);
  try {
    await Promise.all([pipeline(child.stdout, body, response), exited]);
  } finally {
    stop();
    request.unpipe(child.stdin);
    response.off('close', abort);
    request.off('aborted', abort);
    await exited.catch(() => {});
  }
}
