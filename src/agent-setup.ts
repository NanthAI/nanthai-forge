// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join, resolve } from 'node:path';
export type BriefSetup = { machine: string | null; mcpConfigured: boolean };
/** Observe configuration without returning config contents, credentials, or running clients. */
export function localAgentSetup(root: string, liveMcp = false): BriefSetup {
  const machine = process.env.FORGE_MACHINE ?? hostname();
  const configured = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const servers = (value as { mcpServers?: Record<string, { args?: unknown }> }).mcpServers;
    return Object.values(servers ?? {}).some(server => {
      const args = server.args;
      if (!Array.isArray(args) || !args.includes('mcp') || !args.includes('--agent')) return false;
      const target = args[args.indexOf('mcp') + 1];
      try {
        return typeof target === 'string' && realpathSync(resolve(target)) === realpathSync(root);
      } catch {
        return false;
      }
    });
  };
  for (const file of [
    join(root, '.mcp.json'),
    join(root, '.cursor/mcp.json'),
    join(root, '.vscode/mcp.json'),
  ]) {
    try {
      if (configured(JSON.parse(readFileSync(file, 'utf8')))) return { machine, mcpConfigured: true };
    } catch {
      /* Missing/invalid configuration is not evidence of configured tools. */
    }
  }
  try {
    const toml = readFileSync(join(homedir(), '.codex/config.toml'), 'utf8');
    for (const section of toml.split(/(?=^\[)/m)) {
      if (!/^\[mcp_servers\.[^\]]+\]/.test(section)) continue;
      const line = section.match(/^args\s*=\s*(\[[^\n]*\])/m)?.[1];
      if (line && configured({ mcpServers: { forge: { args: JSON.parse(line) } } }))
        return { machine, mcpConfigured: true };
    }
  } catch {
    /* No known client configuration. */
  }
  return { machine, mcpConfigured: liveMcp };
}
