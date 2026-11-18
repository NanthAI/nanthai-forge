// SPDX-License-Identifier: Apache-2.0
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawnMeasured } from './agent-preflight-measure.js';

/** Bytes of a failed run's error output kept for the receipt and the refusal. */
const TAIL_BYTES = 8 * 1024;
/** Characters of it the refusal names. */
const EXCERPT_CHARS = 600;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The part of a failed run's error output that names the cause: from the first failure marker the
 * test runners print (node's `✖`, a TypeError/Error line, `FAIL`, `panic`), else the end. */
export function failureExcerpt(tail: string) {
  const text = tail.replace(ANSI, '').trim();
  const at = text.search(/✖|\b\w*Error\b|\bFAIL\b|\bpanic\b|\bFAILED\b/);
  const from = at >= 0 ? text.slice(at) : text;
  const flat = from
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .join(' | ');
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

/** How long a timed-out command gets to stop on SIGTERM before it is killed outright. */
const KILL_AFTER_MS = 5_000;
const POLL_MS = 10;
/** Runs "$@" as a child, forwards a termination signal to it, and writes its exit status to "$0"
 * (renamed into place, so a reader never sees half a number). */
const WRAPPER = [
  `trap 'kill "$p" 2>/dev/null' TERM INT HUP`,
  `"$@" &`,
  `p=$!`,
  `wait "$p"; s=$?`,
  `if kill -0 "$p" 2>/dev/null; then wait "$p"; s=$?; fi`,
  `echo "$s" >"$0.tmp" && mv "$0.tmp" "$0"`,
].join('\n');

const spawnedCode = (error: unknown) =>
  error && typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code!
    : null;

/** Runs the command with its output going to the file DRAIN reads, calling DRAIN every few milliseconds
 * while it runs, so a long check prints as it goes (the run stays synchronous: no event loop turns).
 * The program is started by a small shell wrapper that records its exit status, which a synchronous
 * caller can read without the event loop; a timeout signals the program and, if it will not stop,
 * the wrapper. Where that shell does not exist (Windows) it is a plain synchronous run. */
function spawnStreaming(
  command: string,
  args: string[],
  options: SpawnSyncOptions,
  directory: string,
  drain: () => void,
) {
  const plain = () => {
    const child = spawnSync(command, args, options);
    return { status: child.status, peakRssMb: null as number | null, errorCode: spawnedCode(child.error) };
  };
  if (process.platform === 'win32') return plain();
  const statusFile = join(directory, 'status');
  // The timeout is this loop's: a timer on a blocked event loop would never fire.
  const child = spawn('/bin/sh', ['-c', WRAPPER, statusFile, command, ...args], {
    ...options,
    timeout: undefined,
  } as SpawnOptions);
  // A spawn failure arrives as an event, after this synchronous run; it must never throw there.
  child.on('error', () => undefined);
  child.unref();
  // No process started (for example the directory is missing): the plain run reports why.
  if (child.pid === undefined) return plain();
  const timeout = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : undefined;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const started = Date.now();
  let signalled = 0;
  let status: number | null = null;
  for (;;) {
    drain();
    try {
      const text = readFileSync(statusFile, 'utf8').trim();
      if (/^\d+$/.test(text)) {
        status = Number(text);
        break;
      }
    } catch {
      /* Still running. */
    }
    const now = Date.now();
    if (timeout && !signalled && now - started > timeout) {
      signalled = now;
      child.kill('SIGTERM');
    } else if (signalled && now - signalled > KILL_AFTER_MS) {
      child.kill('SIGKILL');
      break;
    }
    Atomics.wait(sleeper, 0, 0, POLL_MS);
  }
  return {
    status: signalled ? null : status,
    peakRssMb: null as number | null,
    errorCode: signalled ? 'ETIMEDOUT' : null,
  };
}

/** spawnMeasured (or, when `measure` is false, a run that prints while it runs) with the child's output
 * (stdout and stderr, which preflight sent to our stderr) copied through to ours (not held in memory; for a
 * measured run once it ends) and its last TAIL_BYTES returned, so a failed run can say why it failed.
 * `stream.echo: false` keeps a comparison run's output off our stderr; `stream.onText` sees the whole
 * output as text, chunk by chunk (never held whole), so a caller can scan it past the kept tail. */
export function spawnCaptured(
  command: string,
  args: string[],
  options: SpawnSyncOptions,
  measure = true,
  stream: { echo?: boolean; onText?: (text: string) => void } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-preflight-err-'));
  const file = join(directory, 'stderr.txt');
  const fd = openSync(file, 'w', 0o600);
  try {
    const capturedOptions: SpawnSyncOptions = { ...options, stdio: ['ignore', fd, fd] };
    const reader = openSync(file, 'r');
    let tail = Buffer.alloc(0);
    const decoder = stream.onText ? new StringDecoder('utf8') : undefined;
    const chunk = Buffer.alloc(64 * 1024);
    /** Copies whatever the child has written since the last call to our stderr, the scanner and the tail. */
    const drain = () => {
      for (;;) {
        const read = readSync(reader, chunk, 0, chunk.length, null);
        if (!read) break;
        if (stream.echo !== false)
          try {
            writeSync(2, chunk, 0, read);
          } catch {
            /* A closed stderr never fails the run. */
          }
        if (decoder) stream.onText!(decoder.write(chunk.subarray(0, read)));
        tail = Buffer.concat([tail, chunk.subarray(0, read)]);
        if (tail.length > TAIL_BYTES * 2) tail = tail.subarray(tail.length - TAIL_BYTES);
      }
    };
    try {
      // Static checks need diagnostics, not an extra timing process between their timeout and program,
      // and they print while they run (the Convex guard takes seconds): only tests are measured.
      const run = measure
        ? spawnMeasured(command, args, capturedOptions)
        : spawnStreaming(command, args, capturedOptions, directory, drain);
      closeSync(fd);
      drain();
      if (decoder) stream.onText!(decoder.end());
      return { ...run, tail: tail.subarray(Math.max(0, tail.length - TAIL_BYTES)).toString('utf8') };
    } finally {
      closeSync(reader);
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* Already closed. */
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
