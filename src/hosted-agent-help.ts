import { hostedDiffSchema, hostedPeersSchema } from './hosted-agent-reads.js';
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
  ['diff', hostedDiffSchema] as const,
  ['peers', hostedPeersSchema] as const,
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
  if (!['status', 'observe', 'wait', 'show', 'diff', 'peers'].includes(action))
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
    'First CLI run installs advisory Claude Code/Codex first-write hooks for every Lane. nforge x ROOT install-hooks|uninstall-hooks {scope?:"user"|"project"} controls local setup; uninstall defaults to user and persists off. nforge settings firstWriteHooks false disables them. Hooks never deny edits; hosted coverage excludes unsaved edits, uses one query per uncached path/session and fails open within one second.',
    'land --save waits; --no-wait returns after submission. Use --check-only to check without landing.',
    'land --save overlapAnswer:"accept-order" answers the pending notices for this landing and records them like ack, so peers see the answer.',
    'pull {} refreshes a clean clone root to main; a repeat resumes interruption. Root status {} reports clone freshness.',
    'status accepts laneId; observe/landing select operationId (original landing UUID), submissionId or runId.',
    'peers {laneId?,path?,detail?} reads current saved overlap evidence in one query. Coverage excludes unsaved peer edits and never proves independence. start/save/status retain unacknowledgedOverlaps and behindMain.',
    'diff {laneId?,paths?,byteBudget?,cursor?} compares pinned base to saved head; nextCursor continues that pair. show {state?|candidateId?|laneId?|channel:"main",path} reads exact bytes. forge_review exposes show/diff/peers.',
    'Keep every original parameter, including message and pins, when replaying an operationId. Use the receipt replay command.',
    'Keep this turn active while your work is unfinished. Resume with the receipt command: wait {operationIds:[ORIGINAL_UUID],until:"acceptance",timeoutSeconds:3600}; check-only work uses wait {runId,timeoutSeconds:3600}. Transient observation failures retry until the deadline. Exit 3 is IN PROGRESS: run the same wait again. Terminal failure follows its recovery command; LANDED is acceptance, CHECK PASSED alone is not.',
    '',
  ].join('\n');
}

export function hostedAgentHelpMarkdown() {
  return [
    '<!-- hosted-agent-contract:start -->',
    '| Hosted command | Accepted parameters (`?` = optional) |',
    '| --- | --- |',
    ...hostedAgentHelpEntries.map(
      entry => `| \`${entry.command}\` | ${`\`${entry.parameters.join(', ') || '{}'}\``} |`,
    ),
    '<!-- hosted-agent-contract:end -->',
  ].join('\n');
}
