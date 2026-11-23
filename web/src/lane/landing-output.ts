// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { LandingIO, Pin } from './hosted-landing-client';
import { verifyDownloadedOutput } from '../../../src/hosted-output-reader';
import { invariant } from '../../../src/errors';
/** Names of failing tests from a bounded failure summary (node:test spec/TAP lines, deduplicated). */
export function failingTests(summary: string): string[] {
  const names = summary
    .split('\n')
    .map(line => line.trim())
    .filter(
      line =>
        (line.startsWith('✖') && !/failing tests:?$/.test(line)) || /^(?:\[test\] )?not ok \d+ - /.test(line),
    )
    .map(line =>
      line.replace(/^(?:✖\s*|(?:\[test\] )?not ok \d+ - )/, '').replace(/\s*\(\d+(\.\d+)?ms\)$/, ''),
    );
  return [...new Set(names)];
}

/** A decision excerpt reads one tail chunk per text stream, without a tail loop.
 * These are excerpts, not a claim that complete output was retained. While the check runs, a stream not yet
 * sealed is `live` and its tail chunk is the newest its runner has published (Item 42b8bf0e).
 * Calls: 1 query per page of streams, 1 signing mutation per page with text, 1 R2 GET per text stream. */
export async function landingFailureExcerpt(io: LandingIO, runId: string) {
  let cursor: string | null = null;
  const text: string[] = [];
  let live = false;
  do {
    const page: {
      page: {
        streamId: string;
        stream: { stream: string };
        maxSequence: number;
        chunks: number;
        retired?: boolean;
        failureExcerpt?: string;
        seal?: { failureSummary?: string } | null;
      }[];
      isDone: boolean;
      continueCursor: string;
    } = await io.query('projectHostedOutputRead:streams', { runId, cursor });
    const tails = page.page.filter(
      row => row.stream.stream !== 'artifact' && !row.seal?.failureSummary && row.chunks && !row.retired,
    );
    const targets = tails.length
      ? await io.mutation<{ object: Pin; envelope?: Pin; url: string }[]>(
          'projectHostedOutputRead:downloads',
          {
            runId,
            entries: tails.map(row => ({ streamId: row.streamId, sequence: row.maxSequence })),
          },
        )
      : [];
    invariant(targets.length === tails.length, 'EVIDENCE_CHANGED', 'Output download window is incomplete.');
    const byStream = new Map(tails.map((row, i) => [row.streamId, targets[i]!]));
    for (const row of page.page) {
      if (row.stream.stream === 'artifact') continue;
      if (!row.seal && !row.retired) live = true;
      if (row.seal?.failureSummary) {
        text.push(row.seal.failureSummary);
        continue;
      }
      if (!row.chunks) continue;
      if (row.retired) {
        let summaryCursor: string | null = null,
          compact = '';
        do {
          const summary: { page: { text: string }[]; isDone: boolean; continueCursor: string } =
            await io.query('projectHostedOutputRead:summaries', {
              runId,
              streamId: row.streamId,
              cursor: summaryCursor,
            });
          compact += summary.page.map(item => item.text).join('');
          summaryCursor = summary.isDone ? null : summary.continueCursor;
        } while (summaryCursor);
        text.push(compact);
        continue;
      }
      const selected = byStream.get(row.streamId)!;
      const response = await fetch(selected.url);
      invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Check output download failed.');
      const bytes = verifyDownloadedOutput(selected, new Uint8Array(await response.arrayBuffer()));
      text.push(new TextDecoder().decode(bytes));
    }
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  const joined = text.join('\n');
  return {
    failures: failingTests(joined),
    log: joined.trim().split('\n').slice(-8).join('\n').slice(-4096),
    live,
  };
}
