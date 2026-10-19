// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { Workspace } from './workspace.js';
import { ForgeError } from './errors.js';
export function mcpConfig(root: string, options: { agent?: boolean } = {}) {
  const workspace = new Workspace(root);
  return {
    mcpServers: {
      forge: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./cli.js', import.meta.url)),
          'mcp',
          workspace.root,
          ...(options.agent ? ['--agent'] : []),
        ],
      },
    },
  };
}
export function doctor(root: string): object {
  const workspace = new Workspace(root);
  try {
    const query = workspace.query();
    const status = query.status();
    return {
      ready: query.freshness === 'current',
      node: process.version,
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
      error: { code: error.code, message: error.message },
      next: 'Run index, then doctor again.',
    };
  }
}
