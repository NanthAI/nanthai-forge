// SPDX-License-Identifier: Apache-2.0
import { hasSavedAuth } from './auth-store.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  exchangeCommand,
  exchangeMigrateSchema,
  exchangePullSchema,
  mainPullSchema,
} from './exchange-cli.js';
import { ForgeError } from './errors.js';
export function registerExchangeTools(server: McpServer, root: string) {
  if (!process.env.FORGE_AUTH_TOKEN && !hasSavedAuth()) return;
  const command = z.discriminatedUnion('action', [
    mainPullSchema.extend({ action: z.literal('open'), targetDirectory: z.string().min(1) }),
    exchangePullSchema.extend({ action: z.literal('restore'), targetDirectory: z.string().min(1) }),
    exchangePullSchema.extend({ action: z.literal('pull'), targetDirectory: z.string().min(1) }),
  ]);
  async function run(action: string, input: unknown, destination = root) {
    try {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(await exchangeCommand(destination, action, input)) },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: {
                code: error instanceof ForgeError ? error.code : 'EXCHANGE_FAILED',
                message:
                  error instanceof ForgeError
                    ? error.message
                    : 'Exchange did not complete; retain original operation IDs and reconcile the same request.',
              },
            }),
          },
        ],
      };
    }
  }
  server.registerTool(
    'forge_exchange',
    {
      description:
        'Exchange missing native source/artifact content and reusable large-file chunks with the current signed-in Forge project. Logical source hashes stay unchanged; upload counts/bytes describe physical transfers, not retained history or performance guarantees. Open checks out selected hosted main in targetDirectory; restore (legacy pull) restores an independent owner. No source history deletion or automatic acceptance. Retain all original IDs after unknown outcomes. Auth comes from nforge login or FORGE_AUTH_TOKEN.',
      inputSchema: { command },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command }) => {
      const { action, targetDirectory, ...request } = command;
      return run(action, request, targetDirectory);
    },
  );
  server.registerTool(
    'forge_migrate_archive',
    {
      description:
        'Explicitly convert one existing native archive to shared immutable objects after exact logical-byte and source-closure verification. Preserves exact logical source/Work/artifact bytes, original backup IDs and archive provenance. Retires exclusively owned compressed-container bytes, whose exact container encoding is no longer recoverable. Requires an explicitly selected original archive path/digest and operationId; never applies retention or bulk migration.',
      inputSchema: exchangeMigrateSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    args => run('migrate-archive', args),
  );
}
