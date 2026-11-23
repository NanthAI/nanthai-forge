// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ConvexError } from 'convex/values';
import { hostedAgentCommandSchemas, type HostedAgentAddress } from './hosted-agent-contract.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { selectAgentLane } from './hosted-agent-source.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { applyHostedSync } from './hosted-sync-client.js';
import { undoReceiptSchema, undoRequestSchema } from './hosted-undo.js';
import { parseHostedResponse } from './hosted-response.js';
import { ForgeError, invariant } from './errors.js';
import { openLaneRoot, SELECT_LANE } from './hosted-lane-location.js';
import { markerAt } from './hosted-apply-recovery-records.js';
import { saveExpectedSchema } from './hosted-save.js';
import { laneUndo } from './hosted-contract-features.js';
import { hostedLaneSelectionSchema, type HostedLaneSelection } from './hosted-lane.js';

/** An unknown result has no received version and always retries the original operation. */
export async function undoReplaySelection(
  root: string,
  address: HostedAgentAddress,
  actor: string,
  command: unknown,
  readLane: (laneId: string) => Promise<unknown>,
) {
  const prior = HostedAgentJournal.previous(root, address, actor, 'undo', command);
  const version = prior?.values['undo-received'];
  const plan = prior?.values['undo-request'] as
    | { applyRoot: string | null; request: { laneId: string } }
    | undefined;
  if (typeof version !== 'number' || !plan) return null;
  const laneId = plan.request.laneId;
  const selected = hostedAgentCommandSchemas.undo.parse(command).laneId ?? markerAt(root)?.selection.laneId;
  if (selected && selected !== laneId) return { fresh: true };
  if (plan.applyRoot) {
    const local = markerAt(plan.applyRoot)?.selection;
    return { fresh: local?.laneId === laneId && local.version > version };
  }
  const selection = parseHostedResponse(hostedLaneSelectionSchema, await readLane(laneId));
  invariant(
    selection.laneId === laneId && selection.projectId === address.projectId,
    'HOSTED_PROTOCOL_INVALID',
    'The undo selection differs from the requested Lane.',
  );
  return { fresh: selection.version > version, selection };
}

class UndoLaneTransport extends ConvexLaneTransport {
  constructor(
    exchange: HostedAgentSession['exchange'],
    private readonly target: HostedLaneSelection,
  ) {
    super(exchange);
  }

  override async select(laneId: string) {
    const selection = await super.select(laneId);
    const current = saveExpectedSchema.parse(selection);
    const expected = saveExpectedSchema.parse(this.target);
    if (canonicalPayload(current) !== canonicalPayload(expected))
      throw new ForgeError(
        'WORK_STALE',
        'The Lane advanced after undo. The checkout still holds its own source.',
        undefined,
        {
          obstruction: { kind: 'superseded', path: null },
          superseded: { expected, current },
        },
      );
    return selection;
  }
}

export async function executeHostedUndo(session: HostedAgentSession, input: unknown) {
  const command = hostedAgentCommandSchemas.undo.parse(input);
  invariant(
    session.capabilities.features?.includes(laneUndo),
    'HOSTED_FEATURE_UNAVAILABLE',
    'This Forge server does not support undoing a Lane save yet.',
  );
  const plan = await session.journal.retain('undo-request', async () => {
    const marker = session.marker(),
      laneId = command.laneId ?? marker?.selection.laneId;
    invariant(laneId, 'BAD_ARGUMENT', SELECT_LANE);
    const root = marker?.selection.laneId === laneId ? session.root : openLaneRoot(session, laneId);
    const local = root === session.root ? marker?.selection : root ? markerAt(root)?.selection : undefined;
    const selection =
      (command.apply ? local : undefined) ??
      session.undoSelection ??
      (await selectAgentLane(session, laneId));
    return {
      applyRoot: command.apply && local ? root : null,
      request: undoRequestSchema.parse({
        kind: 'undo',
        operationId: session.journal.operationId,
        laneId,
        authorityEpoch: session.capabilities.authority.epoch,
        ...(session.holderSessionId ? { holderSessionId: session.holderSessionId } : {}),
        expected: saveExpectedSchema.parse(selection),
        ...(command.saveId === undefined ? {} : { saveId: command.saveId }),
        ...(command.version === undefined ? {} : { version: command.version }),
      }),
    };
  });
  const wire = { request: canonicalPayload(plan.request) };
  let value: unknown;
  try {
    value = await session.mutation('projectHostedUndo:undo', wire);
  } catch (error) {
    if (!(error instanceof ConvexError) || error.data?.undoHistory !== true) throw error;
    value = await session.action('projectHostedUndoArchive:undo', wire);
  }
  const receipt = parseHostedResponse(undoReceiptSchema, value);
  invariant(
    receipt.operationId === plan.request.operationId &&
      receipt.lane.laneId === plan.request.laneId &&
      receipt.lane.projectId === session.address.projectId &&
      receipt.from.laneId === plan.request.laneId &&
      receipt.from.head === plan.request.expected.head &&
      receipt.from.version === plan.request.expected.version &&
      receipt.from.sourceVersion === plan.request.expected.sourceVersion &&
      receipt.from.lifecycleVersion === plan.request.expected.lifecycleVersion &&
      receipt.lane.head === receipt.restored.head,
    'HOSTED_PROTOCOL_INVALID',
    'The undo receipt differs from the original Lane selection.',
  );
  await session.journal.retain('undo-received', () => receipt.lane.version);
  if (!plan.applyRoot) return receipt;
  try {
    const applied = await applyHostedSync(
      plan.applyRoot,
      {
        operationId: await session.journal.id('undo-apply'),
        url: session.address.url,
        from: {
          laneId: receipt.from.laneId,
          head: receipt.from.head,
          version: receipt.from.version,
          sourceVersion: receipt.from.sourceVersion,
        },
        lane: receipt.lane,
        status: receipt.from.head === receipt.lane.head ? 'up-to-date' : 'merged',
      },
      new UndoLaneTransport(session.exchange, receipt.lane),
    );
    return { ...receipt, applied };
  } catch (error) {
    if (error instanceof ForgeError && error.recovery?.sourceCompleted)
      throw new ForgeError(error.code, error.message, error.retryAt, {
        ...error.recovery,
        operationId: receipt.operationId,
        completed: receipt,
      });
    throw error;
  }
}
