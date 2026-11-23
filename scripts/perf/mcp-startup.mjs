// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Copied beside the installed manifest so SDK imports use exactly its runtime closure.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const { registerAgentWorkflow } = await import(new URL('dist/mcp-agent-workflow.js', process.argv[2]));
const server = new McpServer({ name: 'nanthai-forge', version: 'synthetic' });
const close = registerAgentWorkflow(server, '/nonexistent', {
  root: '/nonexistent',
  address: { url: 'https://fixture.invalid', projectId: 'synthetic' },
  query() {
    throw new Error('MCP listing attempted a server call');
  },
});
const client = new Client({ name: 'weight-probe', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
await client.connect(b);
const tools = (await client.listTools()).tools;
console.log(JSON.stringify({ toolListBytes: Buffer.byteLength(JSON.stringify(tools)) }));
close();
await client.close();
await server.close();
