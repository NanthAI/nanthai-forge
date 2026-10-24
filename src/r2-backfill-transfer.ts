// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BackfillPin, BackfillTarget } from './r2-backfill-types.js';
import { invariant, ForgeError } from './errors.js';
import { syncDirectory } from './native-durability.js';

async function verifyFile(path: string, pin: BackfillPin) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return size === pin.size && hash.digest('hex') === pin.digest;
}
/** Download once to a durable private spool; no object is held in memory. */
export async function spoolBackfill(url: string, path: string, pin: BackfillPin) {
  if (existsSync(path) && (await verifyFile(path, pin))) return;
  const temp = path + '.partial';
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'error', headers: { 'accept-encoding': 'identity' } });
  } catch {
    throw new ForgeError(
      'BACKFILL_DOWNLOAD_FAILED',
      'Backfill source transfer failed. Resume the same operation.',
    );
  }
  invariant(
    response.ok && response.body,
    'BACKFILL_DOWNLOAD_FAILED',
    'Backfill source download failed. Resume the same operation.',
  );
  const hash = createHash('sha256');
  let size = 0;
  try {
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        size += chunk.length;
        if (size > pin.size)
          return next(new ForgeError('BLOB_DIGEST_MISMATCH', 'Backfill source exceeds its declared size.'));
        hash.update(chunk);
        next(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      meter,
      createWriteStream(temp, { mode: 0o600 }),
    );
    invariant(
      size === pin.size && hash.digest('hex') === pin.digest,
      'BLOB_DIGEST_MISMATCH',
      'Backfill source differs from its digest; the row was not flipped.',
    );
    const file = await open(temp, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    renameSync(temp, path);
    syncDirectory(path.substring(0, path.lastIndexOf('/')));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error instanceof ForgeError
      ? error
      : new ForgeError(
          'BACKFILL_DOWNLOAD_FAILED',
          'Backfill source transfer failed. Resume the same operation.',
        );
  }
}
/** Every retry opens a new stream. The signed length, checksum and create-only condition are retained. */
export async function putBackfill(target: BackfillTarget['target'], path: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = createReadStream(path);
    let response: Response;
    try {
      response = await fetch(target.url, {
        method: 'PUT',
        headers: target.headers,
        body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
        duplex: 'half',
        redirect: 'error',
      } as RequestInit & { duplex: string });
    } catch {
      if (attempt === 3)
        throw new ForgeError(
          'BACKFILL_UPLOAD_UNKNOWN',
          'Backfill upload outcome is unknown. Resume the same operation.',
        );
      continue;
    } finally {
      body.destroy();
    }
    await response.body?.cancel();
    if (response.ok || response.status === 412) return;
    if (!(response.status === 429 || response.status >= 500) || attempt === 3)
      throw new ForgeError(
        'BACKFILL_UPLOAD_UNKNOWN',
        `Backfill upload returned HTTP ${response.status}. Resume the same operation.`,
      );
    await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
  }
}
/** The verification sample also streams, with bounded memory. */
export async function sampleBackfill(url: string, pin: BackfillPin) {
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'error', headers: { 'accept-encoding': 'identity' } });
  } catch {
    throw new ForgeError('R2_VERIFY_FAILED', 'R2 verification sample transfer failed.');
  }
  invariant(response.ok && response.body, 'R2_VERIFY_FAILED', 'R2 verification sample is unavailable.');
  const hash = createHash('sha256');
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      hash.update(part.value);
      invariant(size <= pin.size, 'BLOB_DIGEST_MISMATCH', 'R2 sample exceeds its declared size.');
    }
    invariant(
      size === pin.size && hash.digest('hex') === pin.digest,
      'BLOB_DIGEST_MISMATCH',
      'R2 sample differs from its digest.',
    );
  } catch (error) {
    throw error instanceof ForgeError
      ? error
      : new ForgeError('R2_VERIFY_FAILED', 'R2 verification sample transfer failed.');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
