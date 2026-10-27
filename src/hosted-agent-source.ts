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
import { invariant } from './errors.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
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
) {
  const prepared = await session.mutation<SourceProgress>(`projectHosted${kind}:prepare`, {
    request: canonicalPayload(request),
  });
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
export async function syncAgentSource(
  session: HostedAgentSession,
  command: z.infer<typeof hostedAgentCommandSchemas.sync>,
  operationId: string,
) {
  const request = await session.journal.retain(`sync:${operationId}`, async () => {
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
  return driveAgentSource(session, 'Sync', operationId, request);
}
