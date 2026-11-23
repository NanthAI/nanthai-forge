// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgeError } from './errors.js';
import { McpStdioTransport } from './mcp-stdio.js';
import { findPublicProjects, publicProjectSite } from './public-project-lookup.js';

export async function startPublicProjectMcp(site?: string) {
  const origin = publicProjectSite(site);
  const server = new McpServer({ name: 'nanthai-forge-public', version: '0.2.0' });
  server.registerTool(
    'forge_find_project',
    {
      description: 'Find public Forge projects by name or handle/slug and get their URLs and clone commands.',
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ name }) => {
      try {
        const value = await findPublicProjects(name, origin);
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (error) {
        const failure =
          error instanceof ForgeError
            ? { code: error.code, message: error.message }
            : { code: 'INTERNAL_ERROR', message: 'Forge could not complete the lookup.' };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: failure }) }] };
      }
    },
  );
  await server.connect(new McpStdioTransport());
}
