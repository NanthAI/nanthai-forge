// SPDX-License-Identifier: Apache-2.0
'use node';
import { z } from 'zod';
import { parseWorkBytes } from '../src/work-metadata';
import { nativeManifestSchema } from '../src/work-archive-metadata';
import { requireOwnerDerived } from './projectOwnerDerived';
import { ownerDerivedSchema } from '../src/owner-derived';
import { ForgeError, invariant } from '../src/errors';
import { digest } from '../src/hash';
import { publicationHash } from '../src/publication-metadata';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ForgeError('INVALID_WORK_BACKUP', 'Invalid publication metadata JSON.');
  }
}
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  count = z.number().safe().nonnegative();
const pin = z.object({ sha256: hash, size: count }).strict();
const schema = z
  .object({
    schema: z.literal(1),
    manifest: nativeManifestSchema,
    pins: z.array(pin),
    edges: z.array(z.object({ head: hash, parents: z.array(hash), blobs: z.array(hash) }).strict()),
    ownerDerived: ownerDerivedSchema,
    work: z.string().optional(),
    preview: z
      .object({
        manifestDigest: hash,
        head: hash,
        format: z.literal('native'),
        revision: count,
        intents: count,
        lanes: count,
        views: count,
        runs: count,
        files: count,
        unavailable: count,
        channels: z.array(z.object({ name: z.string(), head: hash }).strict()),
      })
      .strict(),
  })
  .strict();

/** Trust boundary: derived rows are display data. A lying owner can only
 * mislabel their own project; these rows never grant Work/Channel authority. */
export function validatePublicationMetadata(value: unknown, root: { sha256: string; size: number }) {
  const parsed = schema.safeParse(value);
  invariant(parsed.success, 'INVALID_WORK_BACKUP', 'Invalid publication metadata.');
  const data = parsed.data,
    { manifest, preview, ownerDerived: derived } = data,
    files = new Map(manifest.files.map(file => [file.path, file])),
    objects = new Set(manifest.files.filter(p => p.path === `objects/${p.sha256}`).map(p => p.sha256)),
    pins = new Map<string, number>();
  for (const pin of data.pins) {
    invariant(
      !pins.has(pin.sha256) || pins.get(pin.sha256) === pin.size,
      'INVALID_WORK_BACKUP',
      'Identical publication pins have different sizes.',
    );
    pins.set(pin.sha256, pin.size);
  }
  invariant(
    files.size === manifest.files.length &&
      objects.has(manifest.head) &&
      preview.head === manifest.head &&
      preview.revision === manifest.revision &&
      preview.manifestDigest === digest(JSON.stringify(manifest)) &&
      preview.files === manifest.files.length &&
      preview.unavailable === manifest.unavailable.length &&
      pins.get(root.sha256) === root.size &&
      derived.work === files.get('work.json')?.sha256,
    'INVALID_WORK_BACKUP',
    'Publication metadata differs from its pinned manifest.',
  );
  if (data.work !== undefined) {
    const bytes = Buffer.from(data.work),
      pin = files.get('work.json');
    invariant(
      pin && digest(bytes) === pin.sha256 && bytes.length === pin.size,
      'INVALID_WORK_BACKUP',
      'Publication Work differs from its pinned bytes.',
    );
    const work = parseWorkBytes(bytes);
    invariant(
      work.revision === manifest.revision && work.nativeHead === manifest.head,
      'INVALID_WORK_BACKUP',
      'Publication Work differs from its source revision.',
    );
  }
  for (const file of manifest.files)
    invariant(
      file.path === 'work.json' || pins.get(file.sha256) === file.size,
      'PUBLISH_PIN_MISSING',
      'Manifest content has no committed publication pin.',
    );
  const requireObjects = (ids: string[], code = 'DERIVED_ROW_UNPINNED') => {
    invariant(
      ids.every(id => objects.has(id)),
      code,
      'Publication row references content outside its pinned closure.',
    );
  };
  const states = new Set<string>();
  for (const edge of data.edges) {
    invariant(!states.has(edge.head), 'INVALID_WORK_BACKUP', 'Publication repeats a State edge.');
    states.add(edge.head);
    requireObjects([edge.head, ...edge.parents, ...edge.blobs], 'INVALID_WORK_BACKUP');
  }
  invariant(
    states.has(manifest.head) && data.edges.every(e => e.parents.every(p => states.has(p))),
    'INVALID_WORK_BACKUP',
    'Publication omits a retained State edge.',
  );
  requireObjects(
    preview.channels.map(c => c.head),
    'INVALID_WORK_BACKUP',
  );
  for (const [head, parents] of [...derived.parents, ...derived.ancestry]) requireObjects([head, ...parents]);
  for (const [key] of derived.stats) {
    const ids = key.split(':');
    invariant(ids.length === 2, 'INVALID_WORK_BACKUP', 'Invalid diffstat pair.');
    requireObjects(ids);
  }
  for (const [head, tree] of derived.trees) requireObjects([head, ...tree.map(f => f.blob)]);
  const inspect = (value: unknown, field = ''): void => {
    if (Array.isArray(value)) {
      for (const child of value) inspect(child, field);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) inspect(child, key);
    } else if (
      typeof value === 'string' &&
      /^[a-f0-9]{64}$/.test(value) &&
      ['blob', 'head', 'base', 'parent', 'ancestors', 'boundaries'].includes(field)
    )
      requireObjects([value]);
  };
  for (const [, , rows] of derived.views) {
    const identities = new Set<string>();
    for (const row of rows) {
      const identity = JSON.stringify([row.collection, row.key]);
      invariant(!identities.has(identity), 'INVALID_WORK_BACKUP', 'Repeated derived display row.');
      identities.add(identity);
      invariant(
        ['viewDetails', 'viewFiles', 'laneViews', 'viewAcceptances'].includes(
          row.collection.replace(/:payload$/, ''),
        ),
        'INVALID_WORK_BACKUP',
        'Unknown derived display collection.',
      );
      if (row.collection.endsWith(':payload')) {
        invariant(
          rows.some(
            header =>
              header.collection === row.collection.slice(0, -8) &&
              parseJson(header.value).payloadKey === row.parent,
          ),
          'INVALID_WORK_BACKUP',
          'Orphan derived display payload.',
        );
        continue;
      }
      let value = parseJson(row.value);
      if (value.payloadKey) {
        const parts = rows
          .filter(r => r.collection === `${row.collection}:payload` && r.parent === value.payloadKey)
          .sort((a, b) => a.position - b.position);
        invariant(
          parts.length === value.payloadParts &&
            parts.every((p, i) => p.position === i && p.key === `${value.payloadKey}:${i}`),
          'INVALID_WORK_BACKUP',
          'Incomplete derived display payload.',
        );
        const text = parts.map(p => p.value).join('');
        invariant(
          value.payloadKey === `${row.key}:${digest(text)}`,
          'INVALID_WORK_BACKUP',
          'Changed derived display payload.',
        );
        value = parseJson(text);
      }
      inspect(value);
    }
  }
  return data;
}

/** All inputs come from DB metadata pages. Never call an object byte reader. */
export async function metadataPublication(
  ctx: ActionCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    operationId: string;
    digest: string;
    size: number;
    deferHistory?: boolean;
  },
  owner: string,
  request: string,
) {
  invariant(!input.deferHistory, 'BAD_ARGUMENT', 'Deferred history uses the existing publication path.');
  const session: Doc<'projectPublications'> | null = await ctx.runQuery(
    internal.projectPublicationStore.load,
    { projectId: input.projectId, operationId: input.operationId, owner },
  );
  invariant(
    session &&
      session.owner === owner &&
      session.request === request &&
      session.digest === input.digest &&
      session.size === input.size &&
      session.cursor === session.pages,
    'WORK_OPERATION_CHANGED',
    'Resume the original complete publication metadata.',
  );
  const pages: string[] = [];
  for (let position = 0; position < session.pages; position++)
    pages.push(
      await ctx.runQuery(internal.projectPublicationStore.read, { id: session._id, owner, position }),
    );
  const text = pages.join('');
  invariant(
    publicationHash(text) === session.metadataDigest,
    'WORK_OPERATION_CHANGED',
    'Publication metadata digest changed.',
  );
  const value = parseJson(text);
  requireOwnerDerived(value.ownerDerived);
  const data = validatePublicationMetadata(value, { sha256: input.digest, size: input.size });
  // Snapshot identity and publication operation identity are independent in the
  // existing exchange protocol. The session/request/root pins bind this retry.
  for (let offset = 0; offset < data.pins.length; offset += 100)
    await ctx.runQuery(internal.projectPublicationStore.pins, {
      projectId: input.projectId,
      owner,
      pins: data.pins.slice(offset, offset + 100),
    });
  await ctx.runMutation(internal.projectPublicationStore.validated, {
    id: session._id,
    owner,
    metadataDigest: session.metadataDigest,
  });
  return { preview: data.preview, metadataPublication: session._id };
}
