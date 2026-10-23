// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { r2Client } from './hosted-backup-r2.mjs';
import { failure } from './hosted-durability-compare.mjs';

const deploymentName = value => value?.replace(/^(?:dev|prod|preview):/, '');
/** Reuse the weekly backup's completed local receipts and its published format-1 manifest. */
export async function earlyPurgeBackup(command, { now = Date.now(), client } = {}) {
  try {
    const state = JSON.parse(await readFile(join(command.backupStateDirectory, 'last-run.json'), 'utf8'));
    if (
      deploymentName(state.target?.deployment) !== deploymentName(command.deployment) ||
      !state.target?.prefix ||
      !state.target?.bucket
    )
      throw failure('R2_BACKUP_REQUIRED');
    const receipts = Object.values(state.receipts ?? {})
      .filter(
        receipt =>
          receipt.operation === 'backup' &&
          receipt.complete === true &&
          (receipt.includeFileStorage ?? true) === true &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.operationId) &&
          Number.isFinite(Date.parse(receipt.time)) &&
          Date.parse(receipt.time) <= now &&
          now - Date.parse(receipt.time) <= 7 * 86400_000,
      )
      .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    if (!receipts.length) throw failure('R2_BACKUP_REQUIRED');
    client ??= r2Client({ ...process.env, R2_BUCKET: state.target.bucket });
    for (const receipt of receipts) {
      const manifestKey =
        state.target.prefix + `${receipt.time.replaceAll(':', '-')}-${receipt.operationId}/manifest.json`;
      // A completed receipt alone is insufficient: retention may have removed this backup.
      if (!(await client.head(manifestKey))) continue;
      const manifest = await client.manifest(manifestKey);
      if (
        manifest.format !== 1 ||
        manifest.operationId !== receipt.operationId ||
        manifest.time !== receipt.time ||
        deploymentName(manifest.deployment) !== deploymentName(command.deployment) ||
        manifest.databaseOnly === true ||
        (manifest.includeFileStorage ?? true) !== true ||
        manifest.sha256 !== receipt.sha256 ||
        manifest.size !== receipt.size ||
        !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
        !Number.isSafeInteger(manifest.size) ||
        manifest.size <= 0
      )
        throw failure('R2_BACKUP_REQUIRED');
      const snapshot = await client.head(manifestKey.replace(/manifest\.json$/, 'snapshot.zip'));
      if (
        !snapshot ||
        snapshot.size !== manifest.size ||
        (snapshot.sha256 && snapshot.sha256 !== manifest.sha256)
      )
        throw failure('R2_BACKUP_REQUIRED');
      return {
        complete: true,
        includeFileStorage: true,
        operationId: manifest.operationId,
        deployment: manifest.deployment,
        time: manifest.time,
        manifestKey,
        size: manifest.size,
        sha256: manifest.sha256,
      };
    }
  } catch {
    throw failure('R2_BACKUP_REQUIRED');
  }
  throw failure('R2_BACKUP_REQUIRED');
}
