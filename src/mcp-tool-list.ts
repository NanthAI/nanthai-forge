// SPDX-License-Identifier: Apache-2.0
import { helpTopicText, helpTopics, isHelpTopic } from './help-topics.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * The advertised tool list is the per-session context cost of Forge (Issue 47558a99). Zod's JSON Schema
 * repeats every shared field, regex and `additionalProperties` once per action variant (about 49k chars for
 * eight tools), while agents need action names, required fields and field names. The listing therefore
 * carries one flat property table plus one required-field signature per action; validation stays on the
 * strict Zod schemas, and `help` returns the exact per-action schema and the long prose on demand.
 */
type Json = Record<string, unknown>;
type Tool = { name: string; description?: string; inputSchema: Json } & Json;

/** Validation-only keywords; the strict Zod schema still enforces all of them on every call. */
const NOISE = new Set([
  '$schema',
  'pattern',
  'format',
  'additionalProperties',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'default',
  'title',
]);
const isObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Same schema without validation-only keywords; names, types, enums, consts and requireds stay. */
export function stripSchemaNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaNoise);
  if (!isObject(node)) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (NOISE.has(key) && !isObject(value)) continue;
    // A property literally named like a keyword (for example `format`) is a property, not a keyword.
    out[key] =
      key === 'properties' && isObject(value) ? mapValues(value, stripSchemaNoise) : stripSchemaNoise(value);
  }
  return out;
}
const mapValues = (value: Json, map: (v: unknown) => unknown): Json =>
  Object.fromEntries(Object.entries(value).map(([key, v]) => [key, map(v)]));

function variantsOf(tool: Tool): Json[] | undefined {
  const command = (tool.inputSchema.properties as Json | undefined)?.command;
  const variants = isObject(command) ? command.anyOf : undefined;
  return Array.isArray(variants) && variants.every(isObject) ? (variants as Json[]) : undefined;
}
const actionOf = (variant: Json): string | undefined => {
  const action = (variant.properties as Json | undefined)?.action;
  return isObject(action) && typeof action.const === 'string' ? action.const : undefined;
};
const modeOf = (variant: Json): string | undefined => {
  const mode = (variant.properties as Json | undefined)?.mode;
  return isObject(mode) && Array.isArray(mode.enum) ? mode.enum.join('|') : undefined;
};

/** `save:sync|candidate(laneId)`: the action, its mode if any and the fields it requires. Actions with
 * neither (bare `pull`) are only in the `action` enum. */
function signature(variant: Json): string | undefined {
  const action = actionOf(variant);
  if (!action) return undefined;
  const mode = modeOf(variant);
  const required = ((variant.required as string[] | undefined) ?? []).filter(
    key => key !== 'action' && key !== 'mode',
  );
  if (!mode && !required.length) return undefined;
  return `${action}${mode ? `:${mode}` : ''}${required.length ? `(${required.join(',')})` : ''}`;
}

/** Required-field signatures; actions with identical required fields share one entry (`check/run(checkId)`). */
function groupSignatures(variants: Json[]): string[] {
  const out: string[] = [];
  const shared = new Map<string, string[]>();
  for (const variant of variants) {
    const text = signature(variant);
    if (!text) continue;
    const at = text.indexOf('(');
    if (modeOf(variant) || at < 0) {
      if (!out.includes(text)) out.push(text);
    } else {
      const key = text.slice(at);
      shared.set(key, [...(shared.get(key) ?? []), text.slice(0, at)]);
    }
  }
  for (const [key, names] of shared) out.push(`${[...new Set(names)].join('/')}${key}`);
  return out;
}

const TYPE_MARK: Record<string, string> = {
  boolean: ':b',
  integer: ':n',
  number: ':n',
  object: ':o',
  array: ':a',
};
/** One field as a token: `name`, `name:b|n|o|a` for a non-string type, `name=a|b` for a short enum. */
function fieldToken(key: string, seen: Json[]): string {
  const values = [
    ...new Set(
      seen.flatMap(schema =>
        Array.isArray(schema.enum) ? schema.enum : schema.const !== undefined ? [schema.const] : [],
      ),
    ),
  ];
  const listed = seen.every(schema => schema.enum !== undefined || schema.const !== undefined);
  if (listed && values.length > 0 && values.length <= 6) return `${key}=${values.join('|')}`;
  const types = new Set(seen.map(schema => schema.type));
  const type = types.size === 1 ? [...types][0] : undefined;
  return `${key}${typeof type === 'string' ? (TYPE_MARK[type] ?? '') : ''}`;
}

const LEGEND = ':b bool :n num :o obj :a arr';
/** Required fields of a nested object, as `head,sourceVersion?`: the names, not its schema. */
const nestedKeys = (value: Json): string => {
  const required = Array.isArray(value.required) ? (value.required as string[]) : [];
  return Object.keys(value.properties as Json)
    .map(key => key + (required.includes(key) ? '' : '?'))
    .join(',');
};
const withNested = (schema: Json, token: string): string =>
  isObject(schema.properties) ? `${token}(${nestedKeys(schema)})` : token;

/** A flat tool lists its fields by name in one description, like a command tool; the strict Zod schema
 * still validates every call. */
function flatSchema(schema: Json): Json {
  const stripped = stripSchemaNoise(schema) as Json;
  if (!isObject(stripped.properties)) return stripped;
  const fields = Object.entries(stripped.properties).map(([key, value]) =>
    withNested(isObject(value) ? value : {}, fieldToken(key, [isObject(value) ? value : {}])),
  );
  const required = Array.isArray(stripped.required) ? (stripped.required as string[]) : [];
  return {
    type: 'object',
    description: `Fields: ${fields.join(' ')} (${LEGEND})${required.length ? `. Required: ${required.join(',')}` : ''}`,
    properties: {},
    ...(required.length ? { required } : {}),
  };
}

/** The listing carries names, not a schema: the action enum, required fields per action and one field
 * line. Types are marked only when they are not strings; exact per-action schemas are behind help. */
function compactCommand(tool: Tool): Tool {
  const variants = variantsOf(tool);
  if (!variants) return { ...tool, inputSchema: flatSchema(tool.inputSchema) };
  const properties = new Map<string, Json[]>();
  for (const variant of variants)
    for (const [key, schema] of Object.entries((variant.properties as Json | undefined) ?? {}))
      if (isObject(schema)) properties.set(key, [...(properties.get(key) ?? []), schema]);
  const actions = [...new Set(variants.map(actionOf).filter((value): value is string => Boolean(value)))];
  const signatures = groupSignatures(variants);
  const fields = [...properties]
    .filter(([key]) => key !== 'action' && key !== 'mode')
    .map(([key, seen]) => fieldToken(key, seen));
  const command = (tool.inputSchema.properties as Json).command as Json;
  const rest = Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'anyOf'));
  return {
    ...tool,
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          ...(stripSchemaNoise(rest) as Json),
          type: 'object',
          description: `${signatures.length ? `Required: ${signatures.join(' ')}. ` : ''}Fields: ${fields.join(' ')} (${LEGEND}). Schema: forge_work_overview help`,
          properties: { action: { enum: actions } },
          required: ['action'],
        },
      },
      required: tool.inputSchema.required ?? ['command'],
    },
  };
}

export type ToolHelp = {
  /** Full prose per tool name: the pre-compaction description. */
  prose: Record<string, string>;
};

/** The advertised, compact form of one tool. */
export function compactTool(tool: Tool): Tool {
  const { execution: _forbidden, annotations, ...compact } = compactCommand(tool);
  void _forbidden;
  // MCP defaults are readOnlyHint false, idempotentHint false, openWorldHint true: list only a read tool.
  const hints = annotations as Record<string, unknown> | undefined;
  if (!hints) return compact as Tool;
  const kept = Object.fromEntries(
    Object.entries(hints).filter(
      ([key, value]) =>
        (key === 'readOnlyHint' && value === true) || (key === 'openWorldHint' && value === false),
    ),
  );
  if (!Object.keys(kept).length) return compact as Tool;
  return { ...compact, annotations: kept } as Tool;
}

/** Exact schema and prose for a tool name or action name; no topic lists what exists. */
export function toolHelp(tools: Tool[], help: ToolHelp, topic?: string): unknown {
  if (!topic)
    return {
      topics: tools.map(tool => ({
        tool: tool.name,
        actions: (variantsOf(tool) ?? [])
          .map(actionOf)
          .filter((value, i, all) => value && all.indexOf(value) === i),
      })),
      guides: Object.keys(helpTopics),
      usage: 'forge_work_overview {action:"help",topic:"<tool, action or guide>"}',
    };
  const byTool = tools.find(tool => tool.name === topic);
  if (byTool)
    return {
      tool: byTool.name,
      description: help.prose[byTool.name] ?? byTool.description,
      actions: (variantsOf(byTool) ?? []).map(signature),
    };
  const matches = tools.flatMap(tool =>
    (variantsOf(tool) ?? [])
      .filter(variant => actionOf(variant) === topic)
      .map(variant => ({ tool: tool.name, schema: stripSchemaNoise(variant) })),
  );
  return matches.length
    ? {
        action: topic,
        variants: matches,
        description: matches
          .map(m => help.prose[m.tool])
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i),
        ...(isHelpTopic(topic) ? { guide: helpTopicText(topic) } : {}),
      }
    : isHelpTopic(topic)
      ? { guide: topic, text: helpTopicText(topic) }
      : {
          error: {
            code: 'BAD_ARGUMENT',
            message: `No tool, action or guide named ${topic}. Call help without a topic to list them.`,
          },
        };
}

type Handler = (request: unknown, extra: unknown) => Promise<{ tools: Tool[] }> | { tools: Tool[] };
/**
 * Replace the SDK's `tools/list` with the compact form. Returns the full (pre-compaction) listing so help
 * can serve exact schemas. The SDK keeps its handlers in a private map; this is the one place that reads it.
 * A stand-in server without a protocol layer (unit-test registries) keeps its plain registrations.
 */
export function installCompactToolList(server: McpServer): () => Promise<Tool[]> {
  const handlers = (server as unknown as { server?: { _requestHandlers?: Map<string, Handler> } }).server
    ?._requestHandlers;
  const original = handlers?.get('tools/list');
  if (!original) return async () => [];
  const full = async () => (await original({ method: 'tools/list', params: {} }, {})).tools;
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await full()).map(compactTool),
  }));
  return full;
}
