// SPDX-License-Identifier: AGPL-3.0-only
import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { guard } from './cliServer';
import { createProject } from './projectCreation';
import { activeOwnedProject } from './projectAuthority';
import { emptyHostedProject } from '../src/hosted-bootstrap';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
import { invariant } from '../src/errors';
import { storageDigest } from './projectStorage';
import { report } from './errors';
import { r2Key } from './r2';
import { selectBornMain } from './projectHostedBirth';

export const bootstrapInput = { operationId: v.string(), name: v.string() };
const requestFor = (name: string) => JSON.stringify(['empty-hosted-project', name.trim()]);
async function findProject(ctx: QueryCtx, input: { operationId: string; name: string }) {
  await guard(ctx, 'cli');
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'AUTH_REQUIRED', 'Sign in to create a project.');
  invariant(
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId) && input.name.trim(),
    'BAD_ARGUMENT',
    'Use an original operation UUID and project name.',
  );
  const project = await ctx.db
    .query('hostedProjects')
    .withIndex('by_owner_and_key', q => q.eq('owner', user.subject).eq('key', input.operationId))
    .unique();
  if (!project) return null;
  await activeOwnedProject(ctx, project._id, user.subject);
  invariant(
    project.hostingRequest === requestFor(input.name),
    'WORK_OPERATION_CHANGED',
    'Retry project creation with its original name.',
  );
  return project.currentBackup ? project._id : null;
}
export const find = internalQuery({
  args: bootstrapInput,
  returns: v.union(v.id('hostedProjects'), v.null()),
  handler: async (ctx, input) => {
    try {
      return await findProject(ctx, input);
    } catch (error) {
      return report(error);
    }
  },
});
/** A project ID gives R2 bytes their final immutable namespace before upload.
 * The original operation/request owns this reservation; it is not completion. */
export const prepare = internalMutation({
  args: bootstrapInput,
  returns: v.object({ projectId: v.id('hostedProjects'), at: v.string() }),
  handler: async (ctx, input) => {
    await findProject(ctx, input);
    const user = (await ctx.auth.getUserIdentity())!;
    const project = await createProject(ctx, {
      owner: user.subject,
      key: input.operationId,
      name: input.name.trim(),
    });
    await ctx.db.patch(project._id, { hostingRequest: requestFor(input.name) });
    return { projectId: project._id, at: new Date(project._creationTime).toISOString() };
  },
});
export const publish = internalMutation({
  args: {
    ...bootstrapInput,
    at: v.string(),
    projectId: v.optional(v.id('hostedProjects')),
    objects: v.array(
      v.object({ storageId: v.optional(v.id('_storage')), r2Key: v.optional(v.string()), nonce: v.string() }),
    ),
  },
  returns: v.object({ projectId: v.id('hostedProjects'), created: v.boolean() }),
  handler: async (ctx, input) => {
    try {
      const existing = await findProject(ctx, input);
      if (existing) return { projectId: existing, created: false };
      const user = (await ctx.auth.getUserIdentity())!;
      const bootstrap = emptyHostedProject(input.operationId, input.at);
      invariant(
        input.objects.length === bootstrap.objects.length,
        'INVALID_WORK_BACKUP',
        'Bootstrap content is incomplete.',
      );
      for (const [index, object] of input.objects.entries()) {
        const expected = bootstrap.objects[index]!;
        invariant(
          !!object.storageId !== !!object.r2Key,
          'INVALID_WORK_BACKUP',
          'Bootstrap object needs one storage binding.',
        );
        if (object.r2Key) {
          invariant(
            input.projectId && object.r2Key === r2Key(input.projectId, expected.sha256),
            'INVALID_WORK_BACKUP',
            'Bootstrap R2 project binding changed.',
          );
        } else {
          const stored = await ctx.db.system.get(object.storageId!);
          invariant(
            stored &&
              stored.size === expected.size &&
              storageDigest(stored.sha256) === expected.sha256 &&
              stored.contentType === `application/x-forge-object-${object.nonce}`,
            'INVALID_WORK_BACKUP',
            'Bootstrap content differs from its immutable pins.',
          );
        }
      }
      const project = await createProject(ctx, {
        owner: user.subject,
        key: input.operationId,
        name: input.name.trim(),
      });
      invariant(
        !input.projectId || input.projectId === project._id,
        'INVALID_WORK_BACKUP',
        'Bootstrap project changed.',
      );
      const root = bootstrap.objects[2]!;
      const backupId = await ctx.db.insert('projectBackups', {
        projectId: project._id,
        operationId: input.operationId,
        request: requestFor(input.name),
        nonce: input.operationId,
        previous: null,
        digest: root.sha256,
        size: root.size,
        objectManifest: { digest: root.sha256, size: root.size },
        transport: 'objects',
        validatedClosure: 1,
        preview: bootstrap.preview,
        status: 'stored',
      });
      for (const [index, object] of input.objects.entries()) {
        const pin = bootstrap.objects[index]!;
        await ctx.db.insert('projectObjects', {
          projectId: project._id,
          digest: pin.sha256,
          size: pin.size,
          nonce: object.nonce,
          ...(object.r2Key
            ? { location: 'r2' as const, r2Key: object.r2Key, r2Committed: true }
            : { storageId: object.storageId }),
          removed: false,
        });
      }
      const generationId = await ctx.db.insert('projectWorkGenerations', {
        projectId: project._id,
        backupId,
        revision: 0,
        initialRevision: 0,
        format: HOSTED_WORK_INDEX_FORMAT,
        status: 'ready',
        nextBatch: 1,
        metadata: JSON.stringify(bootstrap.projection.metadata),
      });
      for (const entry of bootstrap.projection.entries)
        await ctx.db.insert('projectWorkRecords', { projectId: project._id, generationId, ...entry });
      await ctx.db.patch(project._id, {
        ...(input.objects.some(o => o.r2Key) ? { r2StorageUsed: true } : {}),
        hostingRequest: requestFor(input.name),
        currentBackup: backupId,
        revision: 1,
        work: { backupId, generationId, operationId: input.operationId, initialRevision: 0, revision: 0 },
      });
      await selectBornMain(ctx, project, {
        operationId: input.operationId,
        head: bootstrap.head,
        backupId,
        generationId,
        origin: 'new-project',
      });
      return { projectId: project._id, created: true };
    } catch (error) {
      return report(error);
    }
  },
});
