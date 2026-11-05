// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { Workspace } from './workspace.js';
import { ForgeError } from './errors.js';
import { probeLocalWatching } from './local-watcher.js';
import { filesystemEventHealth, filesystemEnvironment } from './filesystem-event-health.js';

import { shellQuote } from './shell-quote.js';
import { hookHealth } from './agent-hook-health.js';

export const diagnosticRuntime = { filesystemEventHealth };
export function mcpConfig(root: string, options: { agent?: boolean } = {}) {
  const workspace = new Workspace(root);
  return {
    mcpServers: {
      forge: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./cli-entry.js', import.meta.url)),
          'mcp',
          workspace.root,
          ...(options.agent ? ['--agent'] : []),
        ],
      },
    },
  };
}
export async function doctor(root: string): Promise<object> {
  const workspace = new Workspace(root);
  const watching = await probeLocalWatching();
  const health = diagnosticRuntime.filesystemEventHealth(root);
  const filesystemEvents = health.ok
    ? { status: 'healthy', health }
    : { status: 'environment', ...filesystemEnvironment(health, `nforge doctor ${shellQuote(root)}`) };
  try {
    const query = workspace.query();
    const status = query.status();
    return {
      ready: query.freshness === 'current',
      node: process.version,
      watching,
      filesystemEvents,
      hooks: hookHealth(root),
      transport: 'stdio',
      targetExecution: false,
      networkRequired: false,
      status,
    };
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    return {
      ready: false,
      node: process.version,
      watching,
      filesystemEvents,
      hooks: hookHealth(root),
      error: { code: error.code, message: error.message },
      next: 'Run index, then doctor again.',
    };
  }
}
