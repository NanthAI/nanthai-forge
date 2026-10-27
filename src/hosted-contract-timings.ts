// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractTimingReader } from './contract-test-timings.js';
import { hostedCheckRunSchema } from './hosted-check.js';
import { outputStreamSchema, outputSealSchema } from './hosted-check-output.js';
import { invariant } from './errors.js';
import { z } from 'zod';
/** Read existing H12 output through its authorized, paged accessors. No new
 * measurement/evidence store, runner invocation or raw run-history dependency. */
export async function hostedContractTimings(input: {
  runId: string;
  candidateId: string;
  head: string;
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
  download(url: string): Promise<Uint8Array>;
}) {
  const identity = { runId: input.runId };
  const run = hostedCheckRunSchema.parse(await input.query('projectHostedCheckRead:status', identity));
  invariant(
    run.request.candidateId === input.candidateId &&
      run.request.expectedHead === input.head &&
      ['passed', 'failed'].includes(run.status),
    'CONTRACT_TIMING_SOURCE',
    'Select a completed timing run on this exact Candidate head.',
  );
  const manifest = z
    .object({ complete: z.boolean() })
    .parse(await input.query('projectHostedOutputRead:manifest', identity));
  invariant(
    manifest.complete,
    'CONTRACT_TIMING_MISSING',
    'The exact-Candidate timing run has incomplete retained output.',
  );
  const streams: {
    streamId: string;
    stream: z.infer<typeof outputStreamSchema>;
    seal: z.infer<typeof outputSealSchema> | null;
  }[] = [];
  let cursor: string | null = null;
  do {
    const page = z
      .object({
        page: z.array(
          z.object({ streamId: z.string(), stream: outputStreamSchema, seal: outputSealSchema.nullable() }),
        ),
        isDone: z.boolean(),
        continueCursor: z.string(),
      })
      .parse(await input.query('projectHostedOutputRead:streams', { ...identity, cursor }));
    streams.push(...page.page.filter(row => row.stream.stream !== 'artifact'));
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  const timings: Record<string, number> = {};
  for (const row of streams.sort((a, b) => a.stream.attempt - b.stream.attempt)) {
    invariant(row.seal, 'CONTRACT_TIMING_MISSING', 'Timing output stream is not sealed.');
    const parser = new ContractTimingReader(),
      decoder = new TextDecoder(),
      hash = createHash('sha256');
    let size = 0;
    for (let sequence = 0; sequence < row.seal.chunks; sequence++) {
      const result = z
        .object({ object: z.object({ sha256: z.string(), size: z.number() }), url: z.string() })
        .parse(
          await input.mutation('projectHostedOutputRead:download', {
            ...identity,
            streamId: row.streamId,
            sequence,
          }),
        );
      const bytes = await input.download(result.url);
      invariant(
        bytes.length === result.object.size &&
          createHash('sha256').update(bytes).digest('hex') === result.object.sha256,
        'R2_OBJECT_CHECKSUM_MISMATCH',
        'Timing output chunk differs from its retained bytes.',
      );
      hash.update(bytes);
      size += bytes.length;
      parser.accept(decoder.decode(bytes, { stream: true }));
    }
    parser.accept(decoder.decode());
    invariant(
      size === row.seal.bytes && hash.digest('hex') === row.seal.sha256,
      'EVIDENCE_CHANGED',
      'Timing output differs from its sealed stream.',
    );
    Object.assign(timings, parser.timings);
  }
  return timings;
}
