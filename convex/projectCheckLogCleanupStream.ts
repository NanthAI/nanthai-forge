// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { lookupRef, type Identity, type PlanState, type PlanWrite } from './projectCheckLogCleanupTypes';
import { outputChunkSchema, outputKey, type OutputChunk } from '../src/hosted-check-output';
import { compactCheckText } from '../src/check-compact-output';
import { presignGet, r2Config } from './r2';
import { deleteR2Object } from './r2Operations';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
export type StreamProgress = {
  phase: 'compact' | 'delete';
  cursor: string | null;
  sequence: number;
  carryParts: number;
  dropping: boolean;
  diagnostics: number;
  excerpt: string;
  position: number;
  target?: OutputChunk;
  retainedCursor?: string | null;
  after?: string | null;
  done?: boolean;
};
type Stream = {
  runId: string;
  streamId: string;
  bytes: number;
  chunks: number;
  maxSequence: number;
  seal: string | null;
  descriptor: string;
};
/** One raw chunk or one retained-reference page per call. Line carry and summary
 * positions survive action/process loss; full logs and summaries never accumulate. */
export async function cleanupStreamStep(ctx: ActionCtx, input: Identity, state: PlanState, stream: Stream) {
  const p = (state.stream ??= {
    phase: 'compact',
    cursor: null,
    sequence: 0,
    carryParts: 0,
    dropping: false,
    diagnostics: 0,
    excerpt: '',
    position: 0,
  });
  const writes: PlanWrite[] = [];
  const address = {
    projectId: input.projectId,
    actor: input.actor,
    runId: stream.runId,
    streamId: stream.streamId,
  };
  const expected = JSON.stringify({
    bytes: stream.bytes,
    chunks: stream.chunks,
    maxSequence: stream.maxSequence,
    seal: stream.seal,
    descriptor: stream.descriptor,
  });
  const pageAt = async (cursor: string | null) =>
    JSON.parse(
      await ctx.runQuery(internal.projectHostedLogCleanupStore.page, {
        ...address,
        cursor,
        one: true,
        expected,
      }),
    );
  const finish = () => {
    state.outputOffset++;
    delete state.stream;
  };
  if (p.phase === 'compact') {
    const page = await pageAt(p.cursor);
    if (page.retired) {
      p.phase = 'delete';
      p.cursor = null;
      return writes;
    }
    const carry: Buffer[] = [];
    for (let i = 0; i < p.carryParts; i++) {
      const saved = await ctx.runQuery(lookupRef, { ...input, part: 'streamCarry', position: i });
      invariant(saved, 'NOT_FOUND', 'Original cleanup line carry is unavailable.');
      carry.push(Buffer.from(JSON.parse(saved), 'base64'));
    }
    if (page.page.length) {
      const chunk = outputChunkSchema.parse(JSON.parse(page.page[0].value));
      if (p.sequence !== chunk.sequence) carry.push(Buffer.from('\n'));
      p.sequence = chunk.sequence + 1;
      const config = r2Config(),
        response = await fetch(
          await presignGet(config, outputKey(input.projectId, stream.runId, chunk.object)),
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
      carry.push(bytes);
    }
    const bytes = Buffer.concat(carry),
      at = bytes.lastIndexOf(10);
    const lines = at < 0 ? [] : bytes.subarray(0, at).toString('utf8').split('\n');
    let tail = bytes.subarray(at + 1);
    if (
      page.isDone &&
      tail.length &&
      !p.dropping &&
      (!tail.toString('utf8').trimStart().startsWith('__FORGE_') ||
        tail.toString('utf8').trimStart().startsWith('__FORGE_COVERAGE__'))
    ) {
      lines.push(tail.toString('utf8'));
      tail = Buffer.alloc(0);
    }
    let text = '';
    for (const line of lines) {
      if (p.dropping) {
        p.dropping = false;
        continue;
      }
      if (line.length > 1024 * 1024) continue;
      let compact = compactCheckText(line);
      if (!compact.startsWith('__FORGE_') && !compact.startsWith('# ')) {
        compact = compact.slice(0, Math.max(0, 4096 - p.diagnostics));
        p.diagnostics += compact.length;
        p.excerpt = (p.excerpt + compact).slice(-4096);
      }
      text += compact;
    }
    if (tail.toString('utf8').length > 1024 * 1024) {
      tail = Buffer.alloc(0);
      p.dropping = true;
    }
    p.carryParts = Math.ceil(tail.length / 49152);
    for (let i = 0; i < p.carryParts; i++)
      writes.push({
        part: 'streamCarry',
        position: i,
        value: JSON.stringify(tail.subarray(i * 49152, (i + 1) * 49152).toString('base64')),
      });
    for (let at = 0; at < Math.max(1, text.length); at += 65536) {
      await ctx.runMutation(internal.projectHostedLogCleanupStore.summary, {
        ...address,
        expected,
        position: p.position++,
        text: text.slice(at, at + 65536),
        final: page.isDone && at + 65536 >= text.length,
        excerpt: p.excerpt,
      });
    }
    if (page.isDone) {
      p.phase = 'delete';
      p.cursor = null;
      p.carryParts = 0;
    } else p.cursor = page.continueCursor;
    return writes;
  }
  if (!p.target) {
    const page = await pageAt(p.cursor);
    if (!page.page.length) {
      finish();
      return writes;
    }
    p.target = outputChunkSchema.parse(JSON.parse(page.page[0].value));
    p.retainedCursor = null;
    p.after = page.isDone ? null : page.continueCursor;
    p.done = page.isDone;
  }
  const retained = JSON.parse(
    await ctx.runQuery(internal.projectHostedLogCleanupStore.retained, {
      ...address,
      cursor: p.retainedCursor ?? null,
    }),
  );
  if (retained.pins.includes(p.target.object.sha256) || retained.isDone) {
    if (!retained.pins.includes(p.target.object.sha256)) {
      await pageAt(null); // fresh authority and original stream pins immediately before IO
      await deleteR2Object(r2Config(), outputKey(input.projectId, stream.runId, p.target.object));
    }
    delete p.target;
    if (p.done) finish();
    else p.cursor = p.after!;
  } else p.retainedCursor = retained.continueCursor;
  return writes;
}
