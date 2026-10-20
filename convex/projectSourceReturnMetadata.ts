// SPDX-License-Identifier: Apache-2.0
'use node';
import { randomUUID } from 'node:crypto';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { publicationHash, publicationPages, type PublicationMetadata } from '../src/publication-metadata';
import { validatePublicationMetadata } from './projectPublicationValidation';
export type MetadataRef = { partitionId: Id<'projectWorkGenerations'>; key: string; parts: number };
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
  const key = randomUUID(),
    { pages } = publicationPages(value as PublicationMetadata);
  for (const [position, body] of pages.entries())
    await ctx.runMutation(internal.projectReturnMetadataStore.put, {
      projectId,
      owner,
      partitionId,
      key,
      position,
      body,
    });
  return { partitionId, key, parts: pages.length };
}
export async function readReturnMetadata<T>(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  ref: MetadataRef,
): Promise<T> {
  const pages: string[] = [];
  for (let position = 0; position < ref.parts; position++)
    pages.push(
      await ctx.runQuery(internal.projectReturnMetadataStore.read, {
        projectId,
        owner,
        partitionId: ref.partitionId,
        key: ref.key,
        position,
      }),
    );
  return JSON.parse(pages.join('')) as T;
}
