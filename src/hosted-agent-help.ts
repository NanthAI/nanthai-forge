// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { hostedWaitSchema } from './hosted-agent-observe.js';
import { hostedSourceShowSchema } from './mcp-hosted-source.js';
import { newForm } from './agent-verbs.js';
import { hostedActionAlternative } from './hosted-agent-version.js';

/** Same schemas used by dispatch (and the server's advertised action contract). Client-only
 * wait/show have their own enforced schemas. No capability request is needed to print help. */
export const hostedAgentHelpEntries = [
  ...Object.entries(hostedAgentCommandSchemas),
  ['wait', hostedWaitSchema] as const,
  ['show', hostedSourceShowSchema.omit({ action: true })] as const,
].map(([action, schema]) => {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  // Client envelope fields are accepted outside the action schema by dispatch.
  json.properties = { ...json.properties };
  if (action === 'start') {
    json.properties.path = { type: 'string', minLength: 1 };
    json.properties.open = { type: 'boolean' };
  }
  if (!['status', 'observe', 'wait', 'show'].includes(action))
    json.properties.operationId = { type: 'string', format: 'uuid' };
  const required = new Set(json.required ?? []);
  const parameters = Object.keys(json.properties ?? {}).map(
    name => `${name}${required.has(name) ? '' : '?'}`,
  );
  return { action, command: newForm(action, {}, true) ?? action, parameters, schema: json };
});

export function hostedAgentHelp(action?: string) {
  const canonical =
    action === 'checkpoint' ? 'save' : action === 'run' ? 'check' : action === 'landing' ? 'observe' : action;
  const entries = canonical
    ? hostedAgentHelpEntries.filter(entry => entry.action === canonical)
    : hostedAgentHelpEntries;
  if (!entries.length) return `Hosted action ${action} is unavailable. ${hostedActionAlternative(action!)}\n`;
  return [
    'Forge hosted agent workflow',
    'nforge agent ROOT ACTION [JSON | --command-file FILE]',
    'Address: hosted checkout ROOT, retained address, or JSON url + projectId.',
    'Parameters (? = optional; nested fields and constraints follow the command schema):',
    ...entries.map(entry => `  ${entry.command}: ${entry.parameters.join(', ') || '{}'}`),
    ...(canonical ? entries.map(entry => JSON.stringify(entry.schema, null, 2)) : []),
    'land --save waits; --no-wait returns after submission. Use --check-only to check without landing.',
    'land --save overlapAnswer:"accept-order" answers the pending notices for this landing and records them like ack, so peers see the answer.',
    'status accepts laneId; observe/landing select operationId (original landing UUID), submissionId or runId.',
    'Hosted peers and diff are unavailable. Read start/save/status unacknowledgedOverlaps and behindMain; bounded saved-path advice excludes unsaved peer edits and never proves independence.',
    'Use show {channel:"main",path} or show {laneId,path} for exact accepted or saved bytes, then compare local files. This supplies no pinned base-to-head diff. forge_peers and detailed review are native-only.',
    'Keep every original parameter, including message and pins, when replaying an operationId. Use the receipt replay command.',
    'wait {operationIds:[ORIGINAL_UUID]} watches a landing; wait {runId} watches a check. Transient observation failures retry until the deadline; exit 3 means still in progress and prints the exact wait command.',
    '',
  ].join('\n');
}

export function hostedAgentHelpMarkdown() {
  return [
    '<!-- hosted-agent-contract:start -->',
    '| Hosted command | Accepted parameters (`?` = optional) |',
    '| --- | --- |',
    ...hostedAgentHelpEntries.map(
      entry =>
        `| \`${entry.command}\` | ${entry.parameters.map(name => `\`${name}\``).join(', ') || '`{}`'} |`,
    ),
    '<!-- hosted-agent-contract:end -->',
  ].join('\n');
}
