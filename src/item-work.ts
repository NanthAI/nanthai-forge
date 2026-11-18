// SPDX-License-Identifier: Apache-2.0
// The agent side of the shared Item work read (convex/projectItemWork.ts, Issue 1c2ab97a): `planning {id}`
// shows its first page as `work`, and `lanes {planningItemId, state:"all"}` pages it.
import type { HostedAgentTransport } from './hosted-agent-transport.js';

export type ItemWork = {
  role: boolean;
  intent?: string | null;
  intents?: number;
  lanes?: Record<string, unknown>[];
  total?: number;
  atLeast?: boolean;
  nextCursor?: string | null;
};

const missingFunction = (error: unknown) =>
  error instanceof Error &&
  /(?:Could not find (?:public )?function|No (?:public )?function found|Function .* not found)/i.test(
    error.message,
  );

/** One page of the Item's Lanes in any state. `null` when the server predates the read (callers fall back). */
export async function readItemWork(
  port: Pick<HostedAgentTransport, 'query'>,
  itemId: string,
  page: { limit?: number; cursor?: string | null } = {},
): Promise<ItemWork | null> {
  try {
    const reply = await port.query<ItemWork | string>('projectItemWork:read', {
      itemId,
      ...(page.limit ? { limit: page.limit } : {}),
      ...(page.cursor ? { cursor: page.cursor } : {}),
    });
    return typeof reply === 'string' ? (JSON.parse(reply) as ItemWork) : reply;
  } catch (error) {
    if (missingFunction(error)) return null;
    throw error;
  }
}

/** The `work` section of a single-Item read: the first page, its total, and how to read the rest. */
export function workSection(itemId: string, work: ItemWork) {
  return {
    lanes: work.lanes ?? [],
    total: work.total ?? 0,
    ...(work.atLeast ? { atLeast: true } : {}),
    ...(work.nextCursor
      ? {
          next: `nforge agent . lanes '${JSON.stringify({ planningItemId: itemId, state: 'all', cursor: work.nextCursor })}'`,
        }
      : {}),
  };
}
