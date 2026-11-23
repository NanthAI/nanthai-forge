// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { createHash, randomBytes } from 'node:crypto';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '../src/errors';

export async function openImportScratch() {
  const path = join(tmpdir(), `forge-github-import-${randomBytes(16).toString('hex')}`);
  const file = await open(path, 'wx+', 0o600);
  // POSIX reclaims the file even if the executor stops without unwinding.
  const linked = await unlink(path).then(
    () => false,
    () => true,
  );
  return {
    file,
    async close() {
      try {
        await file.close();
      } finally {
        if (linked) await unlink(path);
      }
    },
  };
}

export async function readImportRange(file: FileHandle, bytes: Buffer, start: number) {
  for (let at = 0; at < bytes.length;) {
    const { bytesRead } = await file.read(bytes, at, bytes.length - at, start + at);
    if (!bytesRead) return false;
    at += bytesRead;
  }
  return true;
}

export async function writeImportRange(file: FileHandle, bytes: Uint8Array, start: number) {
  for (let at = 0; at < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, at, bytes.length - at, start + at);
    if (!bytesWritten) throw new Error('Failed to write import scratch.');
    at += bytesWritten;
  }
}

/** Length and checksum verification stay inside the body's request deadline. */
export async function readImportBody(
  response: Response,
  pin: { size: number; sha256: string },
  progressed: () => void,
  consume: (bytes: Uint8Array, offset: number) => void | false | Promise<void | false>,
) {
  if (!response.ok || !response.body) return false;
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== pin.size) return false;
  const hash = createHash('sha256');
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > pin.size - offset) return false;
      if ((await consume(chunk.value, offset)) === false) return false;
      hash.update(chunk.value);
      offset += chunk.value.byteLength;
      progressed();
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return offset === pin.size && hash.digest('hex') === pin.sha256;
}

export function requireImportRange(file: FileHandle, bytes: Buffer, start: number) {
  return readImportRange(file, bytes, start).then(read => {
    invariant(read, 'INVALID_WORK_BACKUP', 'The stored import bytes could not be read.');
  });
}
