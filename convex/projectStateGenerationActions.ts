// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { exchangeObjectReader } from './projectExchangeReader';
import { deriveStateGenerationPage, orderStateGenerationDependencies } from '../src/state/generation-page';
import { parseNativeState } from '../src/state/format';
import { invariant } from '../src/errors';
const operator = { projectId: v.id('hostedProjects'), actor: v.string(), operationId: v.string() };
type Schedule = {
  scan: string | null;
  deferred: { head: string; parents: string[] }[];
  queue?: string[];
  verifying?: boolean;
  sizes?: [string, number][];
};
type CompactSchedule = {
  scan: string | null;
  heads: string[];
  deferred: (number[] | null)[];
  queue: number[];
  verifying: boolean;
  sizes: (number | null)[];
};
function readSchedule(cursor: string | null): Schedule {
  if (!cursor?.startsWith('g1:')) {
    const prior = cursor ? JSON.parse(cursor) : null;
    return prior && 'scan' in prior ? prior : { scan: cursor, deferred: [] };
  }
  const packed: CompactSchedule = JSON.parse(
    inflateRawSync(Buffer.from(cursor.slice(3), 'base64')).toString('utf8'),
  );
  const heads = packed.heads.map(value => Buffer.from(value, 'base64').toString('hex'));
  let position = 0;
  return {
    scan: packed.scan,
    verifying: packed.verifying,
    queue: packed.queue.map(delta => heads[(position += delta)]!),
    sizes: packed.sizes.flatMap((size, i): [string, number][] => (size === null ? [] : [[heads[i]!, size]])),
    deferred: packed.deferred.flatMap((parents, i) =>
      parents === null
        ? []
        : [
            {
              head: heads[i]!,
              parents: parents.map(delta => heads[i + delta]!),
            },
          ],
    ),
  };
}
function saveSchedule(schedule: Schedule): string {
  const heads = [
    ...new Set([
      ...schedule.deferred.flatMap(state => [state.head, ...state.parents]),
      ...(schedule.queue ?? []),
      ...(schedule.sizes ?? []).map(([head]) => head),
    ]),
  ];
  const indexes = new Map(heads.map((head, i) => [head, i]));
  const head = (value: string) => indexes.get(value)!;
  const deferred = new Map(schedule.deferred.map(state => [state.head, state.parents])),
    sizes = new Map(schedule.sizes ?? []);
  let position = 0;
  const packed: CompactSchedule = {
    scan: schedule.scan,
    heads: heads.map(value => Buffer.from(value, 'hex').toString('base64')),
    verifying: schedule.verifying ?? false,
    queue: (schedule.queue ?? []).map(value => {
      const next = head(value),
        delta = next - position;
      position = next;
      return delta;
    }),
    sizes: heads.map(id => sizes.get(id) ?? null),
    deferred: heads.map((id, i) => deferred.get(id)?.map(parent => head(parent) - i) ?? null),
  };
  return 'g1:' + deflateRawSync(Buffer.from(JSON.stringify(packed))).toString('base64');
}
/** One bounded, idle-free operator quantum. Preview reads metadata only; apply
 * verifies exact source bytes and derives every level from verified parents.
 * No scheduler, durable job, byte rewrite, client-supplied level or flag rollout. */
export const step = internalAction({
  args: {
    ...operator,
    cursor: v.union(v.string(), v.null()),
    pending: v.array(v.string()),
    preview: v.boolean(),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    const identity = { projectId: input.projectId, actor: input.actor, operationId: input.operationId };
    // Old scan-only cursors remain resumable. The envelope contains scheduling
    // hints, never authenticated parents, levels, source bytes or proofs.
    const schedule = readSchedule(input.cursor);
    const deferred = new Map(schedule.deferred.map(state => [state.head, state]));
    const work = [...input.pending, ...(schedule.queue ?? [])];
    const sizes = new Map(schedule.sizes ?? []),
      next = work.slice(0, 100);
    // pending is a resumable work stack, not proof. Only its next page crosses RPC.
    // Size hints can avoid a redundant discovery query, never a source binding
    // or authority check: reader.read resolves every exact pin before AND after
    // acquisition. No generation or parent proof comes from this continuation.
    const page =
      !input.preview && next.length && next.every(head => sizes.has(head))
        ? {
            rows: next.map(head => ({ head, size: sizes.get(head)!, generation: null })),
            cursor: schedule.scan,
            done: JSON.parse(schedule.scan!).phase === 'done',
            remaining: [],
          }
        : JSON.parse(
            await ctx.runQuery(internal.projectStateGeneration.page, {
              ...identity,
              cursor: schedule.scan,
              pending: work.slice(0, 100),
              preview: input.preview,
            }),
          );
    const rows = page.rows as { head: string; size: number; generation: number | null }[];
    if (input.preview)
      return JSON.stringify({
        ...page,
        states: rows.length,
        missing: rows.filter(row => row.generation === null).length,
        calls: 2,
        writes: 0,
        sourceBytes: 0,
      });
    const selected: typeof rows = [];
    let bytes = 0;
    for (const row of rows) {
      sizes.set(row.head, row.size);
      if (row.generation !== null) {
        deferred.delete(row.head);
        continue;
      }
      if (!schedule.verifying && deferred.has(row.head)) continue;
      if (selected.length && bytes + row.size > 2 * 1024 * 1024) break;
      selected.push(row);
      bytes += row.size;
    }
    const reader = exchangeObjectReader(ctx),
      states = [];
    if (selected.length) {
      const bodies = await reader.read(
        input.projectId,
        input.actor,
        selected.map(row => ({ sha256: row.head, size: row.size })),
      );
      for (const [i, row] of selected.entries())
        states.push({ ...row, parents: parseNativeState(bodies[i]!).parents });
    }
    // Parent fan-in is not a function/read limit. Resolve arbitrary fan-in by
    // existing 100-record pages, with no per-State/per-parent function call.
    const selectedIds = new Set(states.map(state => state.head));
    const external = [...new Set(states.flatMap(state => state.parents).filter(id => !selectedIds.has(id)))];
    const known = new Map<string, number>();
    for (let offset = 0; offset < external.length; offset += 100) {
      const levels = await ctx.runQuery(internal.projectStateGeneration.levels, {
        ...identity,
        heads: external.slice(offset, offset + 100),
      });
      for (const { head, size, generation } of levels) {
        if (generation !== null) known.set(head, generation);
        if (size !== null) sizes.set(head, size);
      }
    }
    const derived = deriveStateGenerationPage(states, known);
    invariant(
      !derived.pending.length || derived.missing.length,
      'SOURCE_CLOSURE_INVALID',
      'State generations contain a cycle or an invalid parent level.',
    );
    const committed = derived.assigned.length
      ? JSON.parse(
          await ctx.runMutation(internal.projectStateGeneration.commit, {
            ...identity,
            states: derived.assigned,
          }),
        )
      : { assigned: 0 };
    const result = { ...derived, assigned: committed.assigned };
    for (const state of derived.assigned) deferred.delete(state.head);
    // Discovery reads each unresolved body once, then retains only dependency
    // identities. Repeated candidates and shared parents cannot resubmit it.
    // Assignment later re-reads these bodies in parent order and derives every
    // level again from authenticated bytes and current server parent levels.
    for (const head of result.pending) {
      const state = states.find(state => state.head === head)!;
      deferred.set(head, { head, parents: state.parents });
    }
    const consumed = new Set(selected.map(row => row.head));
    const remaining = rows
      .filter(row => row.generation === null && !consumed.has(row.head))
      .map(row => row.head);
    let pending = [
      ...new Set([...result.missing, ...remaining, ...(page.remaining ?? []), ...work.slice(100)]),
    ].filter(head => schedule.verifying || !deferred.has(head));
    if (result.pending.length) schedule.verifying = false;
    if (page.done && !pending.length && deferred.size) {
      pending = orderStateGenerationDependencies([...deferred.values()]);
      schedule.verifying = true;
    }
    invariant(
      !pending.length ||
        pending.join(',') !== work.join(',') ||
        result.assigned > 0 ||
        deferred.size !== schedule.deferred.length,
      'SOURCE_CLOSURE_INVALID',
      'The generation pass cannot advance; retained source requires inspection.',
    );
    const retained = new Set([...deferred.keys(), ...pending]);
    return JSON.stringify({
      // Compact only scheduling metadata; bounded body pages are never retained.
      // Keep argv/private-file continuations usable at thousands of States.
      cursor: saveSchedule({
        scan: page.cursor,
        deferred: [...deferred.values()],
        queue: pending.slice(100),
        verifying: schedule.verifying ?? false,
        sizes: [...sizes].filter(([head]) => retained.has(head)),
      }),
      done: page.done && !pending.length,
      pending: pending.slice(0, 100),
      assigned: result.assigned,
      sourceBytes: bytes,
      states: selected.length,
    });
  },
});
