// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { caller, load } from './projectWorkActions';
import { exchangeObjectReader } from './projectExchangeReader';
import { workSourcePins } from '../src/work-archive-metadata';
import { parseNativeState } from '../src/native-source';
import { invariant } from '../src/errors';
import { report } from './errors';
/** Prepares only derived path/parent metadata. Never reads file blobs or executes repository code. */
export const prepare = action({
  args: { projectId: v.id('hostedProjects') },
  returns: v.object({ available: v.boolean(), states: v.number(), reason: v.string() }),
  handler: async (ctx, { projectId }) => {
    try {
      const actor = await caller(ctx),
        reader = exchangeObjectReader(ctx);
      const snapshot = await load(ctx, projectId, actor, reader);
      if (snapshot.manifest.kind !== 'forge-native-work-backup' || snapshot.backup.transport !== 'objects')
        return {
          available: false,
          states: 0,
          reason: 'Path metadata for archive/Git checkpoints is available through local brief.',
        };
      const pins = new Map(snapshot.manifest.files.map(f => [f.path, f]));
      const pending = workSourcePins(snapshot.data),
        seen = new Set<string>();
      while (pending.length) {
        const head = pending.pop()!;
        if (seen.has(head)) continue;
        seen.add(head);
        const pin = pins.get(`objects/${head}`);
        invariant(
          pin?.sha256 === head,
          'SOURCE_UNAVAILABLE',
          'A briefing State is not retained in this checkpoint.',
        );
        const [bytes] = await reader.read(projectId, actor, [pin]);
        const state = parseNativeState(bytes!);
        pending.push(...state.parents);
        // Parts fit provider document limits; this is not a source path quota.
        const chunks: (typeof state.files)[] = [];
        let chunk: typeof state.files = [],
          size = 0;
        for (const file of state.files) {
          const length = Buffer.byteLength(JSON.stringify(file));
          if (chunk.length && size + length > 200000) {
            chunks.push(chunk);
            chunk = [];
            size = 0;
          }
          chunk.push(file);
          size += length;
        }
        chunks.push(chunk);
        for (let part = 0; part < chunks.length; part++)
          await ctx.runMutation(internal.projectBriefingSources.put, {
            projectId,
            backupId: snapshot.backup._id,
            actor,
            head,
            part,
            value: JSON.stringify({ parents: state.parents, parts: chunks.length, files: chunks[part] }),
          });
        await ctx.runMutation(internal.projectBriefingSources.put, {
          projectId,
          backupId: snapshot.backup._id,
          actor,
          head,
          part: -1,
          value: JSON.stringify({ parents: state.parents, parts: chunks.length }),
        });
      }
      await ctx.runQuery(internal.projectWork.get, { projectId, owner: actor });
      return { available: true, states: seen.size, reason: '' };
    } catch (error) {
      return report(error);
    }
  },
});
