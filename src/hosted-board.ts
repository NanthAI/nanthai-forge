// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { ConvexError } from 'convex/values';
import { z } from 'zod';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { assertBoardPaths, assertBoardText } from './board-text.js';
import { memberDataNotice } from './member-data-notice.js';
import {
  boardNoticeLine,
  readBoardCursor,
  readBoardProjectCursor,
  readBoardServerFeatures,
  unreadBoardNotes,
  writeBoardCursor,
  writeBoardProjectCursor,
} from './board-local.js';
import { ForgeError, invariant } from './errors.js';
import { exactConflictNotice, exactConflictsSchema } from './hosted-conflict-notice.js';
import { hostedActionError } from './hosted-action-error.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

// Local read state and notice lines live in the light board-local module (first-write hook).
export { readBoardCursor, writeBoardCursor, boardEnvelope } from './board-local.js';

export const boardMessageSchema = z.looseObject({
  id: z.string(),
  author: z.string().optional(),
  fromLaneId: z.string().optional(),
  target: z.string(),
  text: z.string(),
  paths: z.array(z.string()).optional(),
  replyTo: z.string().optional(),
  at: z.number(),
  resolved: z
    .looseObject({ by: z.string().optional(), at: z.number(), text: z.string().optional() })
    .optional(),
});
export const boardDeliverySchema = z.object({
  messages: z.array(boardMessageSchema),
  more: z.number(),
  cursor: z.number(),
  conflicts: exactConflictsSchema.optional(),
});
const ref = z.string().regex(/^[0-9a-fA-F][0-9a-fA-F-]{7,35}$/, 'an id or 8+ character prefix');
export const hostedBoardReadSchema = z
  .object({
    /** One note in full with its replies ("read more"). */
    id: ref.optional(),
    laneId: z.uuid().optional(),
    /** Include notes already seen on this machine. */
    all: z.boolean().optional(),
  })
  .strict();
const writeFields = {
  text: z.string().min(1),
  laneId: z.uuid().optional(),
  operationId: z.uuid().optional(),
};
export const hostedBoardPostSchema = z
  .object({
    ...writeFields,
    to: z.string().min(1),
    paths: z.array(z.string()).max(10).optional(),
  })
  .strict();
export const hostedBoardReplySchema = z.object({ ...writeFields, id: ref }).strict();
/** Withdraw a note that no longer applies; the reason is one short line (same 240-character rule). */
export const hostedBoardResolveSchema = z.object({ id: ref, text: z.string().min(1).optional() }).strict();
export const hostedBoardSchemas = {
  board: hostedBoardReadSchema,
  'board-post': hostedBoardPostSchema,
  'board-reply': hostedBoardReplySchema,
  'board-resolve': hostedBoardResolveSchema,
} as const;

function unsupported(error: unknown, resolving = false): never {
  const message = error instanceof Error ? error.message : '';
  if (resolving && /Could not find public function/i.test(message))
    throw new ForgeError(
      'HOSTED_ACTION_UNSUPPORTED',
      'This Forge server cannot resolve board notes yet (capability board-resolve). Nothing was changed.',
    );
  if (/Could not find public function|ArgumentValidationError[\s\S]*board/i.test(message))
    throw new ForgeError(
      'HOSTED_ACTION_UNSUPPORTED',
      'This Forge server has no agent board yet (capability boardVersion). Nothing was posted or read.',
    );
  // The server's typed refusals (LANE_NOT_ACTIVE, NOT_FOUND, BAD_ARGUMENT, ...) reach the agent
  // with their code and message, never as INTERNAL_ERROR (fd8dc28e, ce974f90).
  if (error instanceof ConvexError && error.data && typeof error.data === 'object')
    throw hostedActionError(error, 'board');
  throw error;
}

/** board, board --post, board --reply, board --resolve. One Convex call each; no capability probe (the server
 * authorizes every call). Posts without an operationId get a new one; a retried identical note
 * to the same target within 24 h returns the original id (server dedupe). */
export async function boardHostedSource(
  transport: Pick<HostedAgentTransport, 'root' | 'query' | 'mutation'> &
    Partial<Pick<HostedAgentTransport, 'address' | 'advertisedFeatures' | 'agentSlug'>>,
  action: keyof typeof hostedBoardSchemas,
  input: unknown,
) {
  const parsed = hostedBoardSchemas[action].safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', `Invalid ${action} parameters. Use board --help.`);
  const command = parsed.data as Record<string, unknown>;
  const laneId =
    (command.laneId as string | undefined) ?? readHostedLaneCheckout(transport.root)?.selection.laneId;
  // The features this process read, else the ones this machine last saw (board writes make no
  // capability read).
  const features =
    transport.advertisedFeatures ??
    (transport.address ? readBoardServerFeatures(transport.address.projectId) : []);
  if (action === 'board') {
    const id = command.id as string | undefined;
    const after =
      id || command.all
        ? 0
        : laneId
          ? readBoardCursor(transport.root, laneId)
          : readBoardProjectCursor(transport.root);
    const result = await transport
      .query<Record<string, unknown>>('projectBoard:read', {
        ...(id ? { id: id.toLowerCase() } : {}),
        ...(laneId && !id ? { laneId } : {}),
        after,
        // Resolved notes are listed only on request, and only a server that knows the flag gets it.
        ...(command.all && !id && features.includes('board-resolve') ? { all: true } : {}),
      })
      .catch(unsupported);
    if (!id && laneId && typeof result.cursor === 'number')
      writeBoardCursor(transport.root, laneId, result.cursor);
    const messages = Array.isArray(result.messages)
      ? result.messages
      : result.message
        ? [result.message]
        : [];
    const parsedMessages = messages.map(message => boardMessageSchema.parse(message));
    const shown = id || command.all ? parsedMessages : unreadBoardNotes(transport.root, parsedMessages);
    for (const message of shown)
      if (message.target === 'project') writeBoardProjectCursor(transport.root, message.at);
    const notices = [...shown, ...(Array.isArray(result.replies) ? result.replies : [])].map(message =>
      boardNoticeLine(boardMessageSchema.parse(message), laneId),
    );
    // One marker per read, only when it carries member text (S-17).
    const conflicts = result.conflicts ? exactConflictsSchema.parse(result.conflicts) : [];
    const conflictNotice = laneId ? exactConflictNotice(laneId, conflicts) : undefined;
    return {
      ...result,
      notices,
      ...(conflictNotice ? { conflictNotice } : {}),
      ...(notices.length || conflictNotice ? { notice: memberDataNotice } : {}),
    };
  }
  // The note names this agent session (c29d0780) once the server takes it.
  const agent = features.includes('agent-slug') ? transport.agentSlug?.() : undefined;
  if (action === 'board-resolve') {
    const reason = command.text as string | undefined;
    if (reason !== undefined) assertBoardText(reason);
    return transport
      .mutation('projectBoard:resolve', {
        id: (command.id as string).toLowerCase(),
        ...(reason ? { text: reason } : {}),
        ...(agent ? { agent } : {}),
      })
      .catch((error: unknown) => unsupported(error, true));
  }
  const text = command.text as string;
  // Same checks as the server, so a refusal costs no call; the server re-checks every post.
  assertBoardText(text);
  assertBoardPaths(command.paths as string[] | undefined);
  const post = {
    operationId: (command.operationId as string | undefined) ?? randomUUID(),
    text,
    ...(action === 'board-reply' ? { replyTo: (command.id as string).toLowerCase() } : { to: command.to }),
    ...(command.paths ? { paths: command.paths } : {}),
    ...(laneId ? { laneId } : {}),
  };
  return transport
    .mutation('projectBoard:post', agent ? { ...post, agent } : post)
    .catch((error: unknown) => {
      // A server rolled back past agent-slug: post once more without the slug (people see @handle).
      if (agent && error instanceof Error && /extra field\s+[`'"]?agent\b/i.test(error.message))
        return transport.mutation('projectBoard:post', post);
      throw error;
    })
    .catch(unsupported);
}
