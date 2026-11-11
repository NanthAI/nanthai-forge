// SPDX-License-Identifier: Apache-2.0
import { hostedClientReadSchemas } from './hosted-agent-reads.js';
import { z } from 'zod';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { newForm } from './agent-verbs.js';
import { hostedActionAlternative } from './hosted-agent-version.js';
import { type HelpTopicId, helpTopicIndex, helpTopics, helpTopicText, isHelpTopic } from './help-topics.js';

/** Same schemas used by dispatch (and the server's advertised action contract). Client-only
 * wait/show have their own enforced schemas. No capability request is needed to print help. */
export const hostedAgentHelpEntries = [
  ...Object.entries(hostedAgentCommandSchemas),
  ...Object.entries(hostedClientReadSchemas),
].map(([action, schema]) => {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  // Client envelope fields are accepted outside the action schema by dispatch.
  json.properties = { ...json.properties };
  if (action === 'start') {
    json.properties.path = { type: 'string', minLength: 1 };
    json.properties.open = { type: 'boolean' };
    json.properties.installScripts = { type: 'boolean' };
  }
  if (!['status', 'observe', 'friction-list', ...Object.keys(hostedClientReadSchemas)].includes(action))
    json.properties.operationId = { type: 'string', format: 'uuid' };
  const required = new Set(json.required ?? []);
  const parameters = Object.keys(json.properties ?? {}).map(
    name => `${name}${required.has(name) ? '' : '?'}`,
  );
  return {
    action,
    command: newForm(action, {}, true) ?? action.replace(/^board-/, 'board --'),
    parameters,
    schema: json,
  };
});

/** The help topic that explains an action, printed after its schema (Issue 0a7d6f56). */
const actionTopic: Record<string, HelpTopicId> = {
  finish: 'land',
  withdraw: 'land',
  'land-ready': 'land',
  preflight: 'land',
  wait: 'wait',
  status: 'wait',
  observe: 'wait',
  resolve: 'conflict',
  sync: 'conflict',
  'recover-apply': 'conflict',
  save: 'lanes',
  open: 'lanes',
  reopen: 'lanes',
  complete: 'lanes',
  cancel: 'queue',
  prioritize: 'queue',
  peers: 'overlap',
  check: 'check',
  start: 'lanes',
  lanes: 'lanes',
  'lane-history': 'lanes',
  abandon: 'lanes',
  'abandon-dormant': 'lanes',
  pull: 'hosted',
  diff: 'review',
  show: 'review',
  queue: 'queue',
  landings: 'queue',
  board: 'board',
  'board-post': 'board',
  'board-reply': 'board',
  'board-resolve': 'board',
  planning: 'planning',
  'put-planning-item': 'planning',
  'comment-planning-item': 'planning',
  friction: 'planning',
};

export function hostedAgentHelp(action?: string) {
  const canonical =
    action === 'checkpoint' ? 'save' : action === 'run' ? 'check' : action === 'landing' ? 'observe' : action;
  if (canonical === 'log')
    return 'nforge agent ROOT log \'{"runId":"RUN_ID","tail":8192}\'\nPrints the retained, redacted output of a hosted check run (a bounded tail of what Forge keeps, at most 64 KiB per job): the output on stdout, one line about it on stderr. runId is the check run in a status, observe or wait receipt. Optional: tail (bytes, 1 to 65536, default 8192), stream "stdout"|"stderr", shard, attempt, json:true (structured result with streams, status and provider link). Same access as the run: project members, or anyone for a public project. The full log stays with the provider (the stderr line names its link). One manifest query, one per 50 streams and one signed download per chunk read; idle 0.\n';
  const entries = canonical
    ? hostedAgentHelpEntries.filter(entry => entry.action === canonical)
    : hostedAgentHelpEntries;
  if (!entries.length) return `Hosted action ${action} is unavailable. ${hostedActionAlternative(action!)}\n`;
  const topic = canonical ? actionTopic[canonical] : undefined;
  return [
    'Forge hosted agent workflow',
    'nforge agent ROOT ACTION [JSON | --command-file FILE]; actions listed as `x ACTION` run as nforge x ROOT ACTION [JSON | --command-file FILE].',
    'Address: hosted checkout ROOT, retained address, or JSON url + projectId. Guide: nforge docs agent.',
    'Parameters (? = optional; nested fields and constraints follow the command schema):',
    ...entries.map(entry => `  ${entry.command}: ${entry.parameters.join(', ') || '{}'}`),
    ...(canonical ? entries.map(entry => JSON.stringify(entry.schema, null, 2)) : []),
    ...(topic
      ? [helpTopicText(topic)]
      : canonical
        ? []
        : [
            'land --save from the Lane folder saves, updates from main, checks and lands; LANDED is acceptance, CHECK PASSED alone is not.',
            'Keep this turn active while your work is unfinished: run the receipt waitCommand in the foreground; exit 3 means run the same wait again.',
            'Replaying an operationId keeps every original parameter, including message; use the receipt replay command.',
            'Errors print {code,message,next,learn}: run next, and run learn once for the topic. Receipts are brief; --detail prints all fields and available bodies (replay mutations with the original operationId). MCP: command.replyDetail:true; forge_wait: top level.',
            helpTopicIndex(),
            'MCP: forge_work_overview {action:"help",topic} returns any action\'s exact schema, or a topic.',
            '',
          ]),
  ].join('\n');
}

/** `help TOPIC`: one topic; an action name prints that action's help. No network. */
export function hostedHelpFor(topic: string) {
  if (isHelpTopic(topic)) return helpTopicText(topic);
  return hostedAgentHelpEntries.some(entry => entry.action === topic) || topic === 'log'
    ? hostedAgentHelp(topic)
    : undefined;
}

/** Every topic in one document, for `nforge docs agents/hosted`. */
export const allHelpTopics = () =>
  Object.keys(helpTopics)
    .map(id => helpTopicText(id as HelpTopicId))
    .join('\n');

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
