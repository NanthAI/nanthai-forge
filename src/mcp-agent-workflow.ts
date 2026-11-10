// SPDX-License-Identifier: Apache-2.0
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { hostedRootRequired } from './agent-root.js';
import { hostedAgentAddress } from './hosted-agent-cli.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { registerHostedAgentWorkflow } from './mcp-hosted-agent.js';
import { agentSessionKey } from './hosted-agent-journal.js';

/** MCP agent tools serve a hosted project only; a folder without a hosted marker is refused. */
export function registerAgentWorkflow(server: McpServer, root: string, hosted?: HostedAgentTransport) {
  const address = hosted ? null : hostedAgentAddress(root, {});
  if (!hosted && !address) throw hostedRootRequired(root);
  const transport = hosted ?? new HostedAgentTransport(root, address!);
  // One MCP server serves one agent session for its life: an identical start replays only here.
  transport.agentSession ??= agentSessionKey() ?? `mcp:${randomUUID()}`;
  return registerHostedAgentWorkflow(server, transport);
}
