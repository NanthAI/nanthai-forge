// SPDX-License-Identifier: Apache-2.0
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentWait, agentWaitSchema } from './agent-wait.js';
import type { WaitEvent, WaitSummary } from './agent-wait.js';
import { ForgeError } from './errors.js';
import type { WorkStore } from './work-store.js';
export function registerAgentWait(server: McpServer, store: WorkStore) {
  server.registerTool(
    'forge_wait',
    {
      description:
        'Wait for local Lane/check/finish/land outcomes or any change. Returns one JSON line per observed change plus a summary; progress notifications carry events live when a progressToken is supplied. Read-only, no recovery, checks or network requests are started.',
      inputSchema: agentWaitSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => {
      const events: (WaitEvent | WaitSummary)[] = [];
      let notifications = Promise.resolve();
      try {
        const result = await agentWait(
          store,
          input,
          event => {
            events.push(event);
            const token = extra._meta?.progressToken;
            if (token !== undefined)
              notifications = notifications
                .then(() =>
                  extra.sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: events.length, message: JSON.stringify(event) },
                  }),
                )
                .catch(() => {});
          },
          extra.signal,
        );
        await notifications;
        return {
          ...(result.ok ? {} : { isError: true }),
          content: [{ type: 'text' as const, text: events.map(event => JSON.stringify(event)).join('\n') }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: {
                  code: error instanceof ForgeError ? error.code : 'INVALID_WAIT',
                  message: error instanceof Error ? error.message : 'Wait failed.',
                },
              }),
            },
          ],
        };
      }
    },
  );
}
