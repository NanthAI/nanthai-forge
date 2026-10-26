// SPDX-License-Identifier: Apache-2.0
// Seed historical archive registrations to exercise retained read/resume support.
// New production writes use object exchange; these constructors model old data.
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { invariant } from '../dist/errors.js';
const { createProject } = await import(moduleUrl('../convex/projectCreation.ts'));
const { activeProject } = await import(moduleUrl('../convex/projectAuthority.ts'));
const { intentAuthority } = await import(moduleUrl('../convex/projectContributors.ts'));
const { report } = await import(moduleUrl('../convex/errors.ts'));
const registerBackup = async (ctx, input) => {
  try {
    const existing = await ctx.db
      .query('hostedProjects')
      .withIndex('by_owner_and_key', q => q.eq('owner', input.owner).eq('key', input.key))
      .unique();
    invariant(
      existing || input.previous === null,
      'PROJECT_CHANGED',
      'A new project has no previous backup.',
    );
    const project = await createProject(ctx, { owner: input.owner, key: input.key, name: input.name });
    invariant(
      project.name === input.name,
      'PROJECT_CHANGED',
      'Use this project’s original name or create another project.',
    );
    const original = await ctx.db
      .query('projectBackups')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', project._id).eq('operationId', input.operationId),
      )
      .unique();
    if (original) {
      invariant(
        original.request === input.request,
        'WORK_OPERATION_CHANGED',
        'This backup operation has different archive/source pins. Reconcile its original request.',
      );
      return original._id;
    }
    if (input.previous)
      invariant(
        (await ctx.db.get(input.previous))?.projectId === project._id,
        'PROJECT_CHANGED',
        'The previous backup belongs to another project.',
      );
    return ctx.db.insert('projectBackups', {
      projectId: project._id,
      operationId: input.operationId,
      request: input.request,
      nonce: input.nonce,
      previous: input.previous,
      digest: input.digest,
      size: input.size,
      preview: input.preview,
      status: 'uploading',
    });
  } catch (error) {
    return report(error);
  }
};
const registerProposal = async (ctx, input) => {
  try {
    await activeProject(ctx, input.projectId, input.actor);
    const old = await ctx.db
      .query('projectProposals')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    if (old) {
      invariant(
        old.actor === input.actor && old.request === input.request,
        'WORK_OPERATION_CHANGED',
        'Reconcile this proposal’s original actor and pins.',
      );
      return old._id;
    }
    const authority = await intentAuthority(ctx, input.projectId, input.actor, input.intentId),
      backup = await ctx.db.get(input.baseBackupId);
    invariant(
      authority.event.baseBackupId === input.baseBackupId &&
        authority.command.base === input.baseState &&
        backup?.projectId === input.projectId &&
        backup.status === 'stored' &&
        backup.preview.format === 'native' &&
        backup.digest === input.baseArchiveSha256,
      'SOURCE_UNAVAILABLE',
      'Select this Intent’s original server-pinned native source archive and State.',
    );
    return await ctx.db.insert('projectProposals', { ...input, status: 'uploading' });
  } catch (error) {
    return report(error);
  }
};

export function historicalArchiveActions(actions) {
  return {
    ...actions,
    prepare: {
      ...actions.prepare,
      _handler: async (ctx, input) => {
        const run = ctx.runMutation;
        ctx.runMutation = (ref, args) => {
          const name = getFunctionName(ref);
          return name === 'projectBackups:register'
            ? registerBackup(ctx, args)
            : name === 'projectProposals:register' && !args.transport
              ? registerProposal(ctx, args)
              : run(ref, args);
        };
        try {
          return await actions.prepare._handler(ctx, input);
        } finally {
          ctx.runMutation = run;
        }
      },
    },
  };
}
