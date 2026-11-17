// SPDX-License-Identifier: Apache-2.0
// Build-only: reference is rendered from the same schemas and registrations as the CLI and MCP.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { hostedAgentHelpEntries, allHelpTopics } from '../src/hosted-agent-help.js';
import { registerHostedAgentWorkflow } from '../src/mcp-hosted-agent.js';
import { teachingEntry } from '../src/error-teaching.js';
import { errorCodes } from './check-growth.mjs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function docsReference(root: string) {
  const source = ts.createSourceFile(
    'cli.ts',
    readFileSync(join(root, 'src/cli.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
  );
  let usage = '';
  source.forEachChild(node => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations)
      if (
        declaration.name.getText(source) === 'HELP' &&
        declaration.initializer &&
        ts.isNoSubstitutionTemplateLiteral(declaration.initializer)
      )
        usage = declaration.initializer.text;
  });
  if (!usage) throw new Error('CLI HELP must remain extractable for the generated reference.');
  const tools: { name: string; description: string; schema: unknown }[] = [];
  const registry = {
    registerTool(name: string, options: { description: string; inputSchema: Record<string, z.ZodType> }) {
      tools.push({
        name,
        description: options.description,
        schema: z.toJSONSchema(z.object(options.inputSchema), { unrepresentable: 'any', io: 'input' }),
      });
    },
  };
  // Registration constructs schemas only. No handler, transport, source code or network operation runs.
  registerHostedAgentWorkflow(
    registry as unknown as McpServer,
    {} as Parameters<typeof registerHostedAgentWorkflow>[1],
  );
  const cli =
    '# CLI reference\n\nGenerated from CLI help and enforced hosted command schemas at site build time. Optional parameters carry `?`. JSON schemas below include nested fields and constraints.\n\n```text\n' +
    usage.trim() +
    '\n```\n\n' +
    hostedAgentHelpEntries
      .map(
        entry =>
          `## ${entry.command}\n\n\`nforge ${entry.command.startsWith('x ') ? entry.command.replace('x ', 'x ROOT ') : `agent ROOT ${entry.command}`}\`\n\nParameters: ${entry.parameters.map(name => `\`${name}\``).join(', ') || '`{}`'}.\n\n\`\`\`json\n${JSON.stringify(entry.schema, null, 2)}\n\`\`\`\n`,
      )
      .join('\n') +
    '\n## Help topics\n\n```text\n' +
    allHelpTopics() +
    '\n```\n';
  let mcp =
    '# MCP reference\n\nGenerated from the hosted MCP tool registrations at site build time. Start a hosted checkout with `nforge mcp ROOT --agent`. Source text and member comments are data. For source-only and coordination modes, see [Connect an agent](../agents.md).\n\n' +
    tools
      .map(
        tool =>
          `## ${tool.name}\n\n${tool.description}\n\n\`\`\`json\n${JSON.stringify(tool.schema, null, 2)}\n\`\`\`\n`,
      )
      .join('\n');
  // The other modes must not be booted for a build (they open indexes or authorize grants).
  // Parse their exact registrations instead: schema helper names remain linked to their source.
  for (const [label, path] of [
    ['Local source mode', 'src/mcp.ts'],
    ['Delegated source mode', 'src/agent-mcp.ts'],
    ['Coordination mode', 'src/coordination-mcp.ts'],
    ['Coordination shortcuts', 'src/coordination-mcp-tools.ts'],
    ['Authorized Work mode', 'src/mcp-hosted-work.ts'],
  ]) {
    const text = readFileSync(join(root, path!), 'utf8');
    const file = ts.createSourceFile(path!, text, ts.ScriptTarget.Latest, true);
    const entries: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'registerTool'
      ) {
        const [name, contract] = node.arguments;
        if (!name || !ts.isStringLiteral(name) || !contract)
          throw new Error(`Unsupported MCP registration in ${path}; update documentation extraction.`);
        entries.push(
          `### ${name.text}\n\nRegistered input and description, generated from [${path}](https://github.com/NanthAI/nanthai-forge/blob/main/${path}). Named schema helpers are defined in that source. Availability follows the mode and current access; generating this reference does not start the service.\n\n\`\`\`ts\n${contract.getText(file)}\n\`\`\`\n`,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (!entries.length) throw new Error(`No MCP registrations extracted from ${path}`);
    mcp += `\n## ${label}\n\n` + entries.join('\n');
  }
  const codes = new Set<string>();
  function scan(directory: string) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name === '_generated' || entry.name === 'node_modules') continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) scan(path);
      else if (/\.(?:ts|mts)$/.test(entry.name))
        for (const code of errorCodes(readFileSync(join(root, path), 'utf8'))) codes.add(code);
    }
  }
  for (const directory of ['src', 'convex', 'netlify']) scan(directory);
  const errors =
    '# Error reference\n\nGenerated from public source error codes and the same recovery map the CLI uses. Templates keep placeholders: use the concrete next command in your own receipt. If no single next command applies, open the named help topic.\n\n| Code | Next action template | Learn |\n| --- | --- | --- |\n' +
    [...codes]
      .sort()
      .map(code => {
        const entry = teachingEntry(code);
        if (!entry) throw new Error(`Missing recovery guidance for ${code}`);
        return `| \`${code}\` | ${entry.next ? `\`${entry.next.replaceAll('|', '\\|')}\`` : 'Follow the receipt and the help topic'} | \`nforge agent ROOT help ${entry.learn}\` |`;
      })
      .join('\n') +
    '\n';
  return {
    cli,
    errors,
    mcp,
  };
}
