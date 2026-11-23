// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import type { GithubSourceEntry } from '../src/github-project-source';
import { gitBlobId } from '../src/github-archive-source';
import { importPageBytes } from '../src/github-import-pages';
import { invariant } from '../src/errors';
import type { ImportUpload } from './projectGithubImportUpload';

/** Consume small blobs in listing order, retaining one byte- and count-bounded page. */
export async function stageFallbackBlobs<Entry extends GithubSourceEntry>(
  entries: Iterable<Entry> | AsyncIterable<Entry>,
  io: {
    upload: Pick<ImportUpload, 'put' | 'stagedBytes'>;
    fetchBlobs: (entries: GithubSourceEntry[]) => Promise<Map<string, Buffer>>;
    record: (entry: Entry, pin: { blob: string; size: number }) => void;
    drain: () => Promise<void>;
    over: () => boolean;
    hold?: (entry: Entry, bytes: Buffer) => boolean;
  },
  pageFiles = 100,
) {
  const rows = Symbol.asyncIterator in entries ? entries[Symbol.asyncIterator]() : entries[Symbol.iterator]();
  try {
    let next = await rows.next();
    while (!next.done && !io.over()) {
      const room = importPageBytes - io.upload.stagedBytes;
      const page: Entry[] = [next.value];
      let listed = next.value.size;
      next = await rows.next();
      while (!next.done && page.length < pageFiles && listed + next.value.size <= room) {
        listed += next.value.size;
        page.push(next.value);
        next = await rows.next();
      }
      const blobs = await io.fetchBlobs(page);
      for (const entry of page) {
        const bytes = blobs.get(entry.sha);
        invariant(
          bytes && bytes.length === entry.size && gitBlobId(entry.sha, bytes) === entry.sha,
          'ARTIFACT_INTEGRITY',
          'GitHub blob differs from the selected commit.',
        );
        if (io.hold?.(entry, bytes)) continue;
        const pin = io.upload.put(bytes);
        io.record(entry, { blob: pin.sha256, size: pin.size });
      }
      await io.drain();
    }
  } finally {
    await rows.return?.();
  }
}
