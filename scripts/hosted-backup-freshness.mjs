// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { r2Client } from './lib/hosted-backup-r2.mjs';
import { failure } from './lib/hosted-durability-compare.mjs';

const day = 24 * 60 * 60 * 1000;
const name =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/manifest\.json$/;

// A manifest is published only after the existing backup's full R2 readback passes.
// Scan bounded listing pages, then read one manifest and HEAD its ZIP, never the ZIP body.
export async function backupFreshness({ client, prefix, deployment, now = new Date() }) {
  if (!prefix || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/$/.test(prefix) || !deployment)
    throw failure('ARGUMENT_INVALID');
  let newest;
  for await (const page of client.pages(prefix)) {
    for (const key of page) {
      if (key.startsWith(prefix) && name.test(key.slice(prefix.length)) && (!newest || key > newest))
        newest = key;
    }
  }
  if (!newest) return { operation: 'backup-freshness', ageDays: null, overdue: true };
  const manifest = await client.manifest(newest);
  const [, time, id] = name.exec(newest.slice(prefix.length));
  const observed = Date.parse(manifest.time);
  if (
    manifest.format !== 1 ||
    manifest.deployment !== deployment ||
    manifest.operationId !== id ||
    manifest.time?.replaceAll(':', '-') !== time ||
    !Number.isFinite(observed) ||
    observed > now.getTime() ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size <= 0 ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  )
    throw failure('BACKUP_STATE_INVALID');
  const zip = await client.head(newest.replace(/manifest\.json$/, 'snapshot.zip'));
  if (!zip || zip.size !== manifest.size || (zip.sha256 && zip.sha256 !== manifest.sha256))
    throw failure('BACKUP_CHECKSUM_MISMATCH');
  const age = now.getTime() - observed;
  return { operation: 'backup-freshness', ageDays: age / day, overdue: age > 8 * day };
}

export async function main(env = process.env, dependencies = {}) {
  try {
    const result = await backupFreshness({
      client: dependencies.client ?? r2Client(env),
      prefix: env.HOSTED_DURABILITY_R2_PREFIX,
      deployment: env.HOSTED_DURABILITY_DEPLOYMENT,
      ...dependencies,
    });
    console.log(JSON.stringify(result));
    return result.overdue ? 2 : 0;
  } catch {
    // Provider text, keys, signed URLs and derived credential material stay private.
    console.error(JSON.stringify({ error: { code: 'BACKUP_FRESHNESS_FAILED' } }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await main();
