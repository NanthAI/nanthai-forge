// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  buildComposePages,
  composeRequestSchema,
  composeLaneSchema,
  composeDependencySchema,
  type ComposeEntry,
} from './hosted-compose.js';
import { hostedLaneSelectionSchema, type HostedLaneSelection } from './hosted-lane.js';
import { saveExpectedSchema, savePin, saveBytes, saveWorkerObjectSchema } from './hosted-save.js';
import { syncRequestSchema } from './hosted-sync.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { shellQuote } from './agent-brief-render.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import { hostedRecordSchema } from './hosted-records.js';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
export type SourceProgress = {
  terminal?: { outcome: { status: string; result?: unknown } } | null;
  input?: unknown;
};
export async function selectAgentLane(session: HostedAgentSession, laneId?: string) {
  laneId ??= session.marker()?.selection.laneId;
  invariant(laneId, 'BAD_ARGUMENT', 'Select laneId or open a hosted Lane.');
  const lane = hostedLaneSelectionSchema.parse(await session.query('projectHostedLanes:select', { laneId }));
  invariant(
    lane.projectId === session.address.projectId,
    'PROJECT_UNAVAILABLE',
    'Select this hosted project.',
  );
  return lane;
}
export async function agentState(session: HostedAgentSession, head: string) {
  const rows = z
    .array(
      z.object({
        digest: z.string(),
        size: z.number(),
        recipe: z.object({ digest: z.string(), size: z.number() }).optional(),
      }),
    )
    .parse(await session.mutation('projectObjectDownloads:describe', { digests: [head] }));
  const row = rows.find(row => row.digest === head);
  invariant(row, 'SOURCE_UNAVAILABLE', 'The selected State object is unavailable.');
  return saveWorkerObjectSchema.parse({
    object: { sha256: head, size: row.size },
    recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
  });
}
export async function driveAgentSource(
  session: HostedAgentSession,
  kind: 'Compose' | 'Sync',
  operationId: string,
  request: unknown,
  pages: { kind: string; index: number; pin: ReturnType<typeof savePin>; value: unknown }[] = [],
  /** Report a WORK_STALE prepare refusal as PrepareRefused (the caller rebuilds its pins). */
  refusable = false,
) {
  let prepared: SourceProgress;
  try {
    prepared = await session.mutation<SourceProgress>(`projectHosted${kind}:prepare`, {
      request: canonicalPayload(request),
    });
  } catch (error) {
    // prepare is one transaction: a refusal began no server operation.
    if (refusable && hostedActionError(error, kind.toLowerCase()).code === 'WORK_STALE')
      throw new PrepareRefused(error);
    throw error;
  }
  if (prepared.terminal) return prepared.terminal;
  for (const page of pages) {
    await session.exchange.upload(page.pin, Buffer.from(saveBytes(page.value)));
    await session.mutation(`projectHosted${kind}:stage`, {
      operationId,
      kind: page.kind,
      index: page.index,
      page: canonicalPayload(page.value),
    });
  }
  const progress = await session.query<SourceProgress>(`projectHosted${kind}:progress`, { operationId });
  if (progress.terminal) return progress.terminal;
  invariant(progress.input, 'SOURCE_UNAVAILABLE', 'The prepared source input is unavailable.');
  await session.exchange.upload(savePin(progress.input), Buffer.from(saveBytes(progress.input)));
  return session.mutation(`projectHosted${kind}Jobs:submit`, { operationId });
}
export async function composeAgentSource(
  session: HostedAgentSession,
  command: z.infer<typeof hostedAgentCommandSchemas.compose>,
  operationId: string,
) {
  const prepared = await session.journal.retain(`compose:${operationId}`, async () => {
    const main = await session.main();
    const selected = command.inputs ?? [{ laneId: (await selectAgentLane(session, command.laneId)).laneId }];
    const inputs: ComposeEntry[] = [];
    let intentId = command.intentId;
    const dependencies: ComposeEntry[] = [];
    const selection = [
      ...selected.map(item => ({ kind: 'inputs' as const, item })),
      ...command.dependencies.map(item => ({ kind: 'dependencies' as const, item })),
    ];
    const row = z.object({ intentId: z.string(), entry: z.unknown() });
    for (let offset = 0; offset < selection.length; offset += 100) {
      const window = selection.slice(offset, offset + 100);
      const page = z.object({ inputs: z.array(row), dependencies: z.array(row) }).parse(
        await session.query('projectHostedComposeSelection:page', {
          inputs: window.flatMap(value => (value.kind === 'inputs' ? [value.item] : [])),
          dependencies: window.flatMap(value => (value.kind === 'dependencies' ? [value.item] : [])),
        }),
      );
      invariant(
        page.inputs.length === window.filter(value => value.kind === 'inputs').length &&
          page.dependencies.length === window.filter(value => value.kind === 'dependencies').length,
        'SOURCE_UNAVAILABLE',
        'The selected source page is incomplete.',
      );
      for (const [kind, entries] of [
        ['inputs', page.inputs],
        ['dependencies', page.dependencies],
      ] as const)
        for (const value of entries) {
          intentId ??= value.intentId;
          (kind === 'inputs' ? inputs : dependencies).push(
            (kind === 'inputs' ? composeLaneSchema : composeDependencySchema).parse(value.entry),
          );
        }
    }
    const a = buildComposePages(inputs),
      b = buildComposePages(dependencies);
    const request = composeRequestSchema.parse({
      operationId,
      intentId,
      authorityEpoch: session.capabilities.authority.epoch,
      expectedMain: { head: main.head, receiptId: main.receipt.id },
      inputs: a.manifest,
      dependencies: b.manifest,
      message: command.message,
    });
    const pages = [a, b].flatMap((group, index) =>
      group.pages.map((page, i) => ({ ...page, kind: index ? 'dependencies' : 'inputs', index: i })),
    );
    return { request, pages };
  });
  return driveAgentSource(session, 'Compose', operationId, prepared.request, prepared.pages);
}
/** The rebuilt sync was refused again: nothing began on the server. */
export class SyncPinsStale extends ForgeError {
  constructor(root: string, message: string) {
    const save = { message: 'Bring the Lane binding up to date' };
    // A recovery is surfaced as is: the next step is a save, not a replay of the refused sync.
    super('WORK_STALE', message, undefined, {
      next: { action: 'save', ...save },
      command: `nforge agent ${shellQuote(root)} save ${shellQuote(JSON.stringify(save))}`,
    });
  }
}
/** A source prepare the server refused before any operation began. */
export class PrepareRefused extends Error {
  constructor(readonly refusal: unknown) {
    super(refusal instanceof Error ? refusal.message : String(refusal));
  }
}
/** Sync pins the Lane once per operation. When the server refuses those pins before the operation
 * began (the Lane moved: a save finished after this request was retained), the retained request is
 * dropped and rebuilt once from current pins; it is never replayed stale again. */
export async function syncAgentSource(
  session: HostedAgentSession,
  command: z.infer<typeof hostedAgentCommandSchemas.sync>,
  operationId: string,
  refreshPins?: () => Promise<void>,
) {
  try {
    return await syncAgentSourceOnce(session, command, operationId);
  } catch (error) {
    if (!(error instanceof PrepareRefused)) throw error;
    session.journal.forget(`sync:${operationId}`);
    if (command.candidateId) throw error.refusal;
    await refreshPins?.();
    try {
      return await syncAgentSourceOnce(session, command, operationId);
    } catch (again) {
      if (!(again instanceof PrepareRefused)) throw again;
      session.journal.forget(`sync:${operationId}`);
      const selection = session.marker()?.selection;
      throw new SyncPinsStale(
        session.root,
        `The Lane moved past this checkout's binding${selection ? ` (head ${selection.head.slice(0, 12)}, version ${selection.version})` : ''}. Nothing was synced. Run save in this checkout (it brings the binding to the Lane's current version, keeping your edits), then retry this same sync; it rebuilds its pins.`,
      );
    }
  }
}
async function syncAgentSourceOnce(
  session: HostedAgentSession,
  command: z.infer<typeof hostedAgentCommandSchemas.sync>,
  operationId: string,
) {
  const request = await session.journal.retain(`sync:${operationId}`, async () => {
    if (command.candidateId) {
      invariant(
        !command.target && !command.laneId && command.ontoMain === undefined,
        'BAD_ARGUMENT',
        'Select one conflicted Candidate or a Lane sync target.',
      );
      const candidate = hostedRecordSchema.options[3].parse(
        await session.query('projectHostedCompose:candidate', { candidateId: command.candidateId }),
      );
      invariant(
        candidate.result.status === 'conflict',
        'VIEW_CONFLICT',
        'Select the exact conflicted Candidate.',
      );
      return syncRequestSchema.parse({
        kind: 'resolution',
        operationId,
        authorityEpoch: session.capabilities.authority.epoch,
        candidateId: candidate.id,
        conflicts: candidate.result.conflicts,
        message: command.message,
      });
    }
    const marker = session.marker(),
      lane: HostedLaneSelection =
        marker && (!command.laneId || command.laneId === marker.selection.laneId)
          ? marker.selection
          : await selectAgentLane(session, command.laneId);
    const main = command.target ? null : await session.main();
    return syncRequestSchema.parse({
      kind: 'sync',
      ...(command.ontoMain === undefined ? {} : { ontoMain: command.ontoMain }),
      operationId,
      authorityEpoch: session.capabilities.authority.epoch,
      laneId: lane.laneId,
      expected: saveExpectedSchema.parse({
        head: lane.head,
        version: lane.version,
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: lane.lifecycleVersion,
      }),
      target: command.target ?? { kind: 'main', head: main!.head, receiptId: main!.receipt.id },
      message: command.message,
    });
  });
  return driveAgentSource(session, 'Sync', operationId, request, [], true);
}
