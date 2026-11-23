// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Which exchange root a base backup's readers read (Item b6588425 line 2d): the one a base-checkpoint scrub wrote
// (src/work-base-scrub.ts), when the backup has one. Imports nothing, so Convex queries and mutations can use it.
type BytePin = { sha256: string; size: number };
/** A backup's scrub selection (convex/schema.ts projectBackups.scrubbed). */
export type BackupScrub = {
  operationId: string;
  root: BytePin;
  manifestDigest: string;
  /** The whole-Work digest of the original backup, which its derived owner pages (views, diffstats) name. */
  originalWork: string;
  at: number;
};
type BackupPins = {
  digest: string;
  size: number;
  objectManifest?: { digest: string; size: number } | undefined;
  preview: { manifestDigest: string };
  scrubbed?: BackupScrub | undefined;
};
/** The exchange root a base reader reads: the scrubbed one when the backup has one. */
export const backupRootPin = (backup: Omit<BackupPins, 'preview'>): BytePin =>
  backup.scrubbed?.root ?? {
    sha256: backup.objectManifest?.digest ?? backup.digest,
    size: backup.objectManifest?.size ?? backup.size,
  };
/** The manifest digest that root's manifest has. */
export const backupManifestDigest = (backup: Pick<BackupPins, 'preview' | 'scrubbed'>) =>
  backup.scrubbed?.manifestDigest ?? backup.preview.manifestDigest;
/** The whole-Work digest the backup's derived owner pages were written for. */
export const backupOwnerWork = (backup: Pick<BackupPins, 'scrubbed'>, records: { work: BytePin }) =>
  backup.scrubbed?.originalWork ?? records.work.sha256;
