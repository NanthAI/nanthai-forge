// SPDX-License-Identifier: Apache-2.0
import { sourceSeedPageSize } from '../src/source-object-window';
import { assertSourceStateSize } from '../src/source-state-size';
import { v } from 'convex/values';
import { activeStep } from './projectConvexSourceStore';
import { physicalSourceBinding } from './projectConvexPhysicalManifest';
import { saveObjects } from './projectHostedSaveStore';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { isStored } from './projectObjectFields';
import { invariant } from '../src/errors';
import { sourceMutation } from './projectConvexSourceErrors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { signRecipeClosure } from './projectRecipeClosure';
import { presignGet, r2Config } from './r2';
import {
  findStoredObject as findObject,
  findStoredObjects as findObjects,
  type ObjectView,
} from './projectObjectFind';
import { packRange, packHeaders } from '../src/object-pack-range';
const identity = { projectId: v.id('hostedProjects'), jobId: v.string(), step: v.number() };
/** Object storage locations stay inside the trusted action. No worker HTTP
 * grant, callback ingress, HMAC, Modal credential or repository URL is involved. */
export const resolve = sourceMutation({
  args: {
    ...identity,
    digests: v.array(v.string()),
    ancestry: v.boolean(),
    sizePhase: v.optional(
      v.union(v.literal('save'), v.literal('sync'), v.literal('compose'), v.literal('conflict-sync')),
    ),
    states: v.optional(v.array(v.string())),
    probe: v.optional(v.boolean()),
    known: v.array(v.string()),
    windows: v.optional(v.number()),
    seed: v.optional(v.literal(true)),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    invariant(
      !args.windows || (Number.isInteger(args.windows) && args.windows >= 1 && args.windows <= 4),
      'SOURCE_JOB_INVALID',
      'Prepare bounded source windows.',
    );
    const active = await activeStep(ctx, args);
    invariant(active, 'SOURCE_JOB_FENCED', 'Source step advanced.');
    invariant(
      args.digests.length <= (args.seed ? sourceSeedPageSize : 100),
      'SOURCE_JOB_INVALID',
      'Resolve source in bounded windows.',
    );
    if (args.seed) {
      invariant(
        active.job.jobKind === 'compose' && active.row.physicalManifests && !args.ancestry && !args.probe,
        'SOURCE_JOB_INVALID',
        'Only the captured compose seed reads a physical inventory.',
      );
      const rows = await findObjects(ctx, args.projectId, args.digests);
      return canonicalPayload(
        rows.map(row =>
          row && !row.removed && isStored(row)
            ? physicalSourceBinding(
                args.projectId,
                {
                  descriptor: {
                    object: { sha256: row.digest, size: row.size },
                    recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
                  },
                  storageId: null,
                  url: null,
                  ...(row.pack ? { range: packRange(row)! } : {}),
                },
                row.r2Key,
              )
            : null,
        ),
      );
    }
    const project = await ctx.db.get(args.projectId),
      generation = project ? await selectedGeneration(ctx, project) : null;
    // Graph descriptor hints warm a bounded breadth-first page. Byte ordering
    // still comes only from authenticated parent edges in the caller.
    const pending = args.probe ? [...args.digests] : [...args.digests].reverse(),
      seen = new Set(args.known),
      selected: { row: ObjectView; url: string | null }[] = [],
      unavailable: string[] = [];
    let bytes = 0,
      position = 0,
      examined = 0;
    while (
      (args.probe ? position < pending.length : pending.length) &&
      examined < 100 * (args.windows ?? 1)
    ) {
      const id = args.probe ? pending[position++]! : pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      examined++;
      const row = await findObject(ctx, args.projectId, id);
      if (!row || row.removed || !isStored(row)) {
        if (args.digests.includes(id)) {
          if (args.probe) unavailable.push(id);
          else invariant(false, 'SOURCE_UNAVAILABLE', 'Exact source object is absent.');
        }
        continue;
      }
      // Ancestry hints can include States beyond the proven cut that are never
      // loaded. Guard exact body acquisitions, not metadata-only history walks.
      if (args.sizePhase && args.states?.includes(id) && !args.ancestry && !args.probe)
        assertSourceStateSize(args.sizePhase, row.stateSize);
      if (selected.length && bytes + row.size > 8 * 1024 * 1024 * (args.windows ?? 1)) break;
      bytes += row.size;
      const url =
        row.location === 'r2' && row.r2Key
          ? await presignGet(r2Config(), row.r2Key, packHeaders(packRange(row), row.size))
          : null;
      selected.push({ row, url });
      if (args.ancestry && row.stateParents) pending.push(...row.stateParents);
      else if (args.ancestry && generation) {
        // Hints batch a linear ancestry chain, but never establish closure.
        // Verified parents (the row's own, or the manifest's) drive every subsequent frontier.
        const hint = await record(ctx, recordPartition(generation), 'sourceStateParents', id);
        const parents = hint ? JSON.parse(hint.value).parents : undefined;
        if (Array.isArray(parents)) pending.push(...parents.filter((p: unknown) => typeof p === 'string'));
      }
    }
    // One reference mark and cleanup fence for the whole window, from rows read above.
    const descriptors = await saveObjects(
      ctx,
      args.projectId,
      selected.map(({ row }) => ({ sha256: row.digest })),
      selected.map(({ row }) => row),
    );
    const result = await Promise.all(
      selected.map(async ({ row, url }, i) => ({
        descriptor: descriptors[i]!,
        ...(row.stateGeneration === undefined ? {} : { stateGeneration: row.stateGeneration }),
        ...(row.stateSize === undefined ? {} : { stateSize: row.stateSize }),
        ...(row.stateParents === undefined ? {} : { stateParents: row.stateParents }),
        ...(row.statePhysical === undefined ? {} : { statePhysical: row.statePhysical }),
        storageId: url ? null : (row.storageId ?? null),
        url,
        ...(row.recipeClosure ? { closure: await signRecipeClosure(row) } : {}),
        ...(row.pack ? { range: packRange(row)! } : {}),
      })),
    );
    return canonicalPayload(
      args.probe
        ? { rows: result, unavailable }
        : args.ancestry
          ? result
          : args.digests.flatMap(id => result.filter(row => row.descriptor.object.sha256 === id)),
    );
  },
});
