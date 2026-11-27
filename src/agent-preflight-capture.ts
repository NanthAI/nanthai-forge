// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { measuredPrefix, parsePeakRssMb, spawnMeasured } from './agent-preflight-measure.js';

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
/** Runs "$@" as a child in the wrapper's own process group, forwards a termination signal to it, and
 * writes its exit status to "$0" (renamed into place, so a reader never sees half a number). A
 * watchdog kills the whole group once the preflight process (OWNER) is gone, whatever ended it: a
 * budget stop, an error, a signal or SIGKILL, so no test or typecheck outlives its preflight, and
 * removes the capture folder nobody is left to read
 * (Item 168e4ed8: orphaned typechecks ran 18 min outside heavy). */
const wrapper = (owner: number) =>
  [
    // The helpers below run from the system folders: a command's own PATH may hold none of them.
    `u=/usr/bin:/bin`,
    `trap 'kill "$p" 2>/dev/null' TERM INT HUP`,
    `"$@" &`,
    `p=$!`,
    // The watchdog: kill this shell (it cannot stop the watchdog or write a status any more), remove
    // the capture folder ("$0"'s, nobody is left to read it; the command's open output survives the
    // unlink), then kill the rest of the group, the command included.
    `(while kill -0 ${owner} 2>/dev/null; do PATH=$u sleep 1; done; kill -KILL $$; d=\${0%/*}; PATH=$u rm -f -- "$0" "$0.tmp" "$d/stderr.txt" "$d/time.txt"; PATH=$u rmdir -- "$d"; kill -KILL 0) </dev/null >/dev/null 2>&1 &`,
    `w=$!`,
    `wait "$p"; s=$?`,
    `if kill -0 "$p" 2>/dev/null; then wait "$p"; s=$?; fi`,
    `kill "$w" 2>/dev/null`,
    `{ echo "$s" >"$0.tmp" && PATH=$u mv -f "$0.tmp" "$0"; } || echo "$s" >"$0"`,
  ].join('\n');

const spawnedCode = (error: unknown) =>
  error && typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code!
    : null;
/** How often a wait with no status yet checks that its wrapper still runs. */
const LIVENESS_MS = 10_000;
/** The wrapper (group leader) still runs: neither gone nor a zombie this blocked loop cannot reap. */
function wrapperRunning(pid: number) {
  const state = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (state.error || state.status === null) return true;
  const text = state.stdout.trim();
  return text !== '' && !text.startsWith('Z');
}
/** The exit status the wrapper recorded, or null while it has recorded none. */
function readStatus(file: string) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}
/** Signal every process left in a group this preflight started; a group already gone is fine. */
function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* No process is left in the group. */
  }
}

/** Runs the command with its output going to the file DRAIN reads, calling DRAIN every few milliseconds
 * while it runs, so a long check prints as it goes (the run stays synchronous: no event loop turns).
 * The program is started by a small shell wrapper, in its own process group, that records its exit
 * status, which a synchronous caller can read without the event loop. A timeout signals the whole
 * group and, if it will not stop, kills it; when the program ends, whatever it left running in its
 * group is killed too. Where that shell does not exist (Windows) it is a plain synchronous run.
 * `measure` names a file /usr/bin/time writes the peak resident set to (see spawnMeasured). */
function spawnStreaming(
  command: string,
  args: string[],
  options: SpawnSyncOptions,
  directory: string,
  drain: () => void,
  measure = false,
) {
  const plain = () => {
    const child = measure ? spawnMeasured(command, args, options) : spawnSync(command, args, options);
    return {
      status: child.status,
      peakRssMb: ('peakRssMb' in child ? child.peakRssMb : null) as number | null,
      errorCode: 'errorCode' in child ? child.errorCode : spawnedCode(child.error),
    };
  };
  if (process.platform === 'win32') return plain();
  const statusFile = join(directory, 'status');
  const timeFile = join(directory, 'time.txt');
  const timed = measure ? measuredPrefix(timeFile) : null;
  const argv = timed ? [...timed, command, ...args] : [command, ...args];
  // The timeout is this loop's: a timer on a blocked event loop would never fire.
  const child = spawn('/bin/sh', ['-c', wrapper(process.pid), statusFile, ...argv], {
    ...options,
    timeout: undefined,
    detached: true,
  } as SpawnOptions);
  // A spawn failure arrives as an event, after this synchronous run; it must never throw there.
  child.on('error', () => undefined);
  child.unref();
  // No process started (for example the directory is missing): the plain run reports why.
  if (child.pid === undefined) return plain();
  const pgid = child.pid;
  const timeout = typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : undefined;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const started = Date.now();
  let signalled = 0;
  let checked = started;
  let gone = false;
  let status: number | null = null;
  try {
    for (;;) {
      drain();
      status = readStatus(statusFile);
      if (status !== null) break;
      const now = Date.now();
      // No status and no wrapper (killed from outside): stop waiting instead of holding the slot.
      if (now - checked > LIVENESS_MS) {
        checked = now;
        if (!wrapperRunning(pgid)) {
          // The wrapper writes its status and then exits: one that ended since the read above is not gone.
          status = readStatus(statusFile);
          if (status !== null) break;
          gone = true;
          break;
        }
      }
      if (timeout && !signalled && now - started > timeout) {
        // A command that finished while this loop was away is not timed out.
        status = readStatus(statusFile);
        if (status !== null) break;
        signalled = now;
        signalGroup(pgid, 'SIGTERM');
      } else if (signalled && now - signalled > KILL_AFTER_MS) break;
      Atomics.wait(sleeper, 0, 0, POLL_MS);
    }
  } finally {
    // Nothing this command started outlives it: leftover servers, watchers or a stopped typecheck.
    signalGroup(pgid, 'SIGKILL');
  }
  let peakRssMb: number | null = null;
  if (timed)
    try {
      peakRssMb = parsePeakRssMb(readFileSync(timeFile, 'utf8'));
    } catch {
      /* A killed run leaves no report. */
    }
  return {
    status: signalled || gone ? null : status,
    peakRssMb,
    errorCode: signalled ? 'ETIMEDOUT' : gone ? 'ESRCH' : null,
  };
}

/** spawnMeasured (or, when `measure` is false, a run that prints while it runs) with the child's output
 * (stdout and stderr, which preflight sent to our stderr) copied through to ours (not held in memory; for a
 * measured run once it ends) and its last TAIL_BYTES returned, so a failed run can say why it failed.
 * `stream.echo: false` keeps a comparison run's output off our stderr; `stream.onText` sees the whole
 * output as text, chunk by chunk (never held whole), so a caller can scan it past the kept tail.
 * `echoAfter` lets a caller decide after scanning, then relays the same disk capture in chunks. */
export function spawnCaptured(
  command: string,
  args: string[],
  options: SpawnSyncOptions,
  measure = true,
  stream: {
    echo?: boolean;
    onText?: (text: string) => void;
    echoAfter?: (run: ReturnType<typeof spawnStreaming>) => boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-preflight-err-'));
  const file = join(directory, 'stderr.txt');
  const fd = openSync(file, 'w', 0o600);
  try {
    const capturedOptions: SpawnSyncOptions = { ...options, stdio: ['ignore', fd, fd] };
    const reader = openSync(file, 'r');
    let tail = Buffer.alloc(0);
    let truncated = false;
    const decoder = stream.onText ? new StringDecoder('utf8') : undefined;
    const chunk = Buffer.alloc(64 * 1024);
    const echo = (read: number) => {
      try {
        writeSync(2, chunk, 0, read);
      } catch {
        /* A closed stderr never fails the run. */
      }
    };
    /** Copies whatever the child has written since the last call to our stderr, the scanner and the tail. */
    const drain = () => {
      for (;;) {
        const read = readSync(reader, chunk, 0, chunk.length, null);
        if (!read) break;
        if (stream.echo !== false && !stream.echoAfter) echo(read);
        if (decoder) stream.onText!(decoder.write(chunk.subarray(0, read)));
        tail = Buffer.concat([tail, chunk.subarray(0, read)]);
        if (tail.length > TAIL_BYTES * 2) {
          truncated = true;
          tail = tail.subarray(tail.length - TAIL_BYTES);
        }
      }
    };
    try {
      // Static checks need diagnostics, without an extra timing process between their timeout and program.
      // Tests are measured too, in their own process group, so a per-file timeout or the end of
      // preflight takes every process they started with them.
      const run = spawnStreaming(command, args, capturedOptions, directory, drain, measure);
      closeSync(fd);
      drain();
      if (decoder) stream.onText!(decoder.end());
      if (stream.echoAfter?.(run)) {
        for (let offset = 0; ;) {
          const read = readSync(reader, chunk, 0, chunk.length, offset);
          if (!read) break;
          echo(read);
          offset += read;
        }
      }
      return {
        ...run,
        tail: tail.subarray(Math.max(0, tail.length - TAIL_BYTES)).toString('utf8'),
        truncated: truncated || tail.length > TAIL_BYTES,
      };
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
