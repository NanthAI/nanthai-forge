// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { writableHostedCheck } from './projectHostedCheckStore';
import {
  outputMessageSchema,
  outputStreamId,
  outputChunkSchema,
  outputInitialChain,
  verifyOutput,
  outputRootSchema,
  type OutputRoot,
} from '../src/hosted-check-output';
import { checkPin, hostedCheckTerminal } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

export type OutputIdentity = { projectId: Id<'hostedProjects'>; runId: string };
export const outputHead = (ctx: QueryCtx | MutationCtx, id: OutputIdentity) =>
  ctx.db
    .query('projectHostedOutputHeads')
    .withIndex('by_project_and_run', q => q.eq('projectId', id.projectId).eq('runId', id.runId))
    .unique();
export const outputStream = (ctx: QueryCtx | MutationCtx, id: OutputIdentity, streamId: string) =>
  ctx.db
    .query('projectHostedOutputStreams')
    .withIndex('by_project_and_run_and_stream', q =>
      q.eq('projectId', id.projectId).eq('runId', id.runId).eq('streamId', streamId),
    )
    .unique();
export const outputChunk = (
  ctx: QueryCtx | MutationCtx,
  id: OutputIdentity,
  streamId: string,
  sequence: number,
) =>
  ctx.db
    .query('projectHostedOutputChunks')
    .withIndex('by_project_and_run_and_stream_and_sequence', q =>
      q.eq('projectId', id.projectId).eq('runId', id.runId).eq('streamId', streamId).eq('sequence', sequence),
    )
    .unique();
/** Fresh project/actor/epoch authority is checked even for duplicate callbacks,
 * after terminal check results and again after external HEAD verification. */
export async function authorizeOutput(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; message: unknown; signature: string },
  key: (id: string) => string,
) {
  const message = outputMessageSchema.parse(input.message);
  invariant(message.projectId === input.projectId, 'EVIDENCE_CHANGED', 'Output project differs.');
  const { run } = await writableHostedCheck(ctx, { projectId: input.projectId, runId: message.runId });
  verifyOutput(message, input.signature, key(run.keyId));
  invariant(
    run.plan &&
      run.dispatchStarted &&
      run.executionId === message.executionId &&
      run.request.operationId === message.operationId &&
      run.request.authorityEpoch === message.authorityEpoch &&
      run.fence === message.fence &&
      run.request.expectedHead === message.head &&
      run.planDigest === message.planDigest,
    'EVIDENCE_CHANGED',
    'Output differs from the retained check execution and source pins.',
  );
  if (run.configuration.provider === 'mac' && !hostedCheckTerminal(run))
    invariant(
      run.lease && run.lease.until > Date.now() && !run.cancelRequested,
      'WORK_STALE',
      'Output requires the live Mac execution owner.',
    );
  const stream =
    message.body.kind === 'chunk'
      ? message.body.chunk.stream
      : message.body.kind === 'seal'
        ? message.body.seal.stream
        : null;
  invariant(
    message.body.kind !== 'final' || hostedCheckTerminal(run),
    'EVIDENCE_CHANGED',
    'Final output requires a settled check result.',
  );
  invariant(
    !stream || stream.shard < run.plan.shardCount,
    'EVIDENCE_CHANGED',
    'Output shard differs from the exact plan.',
  );
  return message;
}
export function rootForOutput(
  id: OutputIdentity,
  executionId: string,
  head: Pick<Doc<'projectHostedOutputHeads'>, 'revision' | 'chain' | 'streams' | 'chunks' | 'bytes'> | null,
): OutputRoot {
  return outputRootSchema.parse({
    schema: 1,
    runId: id.runId,
    executionId,
    revision: head?.revision ?? 0,
    chain: head?.chain ?? outputInitialChain,
    streams: head?.streams ?? 0,
    chunks: head?.chunks ?? 0,
    bytes: head?.bytes ?? 0,
  });
}
export async function commitHostedOutput(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; message: unknown; signature: string },
  key: (id: string) => string,
) {
  const message = await authorizeOutput(ctx, input, key);
  const id = { projectId: input.projectId, runId: message.runId };
  const existingHead = await outputHead(ctx, id);
  const head = {
    ...id,
    revision: existingHead?.revision ?? 0,
    chain: existingHead?.chain ?? outputInitialChain,
    streams: existingHead?.streams ?? 0,
    sealed: existingHead?.sealed ?? 0,
    chunks: existingHead?.chunks ?? 0,
    bytes: existingHead?.bytes ?? 0,
    final: existingHead?.final ?? null,
  };
  const body = message.body;
  if (body.kind === 'final') {
    const expected = rootForOutput(id, message.executionId, existingHead);
    invariant(
      canonicalPayload(body.root) === canonicalPayload(expected) && head.streams === head.sealed,
      'EVIDENCE_CHANGED',
      'Final output manifest has gaps or differs from committed streams.',
    );
    if (head.final) {
      invariant(
        head.final === canonicalPayload(body.root),
        'WORK_OPERATION_CHANGED',
        'Retry the original final manifest.',
      );
      return { duplicate: true, root: expected };
    }
    head.final = canonicalPayload(body.root);
  } else {
    const descriptor = body.kind === 'chunk' ? body.chunk.stream : body.seal.stream;
    const streamId = outputStreamId(descriptor);
    const existingStream = await outputStream(ctx, id, streamId);
    const stream = {
      ...id,
      streamId,
      descriptor: canonicalPayload(descriptor),
      chunks: existingStream?.chunks ?? 0,
      bytes: existingStream?.bytes ?? 0,
      maxSequence: existingStream?.maxSequence ?? -1,
      seal: existingStream?.seal ?? null,
    };
    if (body.kind === 'chunk') {
      const chunk = body.chunk;
      invariant(
        Number.isSafeInteger(chunk.offset + chunk.object.size),
        'BAD_ARGUMENT',
        'Output offsets must remain exact.',
      );
      const prior = await outputChunk(ctx, id, streamId, chunk.sequence);
      if (prior) {
        invariant(
          prior.value === canonicalPayload(chunk),
          'WORK_OPERATION_CHANGED',
          'Retry the original output chunk.',
        );
        return { duplicate: true, revision: prior.revision };
      }
      invariant(!head.final && !stream.seal, 'EVIDENCE_CHANGED', 'Sealed output is immutable.');
      const before = chunk.sequence > 0 ? await outputChunk(ctx, id, streamId, chunk.sequence - 1) : null;
      const after = await outputChunk(ctx, id, streamId, chunk.sequence + 1);
      const previous = before && outputChunkSchema.parse(JSON.parse(before.value));
      const next = after && outputChunkSchema.parse(JSON.parse(after.value));
      invariant(
        (chunk.sequence !== 0 || chunk.offset === 0) &&
          (!previous || previous.offset + previous.object.size === chunk.offset) &&
          (!next || chunk.offset + chunk.object.size === next.offset),
        'EVIDENCE_CHANGED',
        'Adjacent output offsets differ. Missing sequences remain recoverable gaps.',
      );
      head.revision++;
      head.chunks++;
      head.bytes += chunk.object.size;
      head.chain = checkPin({ previous: head.chain, revision: head.revision, chunk });
      stream.chunks++;
      stream.bytes += chunk.object.size;
      stream.maxSequence = Math.max(stream.maxSequence, chunk.sequence);
      await ctx.db.insert('projectHostedOutputChunks', {
        ...id,
        streamId,
        sequence: chunk.sequence,
        revision: head.revision,
        value: canonicalPayload(chunk),
      });
    } else {
      const seal = body.seal;
      if (stream.seal) {
        invariant(
          stream.seal === canonicalPayload(seal),
          'WORK_OPERATION_CHANGED',
          'Retry the original stream seal.',
        );
        return { duplicate: true, revision: head.revision };
      }
      invariant(
        !head.final &&
          stream.chunks === seal.chunks &&
          stream.bytes === seal.bytes &&
          stream.maxSequence + 1 === seal.chunks,
        'EVIDENCE_CHANGED',
        'Recover every output chunk before sealing this stream.',
      );
      stream.seal = canonicalPayload(seal);
      head.sealed++;
      // Seals and empty streams are part of the immutable manifest digest too.
      head.revision++;
      head.chain = checkPin({ previous: head.chain, revision: head.revision, seal });
    }
    if (!existingStream) {
      head.streams++;
      await ctx.db.insert('projectHostedOutputStreams', stream);
    } else await ctx.db.patch(existingStream._id, stream);
  }
  invariant(
    [head.revision, head.streams, head.sealed, head.chunks, head.bytes].every(Number.isSafeInteger),
    'BAD_ARGUMENT',
    'Output metadata counters must remain exact.',
  );
  if (!existingHead) await ctx.db.insert('projectHostedOutputHeads', head);
  else await ctx.db.patch(existingHead._id, head);
  return { duplicate: false, revision: head.revision, root: rootForOutput(id, message.executionId, head) };
}
