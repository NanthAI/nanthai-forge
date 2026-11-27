// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { splitRecordTable } from './projectWorkRecordTables';
import { z } from 'zod';
import { v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { settingKey } from './projectSettingApprovals';
import { digest } from '../src/state/hash';
import { saveCheckSetting } from './projectHostedCheckDefinitions';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { checkHash, checkNumber, importedHostedCheck } from '../src/hosted-check';
import { invariant } from '../src/errors';
import { checkSchema } from '../src/work-types';
import { assembleIndexValue, type IndexHeader } from '../src/work-index-value';
import { report } from './errors';

/** Projects hold a handful of checks; a larger set must be imported by id. */
export const WORK_CHECK_SCAN = 200;
const requestFields = {
  operationId: z.uuid(),
  authorityEpoch: checkNumber,
  expected: checkHash.nullable(),
  select: z.union([
    z.object({ name: z.string().min(1).max(200) }).strict(),
    z.object({ checkId: z.uuid() }).strict(),
  ]),
};
/** What an agent or person sends: a selection only, never a definition. */
const requestSchema = z.object(requestFields).strict();
/** Item 16093ed1 F3: a held import as stored, with the definition resolved from Work when it was held. Only a grant
 * reads this form; it comes from the stored request, never from a caller. */
const heldSchema = z.object({ ...requestFields, pinned: checkSchema.strict() }).strict();
type Selection = z.infer<typeof requestSchema>['select'];
/** Imports a check definition from the project's hosted Work inside the mutation,
 * so the client never supplies the definition or its digest. */
export const fromWork = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return await importCheckFromWork(ctx, input.projectId, input.request);
    } catch (error) {
      return report(error);
    }
  },
});
/** The import itself; `approved` is the owner person's grant of an agent's held import (Issue 470ef29b). */
export async function importCheckFromWork(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  text: string,
  approved = false,
) {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  // A grant applies only the definition stored when the request was held (the one the owner saw), never what Work
  // holds by then. A request held before definitions were stored is refused rather than granted unseen.
  // A stored definition that no longer parses (the check shape changed since the hold) is stale the same way.
  const held = approved ? heldSchema.safeParse(parsed) : null;
  invariant(
    !held || held.success,
    'WORK_STALE',
    parsed.pinned === undefined
      ? 'This import was held before Forge stored the check it imports. Decline it and ask the agent to import again.'
      : 'The check stored with this import no longer matches the current check format. Decline it and ask the agent to import again.',
  );
  invariant(
    approved || parsed.pinned === undefined,
    'BAD_ARGUMENT',
    'Select the check by name or checkId; Forge reads its definition from hosted Work.',
  );
  const request = held?.success ? held.data : { ...requestSchema.parse(parsed), pinned: undefined };
  const { pinned, ...asked } = request;
  const hold = {
    origin: 'check-import' as const,
    // A name is free text; its digest keeps the request id a plain token.
    key: settingKey(
      'check-import',
      'checkId' in request.select ? request.select.checkId : digest(request.select.name).slice(0, 32),
    ),
    approved,
    pin: (project: Doc<'hostedProjects'>) => workCheck(ctx, project, request.select),
  };
  return await saveCheckSetting(
    ctx,
    projectId,
    request,
    asked,
    async project => {
      const check = pinned ?? (await workCheck(ctx, project, request.select));
      return { kind: 'definition', key: check.id, value: check, digest: check.definition };
    },
    hold,
  );
}

/** The selected check as hosted Work holds it now, hydrated in bounded payload pages. */
async function workCheck(ctx: MutationCtx, project: Doc<'hostedProjects'>, select: Selection) {
  const generation = await selectedGeneration(ctx, project);
  invariant(
    generation,
    'WORK_STALE',
    'This project has no ready hosted Work to import a check from. Define the check from a command instead.',
  );
  const partition = recordPartition(generation);
  let rows;
  if ('checkId' in select) {
    const row = await record(ctx, partition, 'checks', select.checkId);
    rows = row ? [row] : [];
  } else {
    rows = await ctx.db
      .query(splitRecordTable('checks'))
      .withIndex('by_generation_and_collection_and_position', q =>
        q.eq('generationId', partition).eq('collection', 'checks'),
      )
      .take(WORK_CHECK_SCAN);
    invariant(
      rows.length < WORK_CHECK_SCAN,
      'BAD_ARGUMENT',
      'This project has too many checks to select by name. Import the check by checkId.',
    );
  }
  const wanted = 'name' in select ? select.name : null;
  const headers = rows
    .map(row => JSON.parse(row.value) as { id: string; name: string; at: string } & IndexHeader)
    .filter(check => wanted === null || check.name === wanted);
  // Compact headers omit both command fields and the definition timestamp.
  // Hydrate only matching checks, in bounded payload pages, before selection.
  const checks = await Promise.all(
    headers.map(async header => {
      const parts: { position: number; value: string }[] = [];
      if (header.payloadKey)
        for (let offset = 0; offset < header.payloadParts!; offset += 100) {
          const page = await ctx.db
            .query(splitRecordTable('checks:payload'))
            .withIndex('by_generation_and_collection_and_parent_and_position', q =>
              q
                .eq('generationId', partition)
                .eq('collection', 'checks:payload')
                .eq('parent', header.payloadKey!)
                .gt('position', offset - 1),
            )
            .take(Math.min(100, header.payloadParts! - offset));
          parts.push(...page);
          if (page.length < Math.min(100, header.payloadParts! - offset)) break;
        }
      return assembleIndexValue('checks', header, parts, {
        incomplete: () => {
          invariant(false, 'WORK_STALE', 'The selected Work check payload is incomplete.');
        },
      });
    }),
  );
  // A redefined name keeps its newest definition, as local selection does.
  const found = checks.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  invariant(
    found,
    'CHECK_NOT_FOUND',
    `Hosted Work has no check ${wanted === null ? 'with that id' : `named "${wanted}"`}. Define it from a command instead.`,
  );
  return importedHostedCheck(found);
}
