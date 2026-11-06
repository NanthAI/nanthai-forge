// SPDX-License-Identifier: Apache-2.0
// Usage: node scripts/measure-agent-context.mjs   (after npm run build:core)
// Prints the hosted agent MCP tool list per tool: description, input schema and total characters, with
// tokens approximated as characters / 4. Receipts: compare `nforge agent ROOT ACTION` with `--detail`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';

const root = '/nonexistent';
const transport = { root, address: { url: 'https://measure.invalid', projectId: 'project' } };
const server = new McpServer({ name: 'nanthai-forge', version: 'measure' });
registerAgentWorkflow(server, root, transport);
const client = new Client({ name: 'measure', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
await client.connect(b);
const rows = (await client.listTools()).tools.map(tool => ({
  tool: tool.name,
  description: tool.description?.length ?? 0,
  schema: JSON.stringify(tool.inputSchema).length,
  total: JSON.stringify(tool).length,
}));
const total = rows.reduce((n, row) => n + row.total, 0);
console.table(rows);
console.log(`tools/list ${total} characters, about ${Math.ceil(total / 4)} tokens (characters / 4)`);
process.exit(0);
