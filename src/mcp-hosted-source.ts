// SPDX-License-Identifier: Apache-2.0
import { clientCacheRoot } from './root-paths.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { hostedLaneExpectationSchema, readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { hostedMainV2Schema } from './hosted-main.js';
import { parseNativeState } from './native-state-format.js';
import { reviewTextPage, SHOW_MAX_BYTES } from './source-review-format.js';
import { safeRelative } from './safe-relative.js';
import { ForgeError, invariant } from './errors.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

function sourceProtocol<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      (error instanceof ForgeError && error.code === 'INVALID_NATIVE_SOURCE')
    )
      throw new ForgeError('HOSTED_PROTOCOL_INVALID', 'Hosted source does not match the supported contract.');
    throw error;
  }
}

export const hostedSourceSelectionSchema = z
  .object({
    laneId: z.uuid().optional(),
    state: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    candidateId: z.uuid().optional(),
    expected: hostedLaneExpectationSchema.optional(),
    /** Read the project's current main instead of a Lane. */
    channel: z.literal('main').optional(),
    /** "main" is channel:"main". "base" is the selected Lane's pinned base State (the main it started from),
     * so a builder reads a file as the Lane saw it without the project clone. */
    at: z.enum(['base', 'main']).optional(),
  })
  .strict();
export const hostedSourceShowSchema = hostedSourceSelectionSchema
  .extend({
    action: z.literal('show'),
    path: z.string().refine(safeRelative),
    force: z.boolean().default(false),
  })
  .strict();
export const hostedSourceLinesSchema = hostedSourceSelectionSchema
  .extend({
    file: z.string().refine(safeRelative),
    start: z.number().int().positive().default(1),
    end: z.number().int().positive().default(40),
  })
  .strict();

/** Select only the requested Lane; never hydrate Work, history or a source graph. */
export async function selectHostedSource(transport: HostedAgentTransport, input: unknown) {
  const command = hostedSourceSelectionSchema.parse(input);
  let laneId = command.laneId;
  if (!laneId) {
    const marker = readHostedLaneCheckout(transport.root);
    invariant(
      !marker ||
        (marker.url === transport.address.url && marker.selection.projectId === transport.address.projectId),
      'PROJECT_UNAVAILABLE',
      'Select this checkout’s hosted project.',
    );
    laneId = marker?.selection.laneId;
  }
  invariant(laneId, 'BAD_ARGUMENT', 'Select laneId or use an opened hosted Lane.');
  const value = await transport.query('projectHostedLanes:select', {
    laneId,
    ...(command.expected ? { expected: command.expected } : {}),
  });
  const selection = sourceProtocol(() => hostedLaneSelectionSchema.parse(value));
  invariant(
    selection.projectId === transport.address.projectId && selection.laneId === laneId,
    'PROJECT_UNAVAILABLE',
    'Source selection belongs to another project or Lane.',
  );
  invariant(
    !command.expected ||
      (selection.head === command.expected.head &&
        selection.version === command.expected.version &&
        selection.sourceVersion === command.expected.sourceVersion),
    'WORK_STALE',
    'The selected Lane changed from its expected source pins.',
  );
  return selection;
}
/** Main's current State, read fresh and authorized; never a Lane working copy. */
export async function selectHostedMain(transport: HostedAgentTransport) {
  const value = await transport.query('projectHostedChannels:current', {});
  const main = sourceProtocol(() => hostedMainV2Schema.parse(value));
  invariant(
    main.projectId === transport.address.projectId,
    'PROJECT_UNAVAILABLE',
    'Main belongs to another project.',
  );
  return main;
}
export async function selectExactHostedSource(
  transport: HostedAgentTransport,
  selected: z.infer<typeof hostedSourceSelectionSchema>,
) {
  const { at, ...input } = selected;
  if (at === 'main') {
    invariant(
      !input.state && !input.candidateId && !input.laneId && !input.expected,
      'BAD_ARGUMENT',
      'at:"main" reads current main; drop laneId, state or candidateId.',
    );
    input.channel = 'main';
  }
  if (at === 'base') {
    invariant(
      !input.state && !input.candidateId && !input.channel,
      'BAD_ARGUMENT',
      'at:"base" reads a Lane base; select a Lane (default: this checkout\'s Lane), not a State, Candidate or main.',
    );
    const lane = await selectHostedSource(transport, input);
    return { head: lane.base.head, laneId: lane.laneId, at: 'base' as const };
  }
  invariant(
    [input.laneId, input.state, input.candidateId, input.channel].filter(Boolean).length <= 1,
    'BAD_ARGUMENT',
    'Select exactly one source: laneId, candidateId, state, or channel "main" (several were given).',
  );
  invariant(
    !input.expected || (!input.state && !input.candidateId && !input.channel),
    'BAD_ARGUMENT',
    'Expected version pins apply to a Lane.',
  );
  if (input.state) {
    const value = z
      .object({ head: z.literal(input.state) })
      .parse(await transport.query('projectHostedLanes:source', { state: input.state }));
    return value;
  }
  if (input.candidateId) {
    const { hostedRecordSchema } = await import('./hosted-records.js');
    const record = hostedRecordSchema.options[3].parse(
      await transport.query('projectHostedCompose:candidate', { candidateId: input.candidateId }),
    );
    invariant(record.id === input.candidateId, 'HOSTED_PROTOCOL_INVALID', 'Candidate identity differs.');
    invariant(
      record.result.status === 'clean',
      'VIEW_CONFLICT',
      'This Candidate has no source State; select a clean Candidate or an exact State.',
    );
    return { head: record.result.head, candidateId: record.id };
  }
  if (input.channel) {
    const main = await selectHostedMain(transport);
    return { head: main.head, channel: 'main' as const, sourceRevision: main.sourceRevision };
  }
  return selectHostedSource(transport, input);
}
async function fileBytes(
  transport: HostedAgentTransport,
  input: z.infer<typeof hostedSourceSelectionSchema>,
  path: string,
) {
  const selection = await selectExactHostedSource(transport, input);
  const cache = new HostedCheckoutCache(
    clientCacheRoot(transport.root),
    new ConvexLaneTransport(transport.exchange),
  );
  await cache.ensure([selection.head]);
  const state = sourceProtocol(() => parseNativeState(readFileSync(join(cache.objects, selection.head))));
  const entry = state.files.find(file => file.path === path);
  invariant(entry, 'NOT_FOUND', 'File is absent from the selected State.');
  await cache.ensure([entry.blob]);
  const bytes = readFileSync(join(cache.objects, entry.blob));
  // Cache hits do not grant fresh access. Recheck the original selection before returning bytes.
  if ('at' in selection) {
    // The base is immutable; only the caller's access to the Lane can have changed.
    await selectHostedSource(transport, { laneId: selection.laneId });
  } else if ('laneId' in selection) {
    const lane = hostedLaneSelectionSchema.parse(selection);
    await selectHostedSource(transport, {
      laneId: lane.laneId,
      expected: { head: lane.head, version: lane.version, sourceVersion: lane.sourceVersion },
    });
  } else await selectExactHostedSource(transport, input);
  return { selection, entry, bytes };
}
export async function showHostedSource(transport: HostedAgentTransport, input: unknown) {
  const { action: _action, path, force, ...selection } = hostedSourceShowSchema.parse(input);
  void _action;
  const { selection: pins, entry, bytes } = await fileBytes(transport, selection, path);
  invariant(
    force || bytes.length <= SHOW_MAX_BYTES,
    'FILE_LIMIT',
    'File exceeds 1 MiB; use force:true to read exact bytes.',
  );
  const binary = reviewTextPage(bytes).kind === 'binary';
  invariant(
    force || !binary,
    'BINARY_FILE',
    'File is binary or invalid UTF-8; use force:true to read exact bytes.',
  );
  return {
    sourceContext: pins,
    result: {
      state: pins.head,
      ...('laneId' in pins ? { laneId: pins.laneId } : 'channel' in pins ? { channel: pins.channel } : {}),
      ...('at' in pins ? { at: pins.at } : {}),
      path,
      blob: entry.blob,
      mode: entry.mode,
      size: bytes.length,
      encoding: binary ? 'base64' : 'utf8',
      content: bytes.toString(binary ? 'base64' : 'utf8'),
    },
  };
}
export async function readHostedSourceLines(transport: HostedAgentTransport, input: unknown) {
  const { file, start, end, ...selection } = hostedSourceLinesSchema.parse(input);
  invariant(end >= start && end - start < 200, 'BAD_ARGUMENT', 'Choose at most 200 source lines.');
  const { selection: pins, entry, bytes } = await fileBytes(transport, selection, file);
  invariant(
    reviewTextPage(bytes).kind === 'text',
    'BINARY_FILE',
    'Use forge_review show with force:true for binary source.',
  );
  const lines = bytes.toString('utf8').split('\n');
  return {
    sourceContext: pins,
    sourceId: pins.head,
    results: [
      {
        path: file,
        digest: entry.blob,
        mode: entry.mode,
        start,
        end: Math.min(end, lines.length),
        text: lines.slice(start - 1, end).join('\n'),
        totalLines: lines.length,
      },
    ],
  };
}
