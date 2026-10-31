// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { objectContent } from './projectObjectContent';
import type { ChunkPin } from '../src/object-chunks';
import { invariant } from '../src/errors';
import type { ObjectView } from './projectObjectFind';

/** Invocation-local descriptor window, never cached authorization. Each window
 * resolves under current access before IO and again after its consumed bytes.
 * Only descriptors are retained; objectContent still verifies each exact pin. */
export function recipeValidationReader(ctx: ActionCtx, projectId: Id<'hostedProjects'>, actor: string) {
  const rows = new Map<string, ObjectView>(),
    used = new Set<string>();
  const resolve = (digests: string[]): Promise<ObjectView[]> =>
    ctx.runQuery(internal.projectObjects.resolve, { projectId, actor, digests });
  const finish = async () => {
    if (used.size) await resolve([...used]);
    used.clear();
    rows.clear();
  };
  const prepare = async (pins: ChunkPin[]) => {
    if (rows.has(pins[0]!.sha256)) return;
    await finish();
    const digests = [...new Set(pins.slice(0, 100).map(pin => pin.sha256))];
    for (const row of await resolve(digests)) rows.set(row.digest, row);
  };
  const read = async (pin: ChunkPin) => {
    await prepare([pin]);
    const row = rows.get(pin.sha256);
    invariant(row, 'INVALID_WORK_BACKUP', 'Stored recipe content is unavailable.');
    const bytes = await objectContent(ctx, row, pin, actor);
    used.add(pin.sha256);
    return bytes;
  };
  return { read, prepare, finish };
}
