// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { hostedLaneExpectationSchema, readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { hostedMainV2Schema } from './hosted-main.js';
import { parseNativeState } from './native-state-format.js';
import { reviewTextPage } from './source-review-format.js';
import { safeRelative } from './safe-relative.js';
import { SHOW_MAX_BYTES } from './agent-source-read.js';
import { ForgeError, invariant } from './errors.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

function sourceProtocol<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new ForgeError('HOSTED_PROTOCOL_INVALID', 'Hosted source does not match the supported contract.');
    throw error;
  }
}

export const hostedSourceSelectionSchema = z
  .object({
    laneId: z.uuid().optional(),
    expected: hostedLaneExpectationSchema.optional(),
    /** Read the project's current main instead of a Lane. */
    channel: z.literal('main').optional(),
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
async function selectHostedMain(transport: HostedAgentTransport) {
  const value = await transport.query('projectHostedChannels:current', {});
  const main = sourceProtocol(() => hostedMainV2Schema.parse(value));
  invariant(
    main.projectId === transport.address.projectId,
    'PROJECT_UNAVAILABLE',
    'Main belongs to another project.',
  );
  return main;
}
async function fileBytes(
  transport: HostedAgentTransport,
  input: z.infer<typeof hostedSourceSelectionSchema>,
  path: string,
) {
  invariant(
    input.channel === undefined || (!input.laneId && !input.expected),
    'BAD_ARGUMENT',
    'Select channel main or a Lane, not both.',
  );
  const main = input.channel === 'main' ? await selectHostedMain(transport) : undefined;
  const selection = main
    ? { head: main.head, channel: 'main' as const, sourceRevision: main.sourceRevision }
    : await selectHostedSource(transport, input);
  const cache = new HostedCheckoutCache(
    `${transport.root}.forge-client`,
    new ConvexLaneTransport(transport.exchange),
  );
  await cache.ensure([selection.head]);
  const state = sourceProtocol(() => parseNativeState(readFileSync(join(cache.objects, selection.head))));
  const entry = state.files.find(file => file.path === path);
  invariant(entry, 'NOT_FOUND', 'File is absent from the selected State.');
  await cache.ensure([entry.blob]);
  const bytes = readFileSync(join(cache.objects, entry.blob));
  // Cache hits do not grant fresh access. Recheck the original selection before returning bytes.
  if (main) await selectHostedMain(transport);
  else {
    const lane = selection as Awaited<ReturnType<typeof selectHostedSource>>;
    await selectHostedSource(transport, {
      laneId: lane.laneId,
      expected: { head: lane.head, version: lane.version, sourceVersion: lane.sourceVersion },
    });
  }
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
      ...('laneId' in pins ? { laneId: pins.laneId } : { channel: pins.channel }),
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
