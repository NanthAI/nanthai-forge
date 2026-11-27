// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import { bytesFromRow } from './projectExchangeReader';
import { renderCheckpointSource } from './projectSourceReview';
import { report } from './errors';
import { invariant } from '../src/errors';
import { landingLineOrigins } from '../src/code-line-origins';
import { safeRelative } from '../src/safe-relative';
import { CODE_DIR_DEPTH } from '../src/code-tree';
import { parseNativeState } from '../src/state/format';
import { SHOW_MAX_BYTES } from '../src/source-review-format';

const sha = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 9_200_000;
const MAX_PAIRS = 4;

/** One explicit line-history read for the selected file, not one read per line. Returns only indexes into the
 * existing file-history results, never other source bytes, landing metadata or storage addresses. */
export const read = action({
  args: {
    projectId: v.id('hostedProjects'),
    path: v.string(),
    blob: v.string(),
    pairs: v.array(v.object({ base: v.string(), head: v.string() })),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, path, blob, pairs }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read line history.');
      const states = [...new Set(pairs.flatMap(pair => [pair.base, pair.head]))];
      invariant(
        pairs.length > 0 &&
          pairs.length <= MAX_PAIRS &&
          sha.test(blob) &&
          states.every(s => sha.test(s)) &&
          safeRelative(path) &&
          path.split('/').length <= CODE_DIR_DEPTH + 1,
        'BAD_ARGUMENT',
        'Choose a file and up to four landing transitions.',
      );
      const { rows, backupId } = await ctx.runQuery(internal.projectCode.lineStates, { projectId, states });
      const render = async (
        fetchState: (hash: string, index: number) => Promise<Buffer | null>,
        fetchBlobs: (ids: string[]) => Promise<(id: string) => Promise<Buffer | null>>,
      ) => {
        const files = new Map<string, string | null>();
        for (const [index, hash] of states.entries()) {
          const bytes = await fetchState(hash, index);
          if (!bytes || bytes.length > MAX_STATE_BYTES) break;
          const file = parseNativeState(bytes).files.find(file => file.path === path);
          if (file && file.mode !== 'file' && file.mode !== 'executable') break;
          files.set(hash, file?.blob ?? null);
        }
        const transitions = [];
        const blobs = new Set<string>([blob]);
        let expected: string | null = blob;
        for (const { base, head } of pairs) {
          const before = files.get(base),
            after = files.get(head);
          if (before === undefined || after === undefined || after !== expected) break;
          transitions.push({ before, after });
          if (!before) break;
          blobs.add(before);
          expected = before;
        }
        if (!transitions.length) return { origins: [] };
        const origins = await landingLineOrigins(blob, transitions, await fetchBlobs([...blobs]));
        return { origins };
      };
      const fetchRegisteredBlobs = async (ids: string[]) => {
        const objects = await ctx.runQuery(internal.projectObjects.resolve, {
          projectId,
          actor: user.subject,
          digests: ids,
        });
        const byBlob = new Map(ids.map((id, index) => [id, objects[index]!] as const));
        return async (id: string) => {
          const row = byBlob.get(id);
          return row && row.size <= SHOW_MAX_BYTES
            ? bytesFromRow(ctx, row, { sha256: id, size: row.size }, user.subject, true)
            : null;
        };
      };
      let result: { origins: (number | null)[] };
      const first = pairs[0]!;
      if (rows[states.indexOf(first.base)] && rows[states.indexOf(first.head)]) {
        result = await render((sha256, index) => {
          const row = rows[index];
          if (!row || row.size > MAX_STATE_BYTES) return Promise.resolve(null);
          return bytesFromRow(ctx, row, { sha256, size: row.size }, user.subject, true);
        }, fetchRegisteredBlobs);
      } else if (backupId) {
        // The retained checkpoint reader can pin the newest transition, without reopening the archive per pair.
        const retained = await renderCheckpointSource(
          ctx,
          { projectId, backupId, base: first.base, head: first.head },
          user.subject,
          true,
          async read => {
            const pins = [...new Set([first.base, first.head])];
            const bodies = await read(pins, MAX_STATE_BYTES);
            return render(
              async hash => bodies[pins.indexOf(hash)] ?? null,
              async ids => {
                const values = await read(ids, SHOW_MAX_BYTES);
                return async id => values[ids.indexOf(id)] ?? null;
              },
            );
          },
        );
        result = retained.available ? retained : { origins: [] };
      } else {
        result = { origins: [] };
      }
      await ctx.runQuery(internal.projectCode.lineStates, { projectId, states: [] });
      return JSON.stringify({ origins: result.origins });
    } catch (error) {
      return report(error);
    }
  },
});
