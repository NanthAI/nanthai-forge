// SPDX-License-Identifier: Apache-2.0
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { metadataCommandSchema } from '../src/work-types';
import { metadataRequest } from '../src/work-metadata';
import type { HostedEvent } from '../src/work-types';
import type { indexedCommand } from './projectWorkIndexedCommand';

export async function caller(ctx: ActionCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project.');
  return user.subject;
}
export type WorkCommandInput = {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  revision: number;
  command: string;
};
/** The hosted Work command, shared by the 64 MiB V8 action and the Node action (which runs the
 * shapes V8 cannot). Everything before `append` only reads, so a V8 attempt that hands over to Node
 * leaves nothing behind, and the operation id makes the Node run the same operation. */
export async function runWorkCommand(
  ctx: ActionCtx,
  input: WorkCommandInput,
  owner: string,
  indexed: (
    command: Exclude<HostedEvent['command'], { action: 'source-return' }>,
    request: string,
  ) => Promise<Awaited<ReturnType<typeof indexedCommand>>>,
): Promise<Doc<'projectWorkEvents'>> {
  let parsed;
  try {
    parsed = metadataCommandSchema.safeParse(JSON.parse(input.command));
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Send a supported hosted Work command.');
  }
  invariant(parsed.success, 'BAD_ARGUMENT', 'Send a supported hosted Work command.');
  const command = parsed.data,
    request = metadataRequest(command);
  if (command.action === 'put-planning-item' || command.action === 'comment-planning-item') {
    await ctx.runQuery(internal.projectWork.owner, { projectId: input.projectId, owner });
    invariant(
      command.operationId === input.operationId,
      'BAD_ARGUMENT',
      'Use the planning command’s original operation UUID.',
    );
  }
  invariant(
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId) &&
      Number.isSafeInteger(input.revision) &&
      input.revision >= 0,
    'BAD_ARGUMENT',
    'Use an original operation UUID and Work revision.',
  );
  const original: Doc<'projectWorkEvents'> | null = await ctx.runQuery(internal.projectWork.find, {
    projectId: input.projectId,
    owner,
    operationId: input.operationId,
  });
  if (original) {
    invariant(
      original.request === request && original.previousRevision === input.revision,
      'WORK_OPERATION_CHANGED',
      'Reconcile this operation’s original command and revision.',
    );
    return original;
  }
  const projection = await indexed(command, request);
  return await ctx.runMutation(internal.projectWork.append, {
    projectId: input.projectId,
    owner,
    operationId: input.operationId,
    request,
    previousRevision: input.revision,
    command: JSON.stringify(command),
    projection,
  });
}
