// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mapExchange, exchangePool } from './exchange-parallel.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { sourceManifestSchema } from './work-archive-metadata.js';
import { buildWorkRecords, hashWorkRecords, workRecordRootSchema } from './work-exchange-records.js';
import { buildRecordPacks, recordPackSchema } from './work-record-packs.js';
import { buildWorkDelta } from './work-exchange-delta.js';
import type { WorkData } from './work-types.js';
const pinSchema = z
  .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().safe().nonnegative() })
  .strict();
export const treeRefSchema = pinSchema
  .extend({ height: z.number().safe().nonnegative(), length: z.number().safe().nonnegative() })
  .strict();
export type TreeRef = z.infer<typeof treeRefSchema>;
export type BytePin = z.infer<typeof pinSchema>;
const pageSchema = z
  .object({
    kind: z.literal('forge-byte-tree'),
    schema: z.literal(1),
    children: z.array(treeRefSchema).min(2),
  })
  .strict();
const recipeSchema = pinSchema.extend({ tree: treeRefSchema }).strict();
const legacyExchangeRootSchema = z
  .object({
    kind: z.literal('forge-native-exchange'),
    schema: z.literal(1),
    manifest: recipeSchema,
    work: recipeSchema,
  })
  .strict();
export const exchangeRootSchema = z.union([
  legacyExchangeRootSchema,
  legacyExchangeRootSchema
    .extend({
      schema: z.literal(2),
      work: pinSchema,
      records: recipeSchema,
      delta: pinSchema.optional(),
      recordPacks: z.array(recordPackSchema).optional(),
    })
    .strict(),
]);
export type ExchangeRoot = z.infer<typeof exchangeRootSchema>;
export const isExchangeRoot = (value: unknown): value is ExchangeRoot =>
  !!value && typeof value === 'object' && 'kind' in value && value.kind === 'forge-native-exchange';
const pin = (bytes: Buffer) => ({ sha256: digest(bytes), size: bytes.length });
// Gear boundaries forget earlier input after 32 bytes. A local insertion changes
// nearby chunks, not the byte offsets of every later historical record.
const gear = Array.from({ length: 256 }, (_, i) =>
  Buffer.from(digest(`forge-metadata-byte-${i}`), 'hex').readUInt32LE(0),
);
export function byteChunks(bytes: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  let start = 0,
    hash = 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 1) + gear[bytes[i]!]!) >>> 0;
    const size = i - start + 1;
    if (size >= 1024 && ((hash & 4095) === 0 || size >= 16384)) {
      chunks.push(bytes.subarray(start, i + 1));
      start = i + 1;
      hash = 0;
    }
  }
  if (start < bytes.length || !chunks.length) chunks.push(bytes.subarray(start));
  return chunks;
}
// Array-member boundaries keep pretty JSON records/notes aligned even when
// repetitive field text has few rolling-byte anchors. Hash each exact segment;
// retain every delimiter and whitespace byte rather than reserialize records.
function metadataChunks(bytes: Buffer): Buffer[] {
  const ends: number[] = [];
  const stack: number[] = [];
  let quoted = false,
    escaped = false;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) quoted = false;
      continue;
    }
    if (c === 34) {
      quoted = true;
      continue;
    }
    if (c === 91 || c === 123) {
      stack.push(c);
      if (c === 91) ends.push(i + 1);
    } else if (c === 93 || c === 125) {
      stack.pop();
      if (c === 93) ends.push(i + 1);
    } else if (c === 44 && stack.at(-1) === 91) ends.push(i + 1);
  }
  if (!ends.length) return byteChunks(bytes);
  if (ends.at(-1) !== bytes.length) ends.push(bytes.length);
  const chunks: Buffer[] = [];
  let start = 0,
    previous = 0;
  for (const end of ends) {
    const segment = bytes.subarray(previous, end),
      size = end - start;
    previous = end;
    if (size >= 2048 && ((parseInt(digest(segment).slice(0, 8), 16) & 15) === 0 || size >= 16384)) {
      const value = bytes.subarray(start, end);
      chunks.push(...(value.length > 32768 ? byteChunks(value) : [value]));
      start = end;
    }
  }
  if (start < bytes.length) chunks.push(bytes.subarray(start));
  return chunks.length ? chunks : [bytes];
}
export type MetadataLocation = {
  size: number;
  path?: 'work.json' | 'manifest.json';
  offset?: number;
  inline?: string;
};
export function buildByteTree(
  bytes: Buffer,
  objects: Map<string, Buffer>,
  locations?: Record<string, MetadataLocation>,
  path?: 'work.json' | 'manifest.json',
) {
  const put = (content: Buffer, offset?: number) => {
    const p = pin(content);
    objects.set(p.sha256, content);
    if (locations)
      locations[p.sha256] =
        path && offset !== undefined
          ? { size: content.length, path, offset }
          : { size: content.length, inline: content.toString('base64') };
    return p;
  };
  let refs: TreeRef[] = metadataChunks(bytes).map(content => ({
    ...put(content, content.byteOffset - bytes.byteOffset),
    height: 0,
    length: content.length,
  }));
  while (refs.length > 1) {
    const pages: TreeRef[][] = [];
    let page: TreeRef[] = [];
    for (const ref of refs) {
      page.push(ref);
      if (page.length >= 16 && ((parseInt(ref.sha256.slice(0, 8), 16) & 31) === 0 || page.length >= 64)) {
        pages.push(page);
        page = [];
      }
    }
    if (page.length) pages.push(page);
    refs = pages.map(children => {
      if (children.length === 1) return children[0]!;
      // An undersized final page remains at this level; pad no data. Heights can
      // differ across siblings; every edge must descend to prevent cycles.
      const content = Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children }));
      return {
        ...put(content),
        height: Math.max(...children.map(child => child.height)) + 1,
        length: children.reduce((sum, child) => sum + child.length, 0),
      };
    });
  }
  return { ...pin(bytes), tree: refs[0]! };
}
export function buildExchangeRoot(
  manifest: Buffer,
  work: Buffer,
  options: { records?: boolean; baseline?: WorkData; journalRevision?: number } = {},
) {
  const objects = new Map<string, Buffer>(),
    locations: Record<string, MetadataLocation> = {};
  const manifestTree = buildByteTree(manifest, objects, locations, 'manifest.json');
  const records = options.records ? buildWorkRecords(JSON.parse(work.toString('utf8'))) : undefined;
  let root: ExchangeRoot;
  if (records) {
    const put = (content: Buffer) => {
      const p = pin(content);
      objects.set(p.sha256, content);
      locations[p.sha256] = { size: p.size, inline: content.toString('base64') };
      return p;
    };
    let offset = 0;
    for (const field of records.root.fields)
      if ('records' in field)
        for (const record of field.records) {
          const content = records.objects.get(record.sha256)!;
          offset = work.indexOf(content, offset);
          invariant(offset >= 0, 'INVALID_WORK_BACKUP', 'Record encoding differs from portable Work.');
          objects.set(record.sha256, content);
          locations[record.sha256] = { size: record.size, path: 'work.json', offset };
          offset += record.size;
        }
    const recordPacks = buildRecordPacks(records.root, work, locations, (content, offset) => {
      const p = pin(content);
      objects.set(p.sha256, content);
      locations[p.sha256] = { size: p.size, path: 'work.json', offset };
    });
    const baseline = options.baseline ? buildWorkRecords(options.baseline) : undefined;
    const delta = baseline
      ? buildWorkDelta(baseline.root, records.root, baseline.pin.sha256, options.journalRevision)
      : undefined;
    root = {
      kind: 'forge-native-exchange',
      schema: 2,
      manifest: manifestTree,
      work: pin(work),
      records: buildByteTree(records.bytes, objects, locations),
      recordPacks,
      ...(delta ? { delta: put(Buffer.from(JSON.stringify(delta))) } : {}),
    };
  } else {
    root = {
      kind: 'forge-native-exchange',
      schema: 1,
      manifest: manifestTree,
      work: buildByteTree(work, objects, locations, 'work.json'),
    };
  }
  const bytes = Buffer.from(JSON.stringify(root));
  return { root, bytes, objects, index: { schema: 1 as const, rootSha256: digest(bytes), locations } };
}
/** Depth-first traversal retains only the current page frontier and read batch.
 * Source chunks are released after consumption, including repeated tree leaves. */
export async function* byteTreeChunks(
  recipe: z.infer<typeof recipeSchema>,
  read: (pins: BytePin[]) => Promise<Buffer[]>,
  options: { batchSize?: number } = {},
): AsyncGenerator<Buffer> {
  invariant(
    recipe.tree.length === recipe.size,
    'INVALID_WORK_BACKUP',
    'Metadata recipe size differs from its tree.',
  );
  const pending = [recipe.tree],
    hash = createHash('sha256');
  let size = 0;
  while (pending.length) {
    const batch: TreeRef[] = [];
    let bytes = 0;
    // Reverse the frontier so batches and yielded bytes retain logical order.
    while (pending.length && batch.length < (options.batchSize ?? 8)) {
      const next = pending[pending.length - 1]!;
      if (batch.length && (next.height > 0 || bytes + next.size > 2 * 1024 * 1024)) break;
      batch.push(pending.pop()!);
      bytes += next.size;
      if (next.height > 0) break;
    }
    const loaded = await read(batch.map(({ sha256, size }) => ({ sha256, size })));
    invariant(loaded.length === batch.length, 'INVALID_WORK_BACKUP', 'Tree download omitted content.');
    for (const [index, ref] of batch.entries()) {
      const content = loaded[index]!;
      invariant(
        content.length === ref.size && digest(content) === ref.sha256,
        'INVALID_WORK_BACKUP',
        'Tree content differs from its selected digest.',
      );
      if (ref.height === 0) {
        invariant(ref.length === ref.size, 'INVALID_WORK_BACKUP', 'Leaf size differs from logical bytes.');
        size += content.length;
        invariant(size <= recipe.size, 'INVALID_WORK_BACKUP', 'Tree exceeds its logical size.');
        hash.update(content);
        yield content;
      } else {
        const page = pageSchema.parse(JSON.parse(content.toString('utf8')));
        invariant(
          page.children.every(child => child.height < ref.height) &&
            page.children.reduce((sum, child) => sum + child.length, 0) === ref.length,
          'INVALID_WORK_BACKUP',
          'Tree ancestry or logical length is invalid.',
        );
        for (let i = page.children.length - 1; i >= 0; i--) pending.push(page.children[i]!);
      }
    }
  }
  invariant(
    size === recipe.size && hash.digest('hex') === recipe.sha256,
    'INVALID_WORK_BACKUP',
    'Reconstructed metadata differs from its original bytes.',
  );
}

export async function readByteTree(
  recipe: z.infer<typeof recipeSchema>,
  read: (pins: BytePin[]) => Promise<Buffer[]>,
  options: { batchSize?: number; onBytes?: ((done: number, total: number) => void) | undefined } = {},
) {
  const bytes = Buffer.allocUnsafe(recipe.size);
  let offset = 0;
  for await (const chunk of byteTreeChunks(recipe, read, options)) {
    chunk.copy(bytes, offset);
    offset += chunk.length;
    options.onBytes?.(offset, recipe.size);
  }
  return bytes;
}
export async function resolveExchangeRoot(
  bytes: Buffer,
  read: (pins: BytePin[]) => Promise<Buffer[]>,
  options: { batchSize?: number; onWorkProgress?: ((done: number, total: number) => void) | undefined } = {},
) {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isExchangeRoot(value)) {
    const manifest = sourceManifestSchema.parse(value),
      file = manifest.files.find(file => file.path === 'work.json');
    invariant(file, 'INVALID_WORK_BACKUP', 'Exchange omits Work metadata.');
    const [work] = await read([file]);
    invariant(
      work && work.length === file.size && digest(work) === file.sha256,
      'INVALID_WORK_BACKUP',
      'Work differs from its manifest.',
    );
    return { manifest: bytes, work };
  }
  const pool = exchangePool(4, 8 * 1024 * 1024),
    boundedRead = (pins: BytePin[]) =>
      pool(
        () => read(pins),
        pins.reduce((sum, pin) => sum + pin.size, 0),
      );
  const root = exchangeRootSchema.parse(value);
  options.onWorkProgress?.(0, root.work.size);
  const recordWork = async () => {
    invariant(root.schema === 2, 'INVALID_WORK_BACKUP', 'Select a record exchange.');
    const bytes = await readByteTree(root.records, boundedRead, options);
    invariant(
      bytes && bytes.length === root.records.size && digest(bytes) === root.records.sha256,
      'INVALID_WORK_BACKUP',
      'Record root differs from its pin.',
    );
    const records = workRecordRootSchema.parse(JSON.parse(bytes.toString('utf8'))),
      work = Buffer.allocUnsafe(root.work.size);
    const pins = records.fields.flatMap(field => ('records' in field ? field.records : []));
    const cache = new Map<string, Buffer>();
    let position = 0;
    let offset = 0;
    invariant(
      records.work.sha256 === root.work.sha256 && records.work.size === root.work.size,
      'INVALID_WORK_BACKUP',
      'Record root differs from logical Work.',
    );
    await hashWorkRecords(
      records,
      async pin => {
        const current = position++;
        if (!cache.has(pin.sha256)) {
          cache.clear();
          const batch: BytePin[] = [];
          let bytes = 0;
          for (let i = current; i < pins.length && batch.length < (options.batchSize ?? 8); i++) {
            const next = pins[i]!;
            if (batch.length && bytes + next.size > 2 * 1024 * 1024) break;
            batch.push(next);
            bytes += next.size;
          }
          const values = await boundedRead(batch);
          batch.forEach((item, i) => cache.set(item.sha256, values[i]!));
        }
        return cache.get(pin.sha256)!;
      },
      chunk => {
        invariant(
          offset + chunk.length <= work.length,
          'INVALID_WORK_BACKUP',
          'Record bytes exceed logical Work.',
        );
        chunk.copy(work, offset);
        offset += chunk.length;
        options.onWorkProgress?.(offset, root.work.size);
      },
    );
    return work;
  };
  // Drain both traversals before rejecting so callers can safely clean up staging.
  const resolved = await mapExchange(
      [
        () => readByteTree(root.manifest, boundedRead, options),
        () =>
          root.schema === 2
            ? recordWork()
            : readByteTree(root.work, boundedRead, { ...options, onBytes: options.onWorkProgress }),
      ],
      2,
      run => run(),
    ),
    manifest = resolved[0]!,
    work = resolved[1]!,
    parsed = sourceManifestSchema.parse(JSON.parse(manifest.toString('utf8'))),
    file = parsed.files.find(item => item.path === 'work.json');
  invariant(
    file?.sha256 === root.work.sha256 && file.size === work.length,
    'INVALID_WORK_BACKUP',
    'Work tree differs from the original manifest.',
  );
  return { manifest, work };
}
