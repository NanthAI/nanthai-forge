// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Who a hosted planning comment names, set by the server only (Item 9a3d6f5f). The writer is the signed-in account
// (stamped as `author` by the replay); a label the client typed never becomes the writer, because a reader who may not
// see people would otherwise be shown whatever handle the client chose. The agent marker comes from the credential
// kind: a device credential is an agent session, a browser sign-in is the person.
import type { MutationCtx } from './_generated/server';
import { invariant } from '../src/errors';
import { AGENT_CLIENT, isAgentSlug, slugFromDigest } from '../src/agent-slug';
import { digest } from '../src/state/hash';
import { isDeviceIdentity } from './cliServer';
import { publicActorLabel } from './publicPeople';
import { boundAttachments } from './discussionAttachmentBind';
import type { Doc } from './_generated/dataModel';
import type { PlanningAttachment } from '../src/discussion-attachment-limits';

/** The longest comment a hosted project stores (GitHub's limit); the page draws nothing above it. */
export const MAX_COMMENT_CHARACTERS = 65_536;

type CommentCommand = {
  text: string;
  authorLabel: string;
  agent?: string | undefined;
  agentClient?: string | undefined;
  decision?: boolean | undefined;
  decidedBy?: string | undefined;
  itemId: string;
  operationId: string;
  attachments?: PlanningAttachment[] | undefined;
};

/** Normalises a comment command in place before its request digest is taken, so a retry normalises the same way. */
export async function serverCommentWriter(
  ctx: MutationCtx,
  command: CommentCommand,
  project: Pick<Doc<'hostedProjects'>, '_id'>,
) {
  invariant(
    command.text.length <= MAX_COMMENT_CHARACTERS,
    'BAD_ARGUMENT',
    `Keep a comment to ${MAX_COMMENT_CHARACTERS.toLocaleString('en-US')} characters or fewer.`,
  );
  delete command.decidedBy;
  // Files are named only by their committed bindings for this comment; a server job attaches none.
  if (command.attachments) {
    if (await ctx.auth.getUserIdentity())
      command.attachments = await boundAttachments(
        ctx,
        project._id,
        command.itemId,
        command.operationId,
        command.attachments,
      );
    else delete command.attachments;
  }
  const user = await ctx.auth.getUserIdentity();
  if (!user) {
    // A scheduled Forge job (no sign-in): its label is written by server code, and it is never an agent session.
    delete command.agent;
    delete command.agentClient;
    if (command.decision) command.decidedBy = '';
    return;
  }
  command.authorLabel = '';
  // A browser sign-in is the person: no agent session and no declared model.
  if (!isDeviceIdentity(user)) {
    delete command.agent;
    delete command.agentClient;
  } else if (!isAgentSlug(command.agent))
    // A device that sent no session slug still reads as an agent: a stable slug from its credential.
    command.agent = slugFromDigest(
      digest(`planning-comment-agent:${String(user.forgeCredential ?? user.subject)}`),
    );
  // A decision's body line names the same writer, empty when the account has no handle.
  if (command.decision) command.decidedBy = await publicActorLabel(ctx, user.subject, command.agent);
}

/** Normalises a planning put's agent attribution from the credential kind (Item 1d51c91f): browser sign-ins
 * and scheduled server jobs carry no agent slug or model; device credentials always carry one. */
export async function serverPutWriter(
  ctx: MutationCtx,
  command: { agent?: string | undefined; agentClient?: string | undefined },
) {
  const user = await ctx.auth.getUserIdentity();
  if (!user || !isDeviceIdentity(user)) {
    delete command.agent;
    delete command.agentClient;
    return;
  }
  if (!isAgentSlug(command.agent))
    command.agent = slugFromDigest(
      digest(`planning-comment-agent:${String(user.forgeCredential ?? user.subject)}`),
    );
  if (command.agentClient !== undefined && !AGENT_CLIENT.test(command.agentClient))
    delete command.agentClient;
}
