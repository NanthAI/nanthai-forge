// SPDX-License-Identifier: Apache-2.0
import { jsonChunks } from './json-chunks.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { workSchema, type WorkData } from './work-types.js';
import {
  isUnifiedWork,
  unifiedIntentSchema,
  intentMembershipSchema,
  unifiedWorkSchema,
  initiativeSchema,
} from './work-unified-types.js';

// Reference discovery interprets schema-owned fields only, even though portable
// unified Intents preserve uninterpreted extensions verbatim.
const unifiedReferenceIntents = z.array(
  unifiedIntentSchema.extend({ memberships: z.array(intentMembershipSchema.strip()) }).strip(),
);
const pin = z
  .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().safe().nonnegative() })
  .strict();
const reference = z.object({ collection: z.string(), key: z.string() }).strict();
export const recordPinSchema = pin
  .extend({
    key: z.string(),
    refs: z.array(reference),
    status: z.string().optional(),
    channel: z.string().optional(),
  })
  .strict();
export const workRecordRootSchema = z
  .object({
    kind: z.literal('forge-work-records'),
    schema: z.literal(2),
    work: pin,
    revision: z.number().safe().nonnegative(),
    fields: z.array(
      z.union([
        z.object({ name: z.string(), records: z.array(recordPinSchema) }).strict(),
        z.object({ name: z.string(), value: z.unknown() }).strict(),
      ]),
    ),
  })
  .strict();
export type WorkRecordRoot = z.infer<typeof workRecordRootSchema>;
export type RecordPin = z.infer<typeof recordPinSchema>;
export type RecordRef = z.infer<typeof reference>;
export const recordIdentity = (collection: string, key: string) => JSON.stringify([collection, key]);
export const recordKey = (record: Record<string, unknown>, collection?: string) =>
  collection === 'intentAliases' && typeof record.aliasId === 'string'
    ? record.aliasId
    : typeof record.id !== 'string'
      ? undefined
      : collection === 'planningItems' && typeof record.version === 'number'
        ? JSON.stringify([record.id, record.version])
        : record.id;
export const recordBytes = (value: unknown) =>
  Buffer.from(
    JSON.stringify(value, null, 2)
      .split('\n')
      .map(line => `    ${line}`)
      .join('\n'),
  );
export const recordAttributes = (collection: string, value: Record<string, unknown>) => ({
  ...(typeof value.status === 'string' ? { status: value.status } : {}),
  ...(['channelMoves', 'hostedChannelMoves'].includes(collection) && typeof value.channel === 'string'
    ? { channel: value.channel }
    : {}),
});
const targets: Record<string, string> = {
  intentId: 'intents',
  laneId: 'lanes',
  viewId: 'views',
  checkId: 'checks',
  playbookId: 'playbooks',
  publicationId: 'publications',
  releaseId: 'releases',
  deploymentId: 'deployments',
  runId: 'runs',
  frictionId: 'frictionEvents',
};
/** Only schema-owned fields supply references; uninterpreted extension fields remain opaque. */
export function recordReferences(collection: string, value: unknown, format = 15): RecordRef[] {
  const shape = isUnifiedWork({ schema: format }) ? unifiedWorkSchema.shape : workSchema.shape;
  if (!Object.hasOwn(shape, collection)) return [];
  const schema =
    collection === 'intents' && isUnifiedWork({ schema: format })
      ? unifiedReferenceIntents
      : collection === 'initiatives' && isUnifiedWork({ schema: format })
        ? z.array(initiativeSchema.strip())
        : shape[collection as keyof typeof shape];
  const result = schema.safeParse([value]);
  const key =
    value && typeof value === 'object' ? recordKey(value as Record<string, unknown>, collection) : undefined;
  invariant(
    result.success,
    'INVALID_WORK_BACKUP',
    `Changed Work record ${collection}/${key ?? '(unknown)'} has an invalid shape at ${
      result.success ? '' : JSON.stringify(result.error.issues[0]?.path.slice(1) ?? [])
    }.`,
  );
  const parsed = (result.data as unknown[])[0];
  const refs = new Map<string, RecordRef>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    for (const [field, child] of Object.entries(item)) {
      const target = targets[field];
      if (target && typeof child === 'string')
        refs.set(recordIdentity(target, child), { collection: target, key: child });
      else if (field === 'frictionIds' && Array.isArray(child)) {
        for (const id of child)
          if (typeof id === 'string')
            refs.set(recordIdentity('frictionEvents', id), { collection: 'frictionEvents', key: id });
      } else visit(child);
    }
  };
  visit(parsed);
  return [...refs.values()];
}
export function recordMap(root: WorkRecordRoot) {
  const entries = new Map<string, { collection: string; record: RecordPin }>();
  const fields = new Set<string>();
  for (const field of root.fields) {
    invariant(!fields.has(field.name), 'INVALID_WORK_BACKUP', 'Work record root repeats a field.');
    fields.add(field.name);
    if (!('records' in field)) continue;
    for (const record of field.records) {
      const id = recordIdentity(field.name, record.key);
      invariant(!entries.has(id), 'INVALID_WORK_BACKUP', 'Work record root repeats a stable key.');
      entries.set(id, { collection: field.name, record });
    }
  }
  return entries;
}
export function recordMetadata(root: WorkRecordRoot) {
  return Object.fromEntries(
    root.fields
      .filter(field => 'value' in field)
      .map(field => [field.name, 'value' in field ? field.value : undefined]),
  );
}
export function buildWorkRecords(data: WorkData, options: { retainObjects?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const fields: WorkRecordRoot['fields'] = [];
  for (const [name, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      fields.push({ name, value });
      continue;
    }
    if (!Object.hasOwn(isUnifiedWork(data) ? unifiedWorkSchema.shape : workSchema.shape, name)) return;
    const records: RecordPin[] = [],
      keys = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== 'object') return;
      const key = recordKey(item, name);
      if (key === undefined || keys.has(key)) return;
      keys.add(key);
      const bytes = recordBytes(item),
        sha256 = digest(bytes);
      if (options.retainObjects !== false) objects.set(sha256, bytes);
      records.push({
        key,
        sha256,
        size: bytes.length,
        refs: recordReferences(name, item, data.schema),
        ...recordAttributes(name, item),
      });
    }
    fields.push({ name, records });
  }
  const hash = createHash('sha256');
  let size = 0;
  for (const chunk of jsonChunks(data, 2)) {
    hash.update(chunk);
    size += Buffer.byteLength(chunk);
  }
  const root: WorkRecordRoot = {
    kind: 'forge-work-records',
    schema: 2,
    work: { sha256: hash.digest('hex'), size },
    revision: data.revision,
    fields,
  };
  const content = Buffer.from(JSON.stringify(root));
  return { root, bytes: content, pin: { sha256: digest(content), size: content.length }, objects };
}
export async function readRecord(
  record: RecordPin,
  read: (pin: { sha256: string; size: number }) => Promise<Buffer>,
  collection?: string,
) {
  const bytes = await read(record);
  invariant(
    bytes.length === record.size && digest(bytes) === record.sha256,
    'INVALID_WORK_BACKUP',
    'Work record differs from its content pin.',
  );
  const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  invariant(
    recordKey(value, collection) === record.key && recordBytes(value).equals(bytes),
    'INVALID_WORK_BACKUP',
    'Work record key or canonical bytes differ.',
  );
  return value;
}
/** Hash exact portable bytes incrementally; never construct a second whole Work JSON. */
export async function* workRecordChunks(
  root: WorkRecordRoot,
  read: (pin: { sha256: string; size: number }) => Promise<Buffer>,
) {
  recordMap(root);
  const hash = createHash('sha256');
  let size = 0;
  const append = (bytes: string | Buffer) => {
    hash.update(bytes);
    size += Buffer.byteLength(bytes);
    return Buffer.from(bytes);
  };
  yield append('{');
  for (const [index, field] of root.fields.entries()) {
    yield append(`${index ? ',' : ''}\n  ${JSON.stringify(field.name)}: `);
    if ('records' in field) {
      yield append('[');
      for (const [i, record] of field.records.entries()) {
        const bytes = await read(record);
        invariant(
          bytes.length === record.size && digest(bytes) === record.sha256,
          'INVALID_WORK_BACKUP',
          'Work record bytes differ.',
        );
        yield append(i ? ',\n' : '\n');
        yield append(bytes);
      }
      yield append(field.records.length ? '\n  ]' : ']');
    } else yield append(JSON.stringify(field.value, null, 2).replaceAll('\n', '\n  '));
  }
  yield append(root.fields.length ? '\n}' : '}');
  const actual = { sha256: hash.digest('hex'), size };
  invariant(
    actual.sha256 === root.work.sha256 && actual.size === root.work.size,
    'INVALID_WORK_BACKUP',
    'Record root differs from the whole Work digest.',
  );
  return actual;
}

export async function hashWorkRecords(
  root: WorkRecordRoot,
  read: (pin: { sha256: string; size: number }) => Promise<Buffer>,
  collect?: Buffer[] | ((bytes: Buffer) => void),
) {
  for await (const chunk of workRecordChunks(root, read)) {
    if (typeof collect === 'function') collect(chunk);
    else collect?.push(chunk);
  }
  return root.work;
}
