// SPDX-License-Identifier: Apache-2.0
import { hostedHistorySchema } from './hosted-history-schema.js';
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
  ['history', hostedHistorySchema] as const,
].map(([action, schema]) => {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  // Client envelope fields are accepted outside the action schema by dispatch.
  json.properties = { ...json.properties };
  if (action === 'start') {
    const model = json.properties.model;
    if (model && typeof model === 'object')
      model.description ??= 'Declare the model ID or "unknown" when an agent session starts.';
    json.properties.path = { type: 'string', minLength: 1 };
    json.properties.open = { type: 'boolean' };
    json.properties.installScripts = { type: 'boolean' };
  }
  if (
    !['history', 'status', 'observe', 'friction-list', ...Object.keys(hostedClientReadSchemas)].includes(
      action,
    )
  )
    json.properties.operationId = { type: 'string', format: 'uuid' };
  const required = new Set(json.required ?? []);
  const parameters = Object.keys(json.properties ?? {}).map(
    name => `${name}${action === 'start' && name === 'model' ? '*' : required.has(name) ? '' : '?'}`,
  );
  return {
    action,
    command: newForm(action, {}, true) ?? action,
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
  flow: 'lanes',
  history: 'review',
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
    'Hosted ROOT, retained address, or url + projectId. Guide: nforge docs agent.',
    'Parameters (? = optional, * = required for a new agent session unless FORGE_AGENT_MODEL supplies it):',
    ...entries.map(entry => {
      // The overview explains operationId once. Action help and generated docs list every field.
      const parameters = canonical
        ? entry.parameters
        : entry.parameters.filter(field => field !== 'operationId?');
      return `  ${entry.command}: ${parameters.join(', ') || '{}'}${entry.action === 'history' ? ' — log, blame, show' : ''}`;
    }),
    ...(canonical
      ? entries.flatMap(entry => [helpExample(entry), JSON.stringify(entry.schema, helpSchemaField, 2)])
      : []),
    ...(topic
      ? [helpTopicText(topic)]
      : canonical
        ? []
        : [
            'Run land --save from the Lane. LANDED confirms acceptance.',
            'Run waitCommand in the foreground until terminal; exit 3 means wait again.',
            'Replay the receipt command with its original operationId and parameters.',
            'Errors show {code,message,next,learn}. Full receipts use --detail or MCP replyDetail:true.',
            helpTopicIndex(),
            'MCP schemas: forge_work_overview {action:"help",topic}. Forms: nforge docs agents/workflow.',
            '',
          ]),
  ].join('\n');
}

/** Journey 61 (Issue 47558a99): an action's help leads with a runnable short form, and its schema prints
 * a uuid as `format: uuid` without the 180-character pattern Zod repeats for every id field. */
function helpSchemaField(key: string, value: unknown) {
  if (key !== '' && value && typeof value === 'object' && (value as { format?: unknown }).format === 'uuid') {
    return Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'pattern'));
  }
  return value;
}
const placeholder = (field: string, schema: Record<string, unknown> | undefined): unknown =>
  schema?.format === 'uuid'
    ? `${field
        .replace(/Id$/, '')
        .replace(/[A-Z]/g, c => `_${c}`)
        .toUpperCase()}_ID`
    : schema?.type === 'boolean'
      ? true
      : schema?.type === 'number' || schema?.type === 'integer'
        ? 1
        : schema?.type === 'array'
          ? []
          : Array.isArray(schema?.enum)
            ? schema.enum[0]
            : '…';
function helpExample(entry: (typeof hostedAgentHelpEntries)[number]) {
  const properties = (entry.schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (entry.schema.required ?? []) as string[];
  const example =
    entry.action === 'start'
      ? { outcome: 'Improve the README', model: 'unknown' }
      : Object.fromEntries(required.map(field => [field, placeholder(field, properties[field])]));
  const command = entry.command.startsWith('x ')
    ? `nforge x ROOT ${entry.command.slice(2)}`
    : `nforge agent ROOT ${entry.command}`;
  return `Example: ${command} '${JSON.stringify(example)}'`;
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
    '| Hosted command | Accepted parameters (`?` = optional, `*` = required for a new agent session unless `FORGE_AGENT_MODEL` supplies it) |',
    '| --- | --- |',
    ...hostedAgentHelpEntries.map(
      entry => `| \`${entry.command}\` | ${`\`${entry.parameters.join(', ') || '{}'}\``} |`,
    ),
    '<!-- hosted-agent-contract:end -->',
  ].join('\n');
}
