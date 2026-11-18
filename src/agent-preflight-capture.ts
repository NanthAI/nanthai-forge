// SPDX-License-Identifier: Apache-2.0
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
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

/** spawnMeasured with the child's output (stdout and stderr, which preflight sent to our stderr) copied
 * through to ours as before (not held in memory) and its last TAIL_BYTES returned, so a failed run can say why it failed.
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
    const run = measure
      ? spawnMeasured(command, args, capturedOptions)
      : (() => {
          // Static checks need diagnostics, not an extra timing process between their timeout and program.
          const child = spawnSync(command, args, capturedOptions);
          return {
            status: child.status,
            peakRssMb: null,
            errorCode: (child.error as NodeJS.ErrnoException | undefined)?.code ?? null,
          };
        })();
    closeSync(fd);
    const reader = openSync(file, 'r');
    let tail = Buffer.alloc(0);
    const decoder = stream.onText ? new StringDecoder('utf8') : undefined;
    try {
      const chunk = Buffer.alloc(64 * 1024);
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
      if (decoder) stream.onText!(decoder.end());
    } finally {
      closeSync(reader);
    }
    return { ...run, tail: tail.subarray(Math.max(0, tail.length - TAIL_BYTES)).toString('utf8') };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* Already closed. */
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
