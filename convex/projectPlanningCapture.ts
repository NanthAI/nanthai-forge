// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './server';
import { parseWork } from '../src/work-unified-types';
import { applyPlanningMetadata, stampPlanningAuthor } from '../src/work-planning-state';
import { planningItemSchema, planningPutSchema } from '../src/work-planning-types';
import { hostedRecordValue } from '../src/hosted-records';
import { workStoreRecord } from '../src/work-store-records';
import { invariant } from '../src/errors';
import { serverPutWriter } from './planningCommentWriter';
import { storeVersion } from './projectWorkStore';
import { recordVersion } from './projectHostedRecords';

type CaptureFields = {
  itemId: string;
  operationId: string;
  title: string;
  agent?: string | undefined;
  agentClient?: string | undefined;
};

const creationCommand = (fields: CaptureFields) =>
  planningPutSchema.parse({
    ...fields,
    action: 'put-planning-item',
    expectedVersion: 0,
    kind: 'issue',
    status: 'in-progress',
    hidden: true,
    reason: 'Captured on Lane start',
  });

function creationRecord(
  generation: Doc<'projectWorkGenerations'>,
  command: ReturnType<typeof creationCommand>,
  at: string,
  actor: string,
) {
  const work = parseWork(
    {
      schema: JSON.parse(generation.metadata).schema,
      revision: generation.revision,
      intents: [],
      lanes: [],
      views: [],
    },
    true,
  );
  applyPlanningMetadata(work, command, at);
  stampPlanningAuthor(work, 0, command, actor);
  return hostedRecordValue(workStoreRecord('planningVersions', work.planningItems[0]!));
}

/** Only the immutable, per-Item record belongs in the start transaction. */
export async function stagePlanningCapture(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  input: CaptureFields & { at: string },
) {
  const { at, ...fields } = input;
  const attributed = creationCommand(fields);
  await serverPutWriter(ctx, attributed);
  const command = planningPutSchema.parse(attributed);
  const stored = await storeVersion(
    ctx,
    project,
    creationRecord(generation, command, at, project.owner),
    undefined,
    true,
    { at, command: JSON.stringify(command), state: 'pending' },
  );
  invariant(stored === 'copied', 'ITEM_CHANGED', 'The captured Item already exists.');
}

function parsedJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Verify the immutable birth before touching shared Work. Reconstruct a damaged command
 * only when the canonical version proves the exact result of replaying it. */
export async function verifiedCapture(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  head: Doc<'projectHostedRecordHeads'>,
) {
  const capture = head.pendingPlanningCapture;
  if (!capture || !head.value || head.version !== 1) return null;
  const item = planningItemSchema.safeParse(parsedJson(head.value));
  if (!item.success || item.data.id !== head.key || item.data.at !== capture.at) return null;
  const version = await recordVersion(ctx, project._id, 'issue', head.key, 1);
  if (version?._id !== head.recordId || version.purged || !(await ctx.db.get(version.bodyId))) return null;
  const original = planningPutSchema.safeParse(parsedJson(capture.command));
  const reconstructed = creationCommand({
    itemId: item.data.id,
    operationId: item.data.operationId,
    title: item.data.title,
    agent: item.data.agent,
    agentClient: item.data.agentClient,
  });
  for (const command of [original.success ? original.data : reconstructed, reconstructed]) {
    if (
      command.itemId !== head.key ||
      command.operationId !== item.data.operationId ||
      command.expectedVersion
    )
      continue;
    try {
      const encoded = creationRecord(generation, command, capture.at, project.owner);
      if (encoded.ref.digest === version.digest && encoded.ref.bytes === version.bytes)
        return { at: capture.at, operationId: command.operationId, command: JSON.stringify(command) };
    } catch {
      // A damaged command that no longer reduces can still be rebuilt from the immutable version.
    }
  }
  return null;
}
