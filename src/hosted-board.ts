// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { assertBoardPaths, assertBoardText } from './board-text.js';
import { boardNoticeLine, readBoardCursor, writeBoardCursor } from './board-local.js';
import { ForgeError, invariant } from './errors.js';
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
});
export const boardDeliverySchema = z.object({
  messages: z.array(boardMessageSchema),
  more: z.number(),
  cursor: z.number(),
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
export const hostedBoardSchemas = {
  board: hostedBoardReadSchema,
  'board-post': hostedBoardPostSchema,
  'board-reply': hostedBoardReplySchema,
} as const;

function unsupported(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (/Could not find public function|ArgumentValidationError[\s\S]*board/i.test(message))
    throw new ForgeError(
      'HOSTED_ACTION_UNSUPPORTED',
      'This Forge server has no agent board yet (capability boardVersion). Nothing was posted or read.',
    );
  throw error;
}

/** board, board --post, board --reply. One Convex call each; no capability probe (the server
 * authorizes every call). Posts without an operationId get a new one; a retried identical note
 * to the same target within 24 h returns the original id (server dedupe). */
export async function boardHostedSource(
  transport: Pick<HostedAgentTransport, 'root' | 'query' | 'mutation'>,
  action: keyof typeof hostedBoardSchemas,
  input: unknown,
) {
  const parsed = hostedBoardSchemas[action].safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', `Invalid ${action} parameters. Use board --help.`);
  const command = parsed.data as Record<string, unknown>;
  const laneId =
    (command.laneId as string | undefined) ?? readHostedLaneCheckout(transport.root)?.selection.laneId;
  if (action === 'board') {
    const id = command.id as string | undefined;
    const after = id || command.all || !laneId ? 0 : readBoardCursor(transport.root, laneId);
    const result = await transport
      .query<Record<string, unknown>>('projectBoard:read', {
        ...(id ? { id: id.toLowerCase() } : {}),
        ...(laneId && !id ? { laneId } : {}),
        after,
      })
      .catch(unsupported);
    if (!id && laneId && typeof result.cursor === 'number')
      writeBoardCursor(transport.root, laneId, result.cursor);
    const messages = Array.isArray(result.messages)
      ? result.messages
      : result.message
        ? [result.message]
        : [];
    return {
      ...result,
      notices: [...messages, ...(Array.isArray(result.replies) ? result.replies : [])].map(message =>
        boardNoticeLine(boardMessageSchema.parse(message), laneId),
      ),
    };
  }
  const text = command.text as string;
  // Same checks as the server, so a refusal costs no call; the server re-checks every post.
  assertBoardText(text);
  assertBoardPaths(command.paths as string[] | undefined);
  return transport
    .mutation('projectBoard:post', {
      operationId: (command.operationId as string | undefined) ?? randomUUID(),
      text,
      ...(action === 'board-reply' ? { replyTo: (command.id as string).toLowerCase() } : { to: command.to }),
      ...(command.paths ? { paths: command.paths } : {}),
      ...(laneId ? { laneId } : {}),
    })
    .catch(unsupported);
}
