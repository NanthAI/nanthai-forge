// SPDX-License-Identifier: Apache-2.0
import { compactOverlapNotice } from './agent-peers-bound.js';
import { onOverlapPublication } from './agent-coordination-events.js';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { mkdirBelow } from './mkdir-below.js';
import { CoordinationJournal } from './agent-coordination-journal.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkStore } from './work-store.js';
/** Event-driven local fanout: no timers, network subscriptions or idle calls. */
export function overlapNotifications(server: McpServer, store: WorkStore) {
  const lanes = new Set<string>(),
    seen = new Set<string>();
  let closed = false;
  let stop = () => {};
  const publish = () => {
    if (closed) return;
    try {
      for (const laneId of lanes)
        for (const notice of new CoordinationJournal(store).overlaps(laneId)) {
          const key = `${laneId}:${notice.noticeId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          void server
            .sendLoggingMessage({
              level: 'notice',
              logger: 'forge-overlap',
              data: { laneId, ...compactOverlapNotice(notice) },
            })
            .catch(() => {
              // The durable inbox is still delivered by the next result.
            });
        }
    } catch {
      /* An incomplete journal never blocks source work. */
    }
  };
  // Minimal test/embedded transports may provide only tool registration.
  if (typeof server.server?.registerCapabilities === 'function') {
    server.server.registerCapabilities({ logging: {} });
    const off = onOverlapPublication(store, publish);
    stop = off;
    try {
      const directory = join(store.directory, 'coordination');
      mkdirBelow(store.directory, directory);
      const watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (!name || !name.toString().startsWith('.pending-')) publish();
      });
      watcher.on('error', () => watcher.close());
      stop = () => {
        off();
        watcher.close();
      };
    } catch {
      /* Results carry notices on transports without local watching. */
    }
  }
  return {
    select(laneId?: string) {
      if (laneId) {
        lanes.add(laneId);
        publish();
      }
    },
    close() {
      closed = true;
      stop();
    },
  };
}
