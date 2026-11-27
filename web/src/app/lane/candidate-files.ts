// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import type { Id } from '../../../../convex/_generated/dataModel';
import { api } from '../../../../convex/_generated/api';
import type { CodeChange } from '../../../../src/code-tree';
import { DRAW_BYTES, readExact } from './file-diff';
import type { Reply, ReviewFile } from './review-model';

type Candidate = NonNullable<Reply['candidate']>;
type Listing = { base: string; head: string; files: ReviewFile[] };

/** The immutable Candidate listing is fetched only when the Lane's page cannot serve that same version pair. */
export function useCandidateFiles(projectId: Id<'hostedProjects'>, candidate: Candidate | null) {
  const client = useConvex();
  const digest = candidate?.files?.sha256;
  const base = candidate?.base;
  const head = candidate?.head;
  const useListing = Boolean(digest && candidate!.files!.size <= DRAW_BYTES);
  const key = candidate ? `${projectId}:${base}:${head}:${digest ?? ''}` : null;
  const [read, setRead] = useState<{ key: string; result: { files: ReviewFile[]; total: number } | null }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key || !base || !head) return;
    let live = true;
    const readListing = async (base: string, head: string) => {
      if (useListing && digest) {
        const result = await readExact(client, projectId, [digest]);
        if (result.large) return null;
        const listing: Listing = JSON.parse(new TextDecoder().decode(result.bytes.get(digest)));
        return listing.base === base && listing.head === head && Array.isArray(listing.files)
          ? { files: listing.files, total: listing.files.length }
          : null;
      }
      // Reuse Code's one capped comparison page for older or oversized listings. Never fetch them wholesale.
      const page = JSON.parse(
        await client.action(api.projectCodeBrowse.read, {
          projectId,
          state: head,
          base,
          want: 'changes',
        }),
      ) as { state: string; base: string; changes?: CodeChange[]; total: number };
      if (page.state !== head || page.base !== base || !page.changes) return null;
      const files = page.changes.flatMap(file =>
        file.before !== undefined && file.after !== undefined
          ? [{ ...file, before: file.before, after: file.after }]
          : [],
      );
      return { files, total: page.total };
    };
    void readListing(base, head).then(
      result => {
        if (live) setRead({ key, result });
      },
      () => {
        if (live) setRead({ key, result: null });
      },
    );
    return () => {
      live = false;
    };
  }, [base, head, digest, key, useListing, attempt, client, projectId]);
  const result = key !== null && read?.key === key ? read.result : null;
  return {
    files: result?.files ?? null,
    total: result?.total ?? 0,
    loading: key !== null && read?.key !== key,
    retry: key
      ? () => {
          setRead(undefined);
          setAttempt(n => n + 1);
        }
      : undefined,
  };
}
