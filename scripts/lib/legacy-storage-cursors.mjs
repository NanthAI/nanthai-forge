// SPDX-License-Identifier: Apache-2.0
import { storageClass, verificationIo } from './legacy-storage-verify.mjs';
import { privateJson } from './legacy-storage-journal.mjs';
export async function migrateVerifiedCursors(audit, verification, dry, command, io) {
  const verified = new Map(verification.results.filter(r => r.fullDigest).map(r => [r.storageId, r]));
  const cursors = audit.files
    .filter(f => storageClass(f) === 2)
    .flatMap(file => {
      const pin = verified.get(file.storageId);
      if (!pin || dry.heads.excluded.some(r => r.storageId === file.storageId)) return [];
      return file.references.map(ref => ({
        id: ref.document,
        storageId: file.storageId,
        digest: pin.sha256,
        size: pin.bytes,
        key: `v1/p/${ref.project}/o/${pin.sha256}`,
        verifiedAt: pin.verifiedAt,
      }));
    });
  if (!cursors.length) return { changedRows: 0 };
  const metrics = { r2Gets: 0, r2Bytes: 0, convexGets: 0, convexBytes: 0 },
    bytes = verificationIo(await io.reader.r2Config(), metrics);
  const request = { operationId: command.operationId, part: 'cursors', pins: cursors };
  await privateJson(command.out + '/request-cursors.json', request);
  async function verify(phase) {
    for (const pin of cursors) {
      try {
        if ((await bytes.hashR2(pin.key, pin.size)) !== pin.digest) throw Error('VERIFY_DIGEST_MISMATCH');
      } catch (error) {
        await privateJson(command.out + '/excluded-cursor-' + pin.storageId + '.json', {
          storageId: pin.storageId,
          class: 2,
          phase,
          code: /^VERIFY_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'VERIFY_DOWNLOAD_FAILED',
        });
        throw Error('CLEANUP_MIGRATION_UNVERIFIED');
      }
    }
  }
  await verify('before-migration');
  const result = await io.call('projectLegacyStorageCleanup:migrateCursors', request);
  await privateJson(command.out + '/result-cursors.json', result);
  const rows = await io.reader.page(
    `return await Promise.all(${JSON.stringify(cursors.map(c => c.id))}.map(id=>ctx.db.get(id)));`,
  );
  if (
    rows.length !== cursors.length ||
    rows.some((r, i) => r?.cursor !== `r2source:${cursors[i].digest}:${cursors[i].size}`)
  )
    throw Error('CLEANUP_MIGRATION_UNVERIFIED');
  await verify('after-migration');
  const migration = { changedRows: cursors.length, verified: true, metrics };
  await privateJson(command.out + '/migration.json', migration);
  return migration;
}
