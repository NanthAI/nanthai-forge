// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { presign } from '../../dist/r2-presign.js';
import { networkFetch, networkTimeout } from '../../dist/network-fetch.js';

/** The cleanup's own page receipts list refused storage ids. That records a
 * decision, not a dependency: counting it would make every refused file
 * unclassifiable, so undeletable, on every later run. */
export const cleanupReceiptReference = r =>
  r.table === 'legacyStorageCleanupPages' && /^result#json\.excluded\.\d+\.storageId$/.test(r.field ?? '');
export const liveReferences = references => references.filter(r => !cleanupReceiptReference(r));
export function storageClass(file) {
  const references = liveReferences(file.references);
  if (!references.length) return file.matchingCopies.length ? 3 : 4;
  if (
    references.every(
      r =>
        ['projectObjects', 'projectBackups'].includes(r.table) &&
        r.field === 'storageId' &&
        r.location === 'r2' &&
        r.committed,
    )
  )
    return 1;
  if (references.every(r => r.table === 'projectSourceSteps' && r.field === 'cursor')) return 2;
  return null;
}
export function digestHex(value) {
  const hex = /^[a-f0-9]{64}$/.test(value ?? '') ? value : Buffer.from(value ?? '', 'base64').toString('hex');
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('VERIFY_DIGEST_INVALID');
  return hex;
}
/** Read both providers in bounded streams. Neither response bodies nor signed URLs enter evidence. */
export async function hashResponse(response, expectedSize, account = () => {}) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(response.status === 404 ? 'VERIFY_MISSING' : 'VERIFY_DOWNLOAD_FAILED');
  }
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    account(chunk.byteLength);
    if (size > expectedSize) throw new Error('VERIFY_SIZE_MISMATCH');
    hash.update(chunk);
  }
  if (size !== expectedSize) throw new Error('VERIFY_SIZE_MISMATCH');
  return hash.digest('hex');
}
export async function verifyFile(file, current, io) {
  const expected = digestHex(file.sha256);
  if (
    !current ||
    current._id !== file.storageId ||
    current.size !== file.bytes ||
    digestHex(current.sha256) !== expected
  )
    throw new Error('VERIFY_STORAGE_CHANGED');
  const keys = new Set([
    ...file.matchingCopies.filter(c => c.size === file.bytes).map(c => c.key),
    ...file.references.map(r => r.key).filter(Boolean),
  ]);
  if (!keys.size || [...keys].some(k => !k.startsWith('v1/') || k.split('/').at(-1) !== expected))
    throw new Error('VERIFY_R2_PIN_INVALID');
  if (
    file.references.some(
      r =>
        (r.digest && digestHex(r.digest) !== expected) ||
        (r.size !== null && r.size !== undefined && r.size !== file.bytes),
    )
  )
    throw new Error('VERIFY_REFERENCE_MISMATCH');
  // Verify each referenced destination, including aliases shared by backup and object rows.
  const hashes = [await io.hashConvex(current.url, file.bytes)];
  for (const key of keys) hashes.push(await io.hashR2(key, file.bytes));
  if (hashes.some(h => h !== expected)) throw new Error('VERIFY_DIGEST_MISMATCH');
  return {
    storageId: file.storageId,
    class: storageClass(file),
    bytes: file.bytes,
    sha256: expected,
    keys: [...keys],
    fullDigest: true,
    providers: ['convex', 'r2'],
    verifiedAt: new Date().toISOString(),
  };
}
/** Status class, HTTP status and timeout/network code only; never URLs or messages. */
function headError(code, head) {
  return Object.assign(new Error(code), { head });
}
function safeErrorCode(error) {
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  return typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown';
}
export function verificationIo(config, metrics, fetcher = networkFetch) {
  async function hash(url, size, provider) {
    metrics[provider + 'Gets']++;
    const response = await fetcher(url, {
      headers: { 'accept-encoding': 'identity' },
      redirect: 'error',
      signal: networkTimeout(120_000),
    });
    return hashResponse(response, size, bytes => {
      metrics[provider + 'Bytes'] += bytes;
    });
  }
  return {
    async headR2(key, size, digest) {
      const url = await presign({
        method: 'HEAD',
        host: `${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        path: `/${config.R2_BUCKET}/${key}`,
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      });
      metrics.r2Heads = (metrics.r2Heads ?? 0) + 1;
      let response;
      try {
        response = await fetcher(url, {
          method: 'HEAD',
          headers: { 'accept-encoding': 'identity' },
          redirect: 'error',
          signal: networkTimeout(20_000),
        });
      } catch (error) {
        throw headError('VERIFY_HEAD_UNAVAILABLE', {
          statusClass: 'none',
          timeout: error?.name === 'TimeoutError' || error?.name === 'AbortError',
          network: safeErrorCode(error),
        });
      }
      const head = { httpStatus: response.status, statusClass: `${Math.floor(response.status / 100)}xx` };
      if (response.status === 404) throw headError('VERIFY_HEAD_MISSING', head);
      if (!response.ok) throw headError('VERIFY_HEAD_UNAVAILABLE', head);
      if (
        response.headers.get('content-length') === null ||
        Number(response.headers.get('content-length')) !== size
      )
        throw new Error('VERIFY_HEAD_SIZE_MISMATCH');
      const checksum = response.headers.get('x-amz-checksum-sha256');
      if (!checksum) throw new Error('VERIFY_HEAD_CHECKSUM_MISSING');
      if (checksum !== Buffer.from(digest, 'hex').toString('base64'))
        throw new Error('VERIFY_HEAD_CHECKSUM_MISMATCH');
    },
    hashConvex: (url, size) => hash(url, size, 'convex'),
    async hashR2(key, size) {
      const url = await presign({
        method: 'GET',
        host: `${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        path: `/${config.R2_BUCKET}/${key}`,
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      });
      return hash(url, size, 'r2');
    },
  };
}
/** One query for a bounded metadata/URL window; never one Convex RPC per file. */
export function metadataSource(files) {
  if (!files.length || files.length > 100) throw new Error('VERIFY_PAGE_INVALID');
  return `return await Promise.all(${JSON.stringify(files.map(f => f.storageId))}.map(async id => {
    const row = await ctx.db.system.get(id);
    return row ? {...row, url: await ctx.storage.getUrl(id)} : null;
  }));`;
}
export function verificationSummary(state) {
  const classes = {};
  for (const row of state.results) {
    const group = (classes[row.class] ??= { verified: 0, excluded: 0, bytes: 0, errors: {} });
    if (row.fullDigest) {
      group.verified++;
      group.bytes += row.bytes;
    } else {
      group.excluded++;
      group.errors[row.code] = (group.errors[row.code] ?? 0) + 1;
    }
  }
  return {
    operationId: state.operationId,
    complete: state.complete,
    deleted: 0,
    classes,
    metrics: state.metrics,
  };
}
