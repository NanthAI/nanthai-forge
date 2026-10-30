// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const inbox = z.object({
  unacknowledgedOverlaps: z.object({ items: z.array(z.looseObject({ noticeId: z.string() })) }),
});
/** Fan out only returned advice. There is no observer or idle network activity. */
export function hostedOverlapNotifications(server: McpServer) {
  const seen = new Set<string>();
  if (typeof server.server?.registerCapabilities === 'function')
    server.server.registerCapabilities({ logging: {} });
  return async <T>(response: T): Promise<T> => {
    const parsed = inbox.safeParse(response);
    if (!parsed.success || typeof server.sendLoggingMessage !== 'function') return response;
    for (const notice of parsed.data.unacknowledgedOverlaps.items) {
      if (seen.has(notice.noticeId)) continue;
      seen.add(notice.noticeId);
      try {
        await server.sendLoggingMessage({ level: 'notice', logger: 'forge-overlap', data: notice });
      } catch {
        /* The same advice remains in the returned response. */
      }
    }
    return response;
  };
}
