// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { outputChunkSchema, outputKey } from '../src/hosted-check-output';
import { compactProviderOutput, compactCheckText } from '../src/check-compact-output';
import { presignGet, r2Config } from './r2';
import { deleteR2Object } from './r2Operations';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { internal } from './_generated/api';
/** Keep original hashes, seals and verdicts as commitments. Compact evidence is
 * retained before deleting raw output keys; retries finish exactly those keys. */
export async function purgeHostedLogStream(
  ctx: ActionCtx,
  input: {
    projectId: import('./_generated/dataModel').Id<'hostedProjects'>;
    actor: string;
    runId: string;
    streamId: string;
  },
) {
  const chunks: ReturnType<typeof outputChunkSchema.parse>[] = [];
  let cursor: string | null = null,
    retired = false;
  do {
    const page = JSON.parse(
      await ctx.runQuery(internal.projectHostedLogCleanupStore.page, { ...input, cursor }),
    );
    retired = page.retired;
    for (const row of page.page) chunks.push(outputChunkSchema.parse(JSON.parse(row.value)));
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
  const config = r2Config();
  if (!retired) {
    async function* byteSource() {
      let next = 0;
      for (const chunk of chunks) {
        // Gaps cannot be joined into a complete machine report.
        if (chunk.sequence !== next) yield Buffer.from('\n');
        next = chunk.sequence + 1;
        const response = await fetch(
          await presignGet(config, outputKey(input.projectId, input.runId, chunk.object)),
        );
        invariant(
          response.ok,
          'R2_OBJECT_UNAVAILABLE',
          'Original hosted log is unavailable; its metadata was preserved.',
        );
        const bytes = Buffer.from(await response.arrayBuffer());
        invariant(
          bytes.length === chunk.object.size && digest(bytes) === chunk.object.sha256,
          'R2_OBJECT_CHECKSUM_MISMATCH',
          'Hosted log differs from its recorded chunk.',
        );
        yield bytes;
      }
    }
    let compact = '';
    for await (const bytes of compactProviderOutput(byteSource()))
      compact += Buffer.from(bytes).toString('utf8');
    const excerpt = compactCheckText(compact)
      .split('\n')
      .filter(line => !line.startsWith('__FORGE_'))
      .join('\n')
      .slice(-4096);
    for (let offset = 0; offset < Math.max(1, compact.length); offset += 65536)
      await ctx.runMutation(internal.projectHostedLogCleanupStore.summary, {
        ...input,
        position: offset / 65536,
        text: compact.slice(offset, offset + 65536),
        final: offset + 65536 >= compact.length,
        excerpt,
      });
  }
  const protectedPins = new Set<string>();
  cursor = null;
  do {
    const page = JSON.parse(
      await ctx.runQuery(internal.projectHostedLogCleanupStore.retained, { ...input, cursor }),
    );
    for (const pin of page.pins) protectedPins.add(pin);
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
  for (const chunk of chunks) {
    if (protectedPins.has(chunk.object.sha256)) continue;
    await ctx.runQuery(internal.projectHostedLogCleanupStore.page, { ...input, cursor: null });
    await deleteR2Object(config, outputKey(input.projectId, input.runId, chunk.object));
  }
  return chunks.reduce((sum, chunk) => sum + chunk.object.size, 0);
}
