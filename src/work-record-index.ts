// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nodeSchema = z.union([
  z.object({ entries: z.array(z.tuple([z.string(), z.array(z.number().safe().nonnegative())])) }).strict(),
  z.object({ branches: z.record(z.string().regex(/^[0-9a-f]$/), hash) }).strict(),
]);
type Node = z.infer<typeof nodeSchema>;
const parseNode = (raw: unknown): Node => {
  const parsed = nodeSchema.safeParse(raw);
  invariant(parsed.success, 'INVALID_WORK_STORE', 'Work lookup is invalid.');
  return parsed.data;
};
export type IndexIO = { read(id: string): unknown; put(value: unknown): string };
const route = (key: string) => digest(key);
export function indexGet(io: IndexIO, root: string | undefined, key: string): number[] {
  let id = root,
    depth = 0;
  const path = route(key);
  while (id) {
    const node = parseNode(io.read(id));
    if ('entries' in node) return node.entries.find(([name]) => name === key)?.[1] ?? [];
    invariant(depth < path.length, 'INVALID_WORK_STORE', 'Work lookup depth is invalid.');
    id = node.branches[path[depth++]!];
  }
  return [];
}
function build(io: IndexIO, entries: [string, number[]][], depth: number): string {
  if (entries.length <= 64 || depth === 64)
    return io.put({ entries: entries.sort(([a], [b]) => a.localeCompare(b)) });
  const buckets = new Map<string, [string, number[]][]>();
  for (const entry of entries) {
    const key = route(entry[0])[depth]!;
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }
  return io.put({
    branches: Object.fromEntries(
      [...buckets]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, values]) => [key, build(io, values, depth + 1)]),
    ),
  });
}
export function indexBuild(io: IndexIO, values: Map<string, number[]>) {
  return build(io, [...values], 0);
}
export function indexSet(
  io: IndexIO,
  root: string | undefined,
  key: string,
  positions: number[],
  depth = 0,
): string {
  const node: Node = root ? parseNode(io.read(root)) : { entries: [] };
  if ('entries' in node) {
    const entries = new Map(node.entries);
    if (positions.length) entries.set(key, positions);
    else entries.delete(key);
    return build(io, [...entries], depth);
  }
  invariant(depth < 64, 'INVALID_WORK_STORE', 'Work lookup depth is invalid.');
  const branch = route(key)[depth]!;
  return io.put({
    branches: { ...node.branches, [branch]: indexSet(io, node.branches[branch], key, positions, depth + 1) },
  });
}
/** Apply a record's selector changes together, persisting only the resulting
 * lookup path instead of fsyncing each superseded intermediate selector node. */
export function indexUpdate(
  io: IndexIO,
  root: string | undefined,
  changes: Map<string, number[]>,
  depth = 0,
): string {
  const node: Node = root ? parseNode(io.read(root)) : { entries: [] };
  if ('entries' in node) {
    const entries = new Map(node.entries);
    for (const [key, positions] of changes) {
      if (positions.length) entries.set(key, positions);
      else entries.delete(key);
    }
    return build(io, [...entries], depth);
  }
  invariant(depth < 64, 'INVALID_WORK_STORE', 'Work lookup depth is invalid.');
  const groups = new Map<string, Map<string, number[]>>();
  for (const [key, positions] of changes) {
    const branch = route(key)[depth]!;
    const group = groups.get(branch) ?? new Map<string, number[]>();
    group.set(key, positions);
    groups.set(branch, group);
  }
  const branches = { ...node.branches };
  for (const [branch, updates] of groups)
    branches[branch] = indexUpdate(io, branches[branch], updates, depth + 1);
  return io.put({ branches });
}
/** Full export/migration validates the derived locator against authoritative record bytes. */
export function validateIndex(io: IndexIO, root: string, values: unknown[]) {
  const actual = new Map<string, number[]>(),
    expected = new Map<string, number[]>();
  const visit = (id: string, depth = 0) => {
    invariant(depth <= 64, 'INVALID_WORK_STORE', 'Work lookup depth is invalid.');
    const node = parseNode(io.read(id));
    if ('entries' in node) {
      for (const [key, positions] of node.entries) {
        invariant(!actual.has(key), 'INVALID_WORK_STORE', 'Work lookup contains duplicate keys.');
        actual.set(key, positions);
      }
    } else for (const child of Object.values(node.branches)) visit(child, depth + 1);
  };
  visit(root);
  values.forEach((value, position) => {
    for (const key of recordKeys(value)) {
      const positions = expected.get(key) ?? [];
      positions.push(position);
      expected.set(key, positions);
    }
  });
  invariant(
    actual.size === expected.size &&
      [...expected].every(
        ([key, positions]) => JSON.stringify(actual.get(key)) === JSON.stringify(positions),
      ),
    'INVALID_WORK_STORE',
    'Work lookup differs from retained history.',
  );
}
export const lookupKey = (field: string, value: string) => JSON.stringify([field, value]);
/** Only explicit reducer selectors are indexed; these are derived locators, never authority. */
export function recordKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const row = value as Record<string, unknown>,
    keys: string[] = [];
  for (const field of ['id', 'operationId', 'channel', 'intentId', 'viewId', 'definition', 'aliasId'])
    if (typeof row[field] === 'string') keys.push(lookupKey(field, row[field]));
  if (typeof row.status === 'string' && (row.runner || Array.isArray(row.steps)))
    keys.push(lookupKey('status', row.status));
  if (row.state === 'creating') keys.push(lookupKey('state', 'creating'));
  if (Array.isArray(row.steps))
    for (const step of row.steps)
      if (typeof step?.runId === 'string') keys.push(lookupKey('stepRun', step.runId));
  if (typeof row.parent === 'string' && typeof row.head === 'string') keys.push(lookupKey('head', row.head));
  const operation = row.operation as { id?: string } | undefined;
  if (operation?.id) keys.push(lookupKey('operation', operation.id));
  const start = row.agentStart as { id?: string } | undefined,
    pending = row.pending as { operation?: { id?: string } } | undefined;
  if (start?.id) keys.push(lookupKey('agentOperation', start.id));
  if (pending) keys.push(lookupKey('pending', 'yes'));
  if (pending?.operation?.id) keys.push(lookupKey('agentOperation', pending.operation.id));
  if (Array.isArray(row.checkpoints))
    for (const checkpoint of row.checkpoints)
      if (checkpoint?.operation?.id) keys.push(lookupKey('agentOperation', checkpoint.operation.id));
  return [...new Set(keys)];
}
