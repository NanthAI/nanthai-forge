// SPDX-License-Identifier: Apache-2.0
'use node';
import { randomUUID } from 'node:crypto';
import { RETURN_BUDGET } from './projectReturnBudget';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { publicationHash } from '../src/publication-metadata';
import { jsonChunks } from '../src/json-chunks';
import { parseJsonStream } from '../src/json-stream';
import { validatePublicationMetadata } from './projectPublicationValidation';
export type MetadataRef = {
  partitionId: Id<'projectWorkGenerations'>;
  key: string;
  parts: number;
  cleanup?: string[];
  records?: number;
};
export type ReturnRef = Id<'_storage'> | MetadataRef;
/** Session/root pins and current owner authority remain required on every load. */
export async function publicationSnapshot(
  ctx: ActionCtx,
  backup: Doc<'projectBackups'>,
  owner: string,
): Promise<ReturnType<typeof validatePublicationMetadata> | undefined> {
  if (!backup.metadataPublication) return;
  const session: Doc<'projectPublications'> | null = await ctx.runQuery(
    internal.projectPublicationStore.load,
    { projectId: backup.projectId, operationId: backup.operationId, owner },
  );
  invariant(
    session &&
      session._id === backup.metadataPublication &&
      session.validated &&
      session.cursor === session.pages &&
      session.digest === backup.digest &&
      session.size === backup.size,
    'INVALID_WORK_BACKUP',
    'Source return publication session differs from its checkpoint.',
  );
  const pages: string[] = [];
  for (let position = 0; position < session.pages; position++)
    pages.push(
      await ctx.runQuery(internal.projectPublicationStore.read, { id: session._id, owner, position }),
    );
  const text = pages.join('');
  invariant(
    publicationHash(text) === session.metadataDigest,
    'INVALID_WORK_BACKUP',
    'Source return publication metadata changed.',
  );
  return validatePublicationMetadata(JSON.parse(text), { sha256: backup.digest, size: backup.size });
}
export async function storeReturnMetadata(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  partitionId: Id<'projectWorkGenerations'>,
  value: unknown,
): Promise<MetadataRef> {
  const key = randomUUID();
  let position = 0;
  let bodies: string[] = [],
    bytes = 0;
  const flush = async () => {
    if (!bodies.length) return;
    await ctx.runMutation(internal.projectReturnMetadataStore.putBatch, {
      projectId,
      owner,
      partitionId,
      key,
      position,
      bodies,
    });
    position += bodies.length;
    bodies = [];
    bytes = 0;
  };
  for (const body of jsonChunks(value)) {
    const size = Buffer.byteLength(body);
    if (
      bodies.length &&
      (bodies.length === RETURN_BUDGET.metadataPages || bytes + size > RETURN_BUDGET.metadataBytes)
    )
      await flush();
    bodies.push(body);
    bytes += size;
  }
  await flush();
  return { partitionId, key, parts: position };
}
export async function readReturnMetadata<T>(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  ref: MetadataRef,
): Promise<T> {
  async function* pages() {
    for (let position = 0; position < ref.parts;) {
      const bodies: string[] = await ctx.runQuery(internal.projectReturnMetadataStore.readBatch, {
        projectId,
        owner,
        partitionId: ref.partitionId,
        key: ref.key,
        position,
        count: Math.min(RETURN_BUDGET.metadataPages, ref.parts - position),
      });
      for (const body of bodies) yield Buffer.from(body);
      position += bodies.length;
    }
  }
  return (await parseJsonStream(pages())) as T;
}
