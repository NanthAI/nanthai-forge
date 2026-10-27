// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { HostedOutputRedactor } from './hosted-output-redactor.js';
import {
  outputChunkSchema,
  outputSealSchema,
  outputStreamId,
  type OutputChunk,
  type OutputSeal,
  type OutputStream,
} from './hosted-check-output.js';
import { invariant } from './errors.js';

export type OutputSink = {
  /** Persist redacted bytes plus immutable metadata to a durable spool BEFORE
   * returning. Reconnect replays these same chunks until acknowledged. */
  retain(chunk: OutputChunk, bytes: Uint8Array): Promise<void>;
  /** Direct R2 PUT/verified commit. Must retry identical chunk after unknown ack. */
  publish(chunk: OutputChunk, bytes: Uint8Array): Promise<void>;
  seal(seal: OutputSeal): Promise<void>;
  publishBatch?(chunks: { chunk: OutputChunk; bytes: Uint8Array }[], seal?: OutputSeal): Promise<void>;
};
/** Fixed trusted collector, outside the process executing project commands.
 * Backpressure follows storage acknowledgements, never viewer presence/speed.
 * Each input slice is processed in bounded buffers; no whole-log accumulation. */
export async function collectHostedOutput(
  source: AsyncIterable<Uint8Array>,
  stream: OutputStream,
  redaction: { secrets: readonly string[]; paths: readonly string[] },
  sink: OutputSink,
  chunkBytes = 64 * 1024,
  flushEachInput = false,
  summary?: () => string,
): Promise<OutputSeal> {
  invariant(
    Number.isSafeInteger(chunkBytes) && chunkBytes > 0,
    'BAD_ARGUMENT',
    'Use a positive transfer chunk size.',
  );
  const redactor = new HostedOutputRedactor(redaction);
  // Metadata is published too: redact the portable display name before hashing.
  const names = new HostedOutputRedactor(redaction);
  stream = {
    ...stream,
    identity: stream.identity ?? outputStreamId(stream),
    name: names.write(Buffer.from(stream.name), true).toString('utf8'),
  };
  const hash = createHash('sha256');
  let sequence = 0,
    offset = 0,
    pending = Buffer.alloc(0);
  const window: { chunk: OutputChunk; bytes: Uint8Array }[] = [];
  let windowBytes = 0;
  const publishWindow = async (seal?: OutputSeal) => {
    await sink.publishBatch!(window, seal);
    window.length = 0;
    windowBytes = 0;
  };
  const flush = async (bytes: Buffer) => {
    const chunk = outputChunkSchema.parse({
      stream,
      sequence,
      offset,
      object: {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      },
    });
    if (
      sink.publishBatch &&
      window.length &&
      (window.length >= 32 || windowBytes + bytes.length > 2 * 1024 * 1024)
    )
      await publishWindow();
    await sink.retain(chunk, bytes);
    if (sink.publishBatch) {
      window.push({ chunk, bytes });
      windowBytes += bytes.length;
    } else await sink.publish(chunk, bytes);
    hash.update(bytes);
    sequence++;
    offset += bytes.length;
  };
  const append = async (bytes: Buffer) => {
    let position = 0;
    while (position < bytes.length) {
      const take = Math.min(chunkBytes - pending.length, bytes.length - position);
      pending = Buffer.concat([pending, bytes.subarray(position, position + take)]);
      position += take;
      if (pending.length === chunkBytes) {
        await flush(pending);
        pending = Buffer.alloc(0);
      }
    }
  };
  for await (const bytes of source) {
    for (let position = 0; position < bytes.length; position += chunkBytes)
      await append(redactor.write(bytes.subarray(position, position + chunkBytes)));
    // Runner streams publish available redacted bytes while the command is
    // alive. Replay retained chunks; recollection needs identical input framing.
    if (flushEachInput && pending.length) {
      await flush(pending);
      pending = Buffer.alloc(0);
    }
    if (flushEachInput && sink.publishBatch && window.length) await publishWindow();
  }
  await append(redactor.end());
  if (pending.length) await flush(pending);
  const summaryText = summary?.();
  const failureSummary = summaryText
    ? new HostedOutputRedactor(redaction)
        .write(Buffer.from(summaryText), true)
        .toString('utf8')
        .slice(0, 4096)
    : '';
  const seal = outputSealSchema.parse({
    ...(failureSummary ? { failureSummary } : {}),
    stream,
    chunks: sequence,
    bytes: offset,
    sha256: hash.digest('hex'),
  });
  if (sink.publishBatch) await publishWindow(seal);
  else await sink.seal(seal);
  return seal;
}
