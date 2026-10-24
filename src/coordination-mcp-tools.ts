// SPDX-License-Identifier: Apache-2.0
import {
  coordinationChoicesSchema,
  coordinationHarnessSchema,
  coordinationSessionKindSchema,
} from './coordination-types.js';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { COORDINATION_LIMITS as L } from './coordination-types.js';
import type { CoordinationSession } from './coordination-session.js';
import type { CoordinationCall } from './coordination-mcp.js';
import { sessionDeclaration, type SessionDeclaration } from './coordination-identity.js';

const ref = z.string().min(1).max(L.id);
const paths = z.array(z.string().min(1).max(L.path)).max(L.paths);
const operationId = z
  .string()
  .uuid()
  .optional()
  .describe('Reuse the returned operationId to retry after an unknown outcome.');
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** Short tools for agents: the process session, operation UUIDs and sequences are filled in. */
export function registerConciseCoordinationTools(
  server: McpServer,
  session: CoordinationSession,
  result: CoordinationCall,
) {
  const declaration = sessionDeclaration(process.env, () => server.server.getClientVersion());
  let declared: { sessionId: string; structure: SessionDeclaration } | undefined;
  server.registerTool(
    'forge_announce',
    {
      description:
        'Say what you are doing (status + summary, optional intentId/laneId/paths). Creates or updates this process session and keeps its last-seen fresh until status=completed. Returns sessionId and childEnvironment; pass childEnvironment to spawned subagents so their own MCP connections attach to this session.',
      inputSchema: {
        kind: coordinationSessionKindSchema.optional(),
        parentSessionId: z.string().uuid().optional(),
        harness: coordinationHarnessSchema.optional(),
        harnessVersion: z.string().min(1).max(L.name).optional(),
        summary: z.string().max(L.summary),
        status: z.enum(['working', 'waiting', 'observing', 'completed']).default('working'),
        intentId: ref.optional(),
        laneId: ref.optional(),
        paths: paths.optional(),
        name: z.string().min(1).max(L.name).default('Agent'),
        environment: z.string().min(1).max(L.name).default('MCP'),
        sessionId: z.string().uuid().optional().describe('Resume an earlier session of yours.'),
      },
      annotations: write,
    },
    async ({ summary, status, intentId, laneId, paths, name, environment, sessionId, ...identity }) => {
      const next = session.next(sessionId);
      const structure = declaration(
        identity,
        declared?.sessionId === next.sessionId ? declared.structure : undefined,
      );
      const reply = await result({
        action: 'publish',
        operationId: randomUUID(),
        command: {
          kind: 'activity',
          ...structure,
          ...next,
          name,
          environment,
          status,
          summary,
          context: {
            ...(intentId ? { intentId } : {}),
            ...(laneId ? { laneId } : {}),
            ...(paths ? { paths } : {}),
          },
        },
      });
      if (reply.isError) return reply;
      declared = { sessionId: next.sessionId, structure };
      session.confirm();
      const childEnvironment = { FORGE_PARENT_SESSION: next.sessionId };
      Object.assign(process.env, childEnvironment);
      if (status === 'completed') session.stop();
      else session.start();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...next,
              ...structure,
              status,
              heartbeat: session.heartbeat,
              childEnvironment,
            }),
          },
        ],
      };
    },
  );
  server.registerTool(
    'forge_claim',
    {
      description:
        'Advisory claim on paths you intend to change (a path covers that file or directory). Not a lock. Returns claimId, expiresAt and overlapping active claims by others. Pass claimId to renew or replace your own claim.',
      inputSchema: {
        paths: paths.min(1),
        intentId: ref.optional(),
        laneId: ref.optional(),
        ttlMinutes: z.number().int().min(1).max(1440).default(60),
        note: z.string().max(L.note).optional(),
        claimId: z.string().uuid().optional(),
        operationId,
      },
      annotations: write,
    },
    args => result({ action: 'claim', ...args, sessionId: session.announced }),
  );
  server.registerTool(
    'forge_release',
    {
      description: 'Release one of your claims.',
      inputSchema: { claimId: z.string().uuid(), operationId },
      annotations: write,
    },
    args => result({ action: 'release', ...args, sessionId: session.announced }),
  );
  server.registerTool(
    'forge_message',
    {
      description:
        'Send a message. to = a sessionId or participant (actor) from sessions; omit to broadcast. The recipient sees it in forge_inbox until they ack.',
      inputSchema: {
        text: z.string().min(1).max(L.text),
        choices: coordinationChoicesSchema.optional(),
        to: ref.optional(),
        intentId: ref.optional(),
        laneId: ref.optional(),
        paths: paths.optional(),
        operationId,
      },
      annotations: write,
    },
    args => result({ action: 'message', ...args, sessionId: session.announced }),
  );
  server.registerTool(
    'forge_handoff',
    {
      description:
        'Hand the next step to a session or participant, pinned to an exact head. Advisory: moves no access or ownership. Acked like a message.',
      inputSchema: {
        to: ref,
        summary: z.string().min(1).max(L.summary),
        head: ref.describe('Exact source pin (State or checkpoint) being handed over.'),
        intentId: ref.optional(),
        laneId: ref.optional(),
        operationId,
      },
      annotations: write,
    },
    args => result({ action: 'handoff', ...args, sessionId: session.announced }),
  );
  server.registerTool(
    'forge_ack',
    {
      description:
        'Acknowledge a message or handoff by its id, or answer with one of its exact choices (ack implied).',
      inputSchema: {
        messageId: z.string().uuid(),
        choice: z.string().min(1).max(L.choice).optional(),
        text: z.string().max(L.summary).default('Acknowledged'),
        operationId,
      },
      annotations: write,
    },
    args => result({ action: 'ack', ...args, sessionId: session.announced }),
  );
  server.registerTool(
    'forge_inbox',
    {
      description:
        'Messages and handoffs for you. Default: recent ones you have not acknowledged (including broadcasts). all=true pages everything addressed to you, with acked flags, from a cursor.',
      inputSchema: {
        all: z.boolean().default(false),
        cursor: z.string().max(4096).nullable().default(null),
        pageSize: z.number().int().positive().max(L.pageSize).default(50),
      },
      annotations: read,
    },
    ({ all, cursor, pageSize }) =>
      result(
        all
          ? { action: 'inbox', cursor, pageSize, sessionId: session.announced }
          : { action: 'unacked', limit: pageSize, sessionId: session.announced },
      ),
  );
}
