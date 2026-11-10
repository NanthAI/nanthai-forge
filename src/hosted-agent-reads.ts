// SPDX-License-Identifier: Apache-2.0
import { hostedProvenanceSchema } from './hosted-provenance-schema.js';
import { hostedRecordsReadSchema } from './hosted-record-read.js';
import { hostedCheckLogSchema } from './hosted-check-log.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { clientCacheRoot } from './root-paths.js';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { parseNativeState } from './native-state-format.js';
import { reviewPaths } from './source-review-format.js';
import { contextualHunks } from './review-hunks.js';
import { safeRelative } from './safe-relative.js';
import { invariant } from './errors.js';
import { selectHostedSource, selectHostedMain, hostedSourceShowSchema } from './mcp-hosted-source.js';
import { summarizeAgainstMain } from './hosted-diff-summary.js';
import { hostedWaitSchema } from './hosted-wait-schema.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import { memberDataNotice } from './member-data-notice.js';
import { QUEUE_VIEW_LIMIT } from './hosted-queue-view.js';
import { hostedLandingsSchema } from './hosted-agent-landings.js';
import { hostedLaneHistorySchema } from './hosted-agent-lane-history.js';
import { liveLanesInput } from './hosted-live-lanes.js';
import { hostedBoardSchemas } from './hosted-board.js';
import { SELECT_LANE } from './hosted-lane-location.js';
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const hostedPeersSchema = z
  .object({
    laneId: z.uuid().optional(),
    path: z.string().refine(safeRelative).optional(),
    detail: z.boolean().default(false),
  })
  .strict();
export const hostedDiffSchema = z
  .object({
    laneId: z.uuid().optional(),
    paths: z.array(z.string().refine(safeRelative)).optional(),
    byteBudget: z.number().int().min(1024).safe().default(48000),
    /** Per changed path: equal / absent / different against current main. No hunks, no blob reads. */
    summary: z.boolean().default(false),
    cursor: z
      .object({
        base: hash,
        head: hash,
        offset: z.number().int().nonnegative().safe(),
        laneId: z.uuid(),
        paths: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export async function peersHostedSource(transport: HostedAgentTransport, input: unknown) {
  const parsed = hostedPeersSchema.safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Invalid hosted peers parameters. Use peers --help.');
  const command = parsed.data;
  const laneId = command.laneId ?? readHostedLaneCheckout(transport.root)?.selection.laneId;
  invariant(laneId, 'BAD_ARGUMENT', SELECT_LANE);
  // Deliberately no capability or select probe: the server authorizes and pins the entire observation.
  const result = await transport.query<Record<string, unknown>>('projectHostedOverlaps:read', {
    ...command,
    laneId,
    detail: true,
    items: command.detail ? 50 : 5,
  });
  // Peer intents and overlap notes are member-written: one marker per read (S-17).
  return result && typeof result === 'object' && result.peerEvidence
    ? { ...result, notice: memberDataNotice }
    : result;
}
export const hostedQueueSchema = z
  .object({
    limit: z.number().int().min(1).max(QUEUE_VIEW_LIMIT).optional(),
    /** Mark this Lane's entries in the answer (default: this checkout's Lane). Never sent to the server. */
    laneId: z.uuid().optional(),
  })
  .strict();
/** One bounded read of the landing queue (09e637f7): Lane, Intent title, phase,
 * last failing test files and recompose count per entry, in dispatch order. */
export async function queueHostedSource(transport: HostedAgentTransport, input: unknown) {
  const parsed = hostedQueueSchema.safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Invalid hosted queue parameters. Use queue --help.');
  const { laneId: selected, ...query } = parsed.data;
  const view = await transport.query('projectHostedQueueView:read', query);
  return markQueueLane(view, selected ?? readHostedLaneCheckout(transport.root)?.selection.laneId);
}
/** Local, no extra call: say where the caller's Lane stands in the page that was read. */
export function markQueueLane(view: unknown, laneId: string | undefined) {
  if (!laneId || !view || typeof view !== 'object' || !Array.isArray((view as { entries?: unknown }).entries))
    return view;
  const page = view as {
    entries: { laneId?: string | null; position?: number | null; submissionId?: string; hold?: unknown }[];
    more?: boolean;
  };
  const yours = page.entries
    .filter(entry => entry.laneId === laneId)
    .map(entry => ({
      position: entry.position ?? null,
      submissionId: entry.submissionId,
      // A held entry has no position: say what holds it and the next step (5c59940b).
      ...(entry.hold ? { hold: entry.hold } : {}),
    }));
  return {
    ...page,
    yourLane: {
      laneId,
      listed: yours.length > 0,
      entries: yours,
      ...(yours.length || !page.more
        ? {}
        : { note: 'Not in this page; raise limit (max 20) or read status {laneId}.' }),
    },
  };
}

/** Client-side reads: validated, helped and dispatched by name before any hosted-action lookup.
 * Add a read here once; validation and help derive from it, and a test drives each through dispatch. */
export const hostedClientReadSchemas = {
  provenance: hostedProvenanceSchema,
  records: hostedRecordsReadSchema,
  log: hostedCheckLogSchema.omit({ action: true }),
  lanes: liveLanesInput,
  diff: hostedDiffSchema,
  peers: hostedPeersSchema,
  queue: hostedQueueSchema,
  landings: hostedLandingsSchema,
  'lane-history': hostedLaneHistorySchema,
  wait: hostedWaitSchema,
  show: hostedSourceShowSchema.omit({ action: true }),
  /** The board verbs are client actions too: `board --post`/`--reply` write one note each, `--resolve` withdraws one. */
  ...hostedBoardSchemas,
} as const;
/** Immutable manifests and selected blobs live in R2, never in a Convex response. */
export async function diffHostedSource(transport: HostedAgentTransport, input: unknown) {
  const parsed = hostedDiffSchema.safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Invalid hosted diff parameters. Use diff --help.');
  const command = parsed.data;
  const lane = await selectHostedSource(transport, { laneId: command.laneId });
  const cursor = command.cursor;
  invariant(
    !cursor ||
      (cursor.laneId === lane.laneId && JSON.stringify(cursor.paths) === JSON.stringify(command.paths)),
    'BAD_ARGUMENT',
    'Continue with the original Lane and paths.',
  );
  const base = cursor?.base ?? lane.base.head,
    head = cursor?.head ?? lane.head;
  // Continuations retain the original pair even after a later save. Both must still belong to the project.
  if (cursor) {
    await transport.query('projectHostedLanes:source', { state: base });
    if (head !== base) await transport.query('projectHostedLanes:source', { state: head });
  }
  const objects = new ConvexLaneTransport(transport.exchange);
  const cache = new HostedCheckoutCache(clientCacheRoot(transport.root), objects);
  await cache.ensure([base, head]);
  const read = (id: string) => readFileSync(join(cache.objects, id));
  const requested = command.paths ? new Set(command.paths) : null;
  const changes = reviewPaths(parseNativeState(read(base)).files, parseNativeState(read(head)).files).filter(
    item => item.status !== 'unchanged' && (!requested || requested.has(item.path)),
  );
  const offset = cursor?.offset ?? 0;
  invariant(offset <= changes.length, 'BAD_ARGUMENT', 'Diff cursor is beyond the pinned paths.');
  if (command.summary) {
    // One more manifest (current main's State); every standing is decided from manifest entries.
    const main = await selectHostedMain(transport);
    await cache.ensure([main.head]);
    const page = summarizeAgainstMain(
      changes,
      parseNativeState(read(main.head)).files,
      offset,
      command.byteBudget,
    );
    // Cache access and an old cursor never grant current project access.
    await transport.query('projectHostedLanes:select', { laneId: lane.laneId });
    const next =
      page.end < changes.length
        ? {
            base,
            head,
            offset: page.end,
            laneId: lane.laneId,
            ...(command.paths ? { paths: command.paths } : {}),
          }
        : null;
    return {
      sourceContext: { laneId: lane.laneId, base, head, scope: 'saved' },
      result: {
        summary: true,
        base,
        head,
        main: main.head,
        items: page.items,
        counts: page.counts,
        total: changes.length,
        nextCursor: next,
        truncated: next !== null,
        cost: {
          sourceBytes: 0,
          outputBytes: page.outputBytes,
          downloadedBytes: cache.downloadedBytes,
          metadataPages: 0,
          manifestBytes: [base, head, main.head]
            .filter((id, index, ids) => ids.indexOf(id) === index)
            .reduce((sum, id) => sum + read(id).length, 0),
        },
      },
    };
  }
  const window = changes.slice(offset, offset + 50);
  const ids = [
    ...new Set(
      window.flatMap(item => [item.before?.blob, item.after?.blob].filter((id): id is string => !!id)),
    ),
  ];
  const pins = ids.length ? await objects.objects(ids) : [];
  const sizes = new Map(pins.map(pin => [pin.sha256, pin.size]));
  let sourceBytes = 0,
    outputBytes = 0,
    end = offset;
  const selected: typeof window = [],
    omitted: { path: string; requiredByteBudget: number }[] = [];
  for (const item of window) {
    const size =
      (item.before ? sizes.get(item.before.blob)! : 0) + (item.after ? sizes.get(item.after.blob)! : 0);
    if (sourceBytes + size > command.byteBudget) {
      if (selected.length) break;
      omitted.push({ path: item.path, requiredByteBudget: size });
      end++;
      continue;
    }
    sourceBytes += size;
    selected.push(item);
    end++;
  }
  const selectedIds = [
    ...new Set(
      selected.flatMap(item => [item.before?.blob, item.after?.blob].filter((id): id is string => !!id)),
    ),
  ];
  // Reuse the descriptors/signatures from the one metadata page instead of looking up each file again.
  const byteCache = new HostedCheckoutCache(clientCacheRoot(transport.root), {
    objects: async digests => digests.map(id => pins.find(pin => pin.sha256 === id)!),
    downloadToFile: objects.downloadToFile.bind(objects),
    downloadFiles: objects.downloadFiles.bind(objects),
  });
  await byteCache.ensure(selectedIds);
  const items = selected.map(item => {
    const diff = contextualHunks(
      item.before ? read(item.before.blob) : Buffer.alloc(0),
      item.after ? read(item.after.blob) : Buffer.alloc(0),
      3,
    );
    const bytes = Buffer.byteLength(JSON.stringify(diff));
    if (outputBytes + bytes > command.byteBudget) {
      const bounded: typeof diff = { ...diff, hunks: [], truncated: true };
      let remaining = command.byteBudget - outputBytes - Buffer.byteLength(JSON.stringify(bounded));
      for (const hunk of diff.hunks) {
        const partial = { ...hunk, lines: [] as typeof hunk.lines, beforeLines: 0, afterLines: 0 };
        // Reserve header/count growth once; accounting is linear in emitted lines.
        remaining -= Buffer.byteLength(JSON.stringify(partial)) + 64;
        if (remaining <= 0) break;
        bounded.hunks.push(partial);
        for (const line of hunk.lines) {
          const size = Buffer.byteLength(JSON.stringify(line)) + 1;
          if (size > remaining) break;
          remaining -= size;
          partial.lines.push(line);
          if (line.kind !== 'added') partial.beforeLines++;
          if (line.kind !== 'removed') partial.afterLines++;
        }
        if (!partial.lines.length) bounded.hunks.pop();
        if (partial.lines.length !== hunk.lines.length) break;
      }
      const size = Buffer.byteLength(JSON.stringify(bounded));
      if (size <= command.byteBudget - outputBytes) {
        outputBytes += size;
        return { ...item, ...bounded };
      }
      return { ...item, hunks: [], truncated: true };
    }
    outputBytes += bytes;
    return { ...item, ...diff };
  });
  // Cache access and an old cursor never grant current project access.
  await transport.query('projectHostedLanes:select', { laneId: lane.laneId });
  const nextCursor =
    end < changes.length
      ? { base, head, offset: end, laneId: lane.laneId, ...(command.paths ? { paths: command.paths } : {}) }
      : null;
  return {
    sourceContext: { laneId: lane.laneId, base, head, scope: 'saved' },
    result: {
      base,
      head,
      items,
      omitted,
      total: changes.length,
      nextCursor,
      truncated: omitted.length > 0 || items.some(item => item.truncated) || nextCursor !== null,
      cost: {
        sourceBytes,
        outputBytes,
        downloadedBytes: cache.downloadedBytes + byteCache.downloadedBytes,
        metadataPages: ids.length ? 1 : 0,
        manifestBytes: read(base).length + (head === base ? 0 : read(head).length),
      },
    },
  };
}
