// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { saveCheckSetting } from './projectHostedCheckDefinitions';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { checkHash, checkNumber, importedHostedCheck } from '../src/hosted-check';
import { invariant } from '../src/errors';
import { assembleIndexValue, type IndexHeader } from '../src/work-index-value';
import { report } from './errors';

/** Projects hold a handful of checks; a larger set must be imported by id. */
export const WORK_CHECK_SCAN = 200;
const requestSchema = z
  .object({
    operationId: z.uuid(),
    authorityEpoch: checkNumber,
    expected: checkHash.nullable(),
    select: z.union([
      z.object({ name: z.string().min(1).max(200) }).strict(),
      z.object({ checkId: z.uuid() }).strict(),
    ]),
  })
  .strict();
/** Imports a check definition from the project's hosted Work inside the mutation,
 * so the client never supplies the definition or its digest. */
export const fromWork = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = requestSchema.parse(JSON.parse(input.request));
      return await saveCheckSetting(ctx, input.projectId, request, request, async project => {
        const generation = await selectedGeneration(ctx, project);
        invariant(
          generation,
          'WORK_STALE',
          'This project has no ready hosted Work to import a check from. Define the check from a command instead.',
        );
        const partition = recordPartition(generation);
        let rows;
        if ('checkId' in request.select) {
          const row = await record(ctx, partition, 'checks', request.select.checkId);
          rows = row ? [row] : [];
        } else {
          rows = await ctx.db
            .query('projectWorkRecords')
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
        const wanted = 'name' in request.select ? request.select.name : null;
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
                  .query('projectWorkRecords')
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
        const check = importedHostedCheck(found);
        return { kind: 'definition', key: check.id, value: check, digest: check.definition };
      });
    } catch (error) {
      return report(error);
    }
  },
});
