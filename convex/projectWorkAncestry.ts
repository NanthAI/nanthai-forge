// SPDX-License-Identifier: Apache-2.0
'use node';
import { internalAction, type ActionCtx } from './_generated/server';
import { archiveSource, archiveRef } from './r2ArchiveSource';
import { v } from 'convex/values';
import { reviewPaths } from '../src/native-source-review';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { exchangeObjectReader } from './projectExchangeReader';
import { indexReadContext, indexReadFailure } from './projectWorkIndexRetry';
import { gitBundleParents } from '../src/git-bundle-parents';
import type { ProvenanceFile } from '../src/view-provenance-plan';
import { parseNativeState } from '../src/native-source';
import { workArchiveMetadata, workSourcePins, type sourceManifestSchema } from '../src/work-archive-metadata';
import type { WorkData } from '../src/work-types';
import type { z } from 'zod';
import { digest } from '../src/hash';
import { exchangeRequest } from '../src/exchange-request';
import { invariant } from '../src/errors';
import { noteStorageRead } from './storageMeter';
const statePin = v.object({ sha256: v.string(), size: v.number() });
const stateFile = v.object({
  path: v.string(),
  blob: v.string(),
  mode: v.union(v.literal('file'), v.literal('executable'), v.literal('symlink'), v.literal('gitlink')),
});
/** Parsing allocations end with this invocation, rather than accumulating in
 * the coordinator's V8 heap across the entire historical source closure. */
export const stateBatch = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    pins: v.array(statePin),
    paths: v.optional(v.array(v.string())),
  },
  returns: v.array(
    v.object({ head: v.string(), parents: v.array(v.string()), files: v.optional(v.array(stateFile)) }),
  ),
  handler: async (ctx, input) => {
    ctx = indexReadContext(ctx);
    const reader = exchangeObjectReader(ctx, false, 0),
      paths = input.paths ? new Set(input.paths) : undefined;
    const result: {
      head: string;
      parents: string[];
      files?: { path: string; blob: string; mode: 'file' | 'executable' | 'symlink' | 'gitlink' }[];
    }[] = [];
    for (let offset = 0; offset < input.pins.length;) {
      const pins: { sha256: string; size: number }[] = [];
      let bytes = 0;
      while (offset < input.pins.length && pins.length < 100) {
        const pin = input.pins[offset]!;
        if (pins.length && bytes + pin.size > 2 * 1024 * 1024) break;
        pins.push(pin);
        bytes += pin.size;
        offset++;
      }
      const bodies = await reader.read(input.projectId, input.actor, pins);
      for (const [index, pin] of pins.entries()) {
        const state = parseNativeState(bodies[index]!);
        result.push({
          head: pin.sha256,
          parents: state.parents,
          ...(paths ? { files: state.files.filter(file => paths.has(file.path)) } : {}),
        });
      }
    }
    return result;
  },
});
export const changedStates = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    before: statePin,
    after: statePin,
    pins: v.optional(v.array(statePin)),
  },
  returns: v.object({
    before: v.array(stateFile),
    after: v.array(stateFile),
    paths: v.array(v.string()),
    states: v.optional(v.array(v.object({ head: v.string(), files: v.array(stateFile) }))),
  }),
  handler: async (ctx, input) => {
    ctx = indexReadContext(ctx);
    const reader = exchangeObjectReader(ctx, false, 0);
    const pins = [input.before, input.after];
    let size = input.before.size + input.after.size;
    for (const pin of input.pins ?? []) {
      if (pins.some(p => p.sha256 === pin.sha256)) continue;
      if (pins.length >= 100 || size + pin.size > 2 * 1024 * 1024) break;
      pins.push(pin);
      size += pin.size;
    }
    let bodies: Buffer[];
    try {
      bodies = await reader.read(input.projectId, input.actor, pins);
    } catch (error) {
      if (indexReadFailure(ctx, error)) throw error;
      if (pins.length === 2) throw error;
      // Extra provenance is optional. Do not lose the available base/head diff
      // when one save is unavailable; the caller retains its ordinary fallback.
      pins.length = 2;
      bodies = await reader.read(input.projectId, input.actor, pins);
    }
    const before = parseNativeState(bodies[0]!).files,
      after = parseNativeState(bodies[1]!).files;
    const paths = new Set(
      reviewPaths(before, after)
        .filter(file => file.status !== 'unchanged')
        .map(file => file.path),
    );
    return {
      before: before.filter(file => paths.has(file.path)),
      after: after.filter(file => paths.has(file.path)),
      paths: [...paths],
      ...(input.pins
        ? {
            states: pins.slice(2).flatMap((pin, i) => {
              try {
                return [
                  {
                    head: pin.sha256,
                    files: parseNativeState(bodies[i + 2]!).files.filter(file => paths.has(file.path)),
                  },
                ];
              } catch (error) {
                if (indexReadFailure(ctx, error)) throw error;
                // A malformed optional save has the same incomplete-provenance
                // fallback as an unavailable save; base/head remain usable.
                return [];
              }
            }),
          }
        : {}),
    };
  },
});
/** Derived once per source generation, never traversed by a cockpit read. */
async function readParents(
  ctx: ActionCtx,
  backup: Doc<'projectBackups'>,
  manifest: z.infer<typeof sourceManifestSchema>,
  data: WorkData,
  actor: string,
  retainFiles = true,
) {
  const parents = Object.assign(new Map<string, string[]>(), { files: new Map<string, ProvenanceFile[]>() });
  if (!data.views.length && !data.runs.length) return parents;
  const pins = new Map(manifest.files.map(f => [f.path, f]));
  const remember = (head: string, bytes: Uint8Array) => {
    const pin = pins.get(manifest.kind === 'forge-native-work-backup' ? `objects/${head}` : 'source.bundle');
    invariant(
      pin &&
        (manifest.kind !== 'forge-native-work-backup' || pin.sha256 === head) &&
        bytes.length === pin.size &&
        digest(bytes) === pin.sha256,
      'INVALID_NATIVE_SOURCE',
      'Ancestry State differs from its retained source identity.',
    );
    if (manifest.kind === 'forge-native-work-backup') {
      const state = parseNativeState(Buffer.from(bytes));
      parents.set(head, state.parents);
      if (retainFiles) parents.files.set(head, state.files);
    } else
      for (const [id, values] of gitBundleParents(Buffer.from(bytes), manifest.format))
        parents.set(id, values);
  };
  if (backup.transport === 'objects') {
    const reader = exchangeObjectReader(ctx),
      pending = manifest.kind === 'forge-native-work-backup' ? workSourcePins(data) : ['source.bundle'];
    const queued = new Set(pending);
    while (pending.length) {
      const heads: string[] = [];
      let bytesInBatch = 0;
      while (pending.length && heads.length < 100) {
        const head = pending[0]!,
          size = pins.get(`objects/${head}`)?.size ?? 0;
        if (heads.length && bytesInBatch + size > 2 * 1024 * 1024) break;
        pending.shift();
        if (parents.has(head)) continue;
        heads.push(head);
        bytesInBatch += size;
      }
      if (!heads.length) continue;
      const selected = heads.map(head => {
        const pin = pins.get(
          manifest.kind === 'forge-native-work-backup' ? `objects/${head}` : 'source.bundle',
        );
        invariant(pin, 'SOURCE_UNAVAILABLE', 'An ancestry State is unavailable in this checkpoint.');
        return pin;
      });
      // The reader retains H5's exact-byte memo and fresh authorization on every
      // batch. Seed from every Work pin, then visit only unseen parent frontiers.
      if (!retainFiles && manifest.kind === 'forge-native-work-backup') {
        const summaries: { head: string; parents: string[] }[] = await ctx.runAction(
          internal.projectWorkAncestry.stateBatch,
          {
            projectId: backup.projectId,
            actor,
            pins: selected.map(({ sha256, size }) => ({ sha256, size })),
          },
        );
        for (const summary of summaries) {
          parents.set(summary.head, summary.parents);
          for (const parent of summary.parents)
            if (!queued.has(parent)) {
              queued.add(parent);
              pending.push(parent);
            }
        }
        continue;
      }
      const bytes = await reader.read(backup.projectId, actor, selected);
      for (const [index, head] of heads.entries()) {
        remember(head, bytes[index]!);
        if (manifest.kind === 'forge-native-work-backup')
          for (const parent of parents.get(head)!)
            if (!queued.has(parent)) {
              queued.add(parent);
              pending.push(parent);
            }
      }
    }
  } else {
    const url = await (await archiveSource(ctx, archiveRef(backup))).getUrl();
    invariant(url, 'SOURCE_UNAVAILABLE', 'Ancestry source archive is unavailable.');
    await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: actor });
    // The optional ancestry read must also yield on a silent archive response.
    await exchangeRequest(
      'archive ancestry download',
      url,
      { headers: { 'accept-encoding': 'identity' } },
      async (response, progressed) => {
        try {
          invariant(
            response.ok && response.body,
            'SOURCE_UNAVAILABLE',
            'Ancestry source archive is unavailable.',
          );
          noteStorageRead(ctx, backup.size);
          await workArchiveMetadata(
            response.body,
            {
              select: (name, prefix) =>
                manifest.kind === 'forge-native-work-backup'
                  ? /^objects\/[a-f0-9]{64}$/.test(name) &&
                    new TextDecoder().decode(prefix).includes('"kind":"forge-source-state"')
                  : name === 'source.bundle',
              read: (name, bytes) => remember(name.slice(8), bytes),
            },
            progressed,
          );
        } finally {
          if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
        }
      },
      { retries: 1 },
    );
  }
  await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: actor });
  return parents;
}

/** Ancestry is optional derived data; unavailable bytes do not deny retained Work
 * reads. Null membership is explicit. A fresh authorization check still fails
 * after revocation, including when the source read itself failed. */
export async function sourceParents(
  ctx: ActionCtx,
  backup: Doc<'projectBackups'>,
  manifest: z.infer<typeof sourceManifestSchema>,
  data: WorkData,
  actor: string,
  retainFiles = true,
) {
  try {
    return await readParents(ctx, backup, manifest, data, actor, retainFiles);
  } catch (error) {
    if (indexReadFailure(ctx, error)) throw error;
    await ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner: actor });
    return new Map<string, string[]>();
  }
}
