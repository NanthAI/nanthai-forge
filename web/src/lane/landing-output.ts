// SPDX-License-Identifier: Apache-2.0
import type { LandingIO, Pin } from './hosted-landing-client';
import { digest } from '../../../src/portable-hash';
import { invariant } from '../../../src/errors';
import { failingTests } from './CheckPanel';
/** A decision excerpt reads one tail chunk per text stream, without a tail loop.
 * These are excerpts, not a claim that complete output was retained. */
export async function landingFailureExcerpt(io: LandingIO, runId: string) {
  let cursor: string | null = null;
  const text: string[] = [];
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
    for (const row of page.page) {
      if (row.stream.stream === 'artifact') continue;
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
      const selected = await io.mutation<{ object: Pin; url: string }>('projectHostedOutputRead:download', {
        runId,
        streamId: row.streamId,
        sequence: row.maxSequence,
      });
      const response = await fetch(selected.url);
      invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Check output download failed.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      invariant(
        bytes.length === selected.object.size && digest(bytes) === selected.object.sha256,
        'R2_OBJECT_CHECKSUM_MISMATCH',
        'Check output differs from its recorded chunk.',
      );
      text.push(new TextDecoder().decode(bytes));
    }
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  const joined = text.join('\n');
  return { failures: failingTests(joined), log: joined.trim().split('\n').slice(-8).join('\n').slice(-4096) };
}
