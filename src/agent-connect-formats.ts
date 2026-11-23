// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { isDeepStrictEqual } from 'node:util';
import { parse as toml, stringify } from 'smol-toml';
import ts from 'typescript';
import { invariant } from './errors.js';

type RecordValue = Record<string, unknown>;
export type ConnectServer = { command: string; args: string[]; type?: 'stdio' };
const object = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const jsonProperties = (node: ts.ObjectLiteralExpression, key: string) =>
  node.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && property.name.text === key,
  );

function jsonObject(path: string, text: string) {
  const parsed = ts.parseConfigFileTextToJson(path, text);
  invariant(!parsed.error && object(parsed.config), 'BAD_ARGUMENT', 'Agent config must be a JSON object.');
  return parsed.config as RecordValue;
}

function jsonModel(path: string, text: string, server: ConnectServer, openCode: boolean) {
  const config = jsonObject(path, text);
  const mcp = config.mcp;
  // OpenCode V2 nests entries under servers. Keep the V1 layout when an existing file uses it.
  const legacy =
    openCode &&
    object(mcp) &&
    !Object.hasOwn(mcp, 'servers') &&
    Object.values(mcp).some(
      value =>
        object(value) &&
        (value.type === 'local' || value.type === 'remote' || typeof value.enabled === 'boolean'),
    );
  const keys = openCode ? (legacy ? ['mcp'] : ['mcp', 'servers']) : ['mcpServers'];
  const entry = openCode
    ? { type: 'local', command: [server.command, ...server.args], ...(legacy ? { enabled: true } : {}) }
    : server;
  const parsed = ts.parseJsonText(path, text);
  const first = parsed.statements[0];
  invariant(
    first && ts.isExpressionStatement(first) && ts.isObjectLiteralExpression(first.expression),
    'BAD_ARGUMENT',
    'Agent config must contain a JSON object.',
  );
  let literal = first.expression,
    target = config;
  const remaining = [...keys];
  while (remaining.length && Object.hasOwn(target, remaining[0]!)) {
    const key = remaining.shift()!,
      child = target[key];
    const properties = jsonProperties(literal, key);
    const property = properties[0];
    invariant(
      properties.length === 1 &&
        property &&
        ts.isObjectLiteralExpression(property.initializer) &&
        object(child),
      'BAD_ARGUMENT',
      'The MCP server group must be a single JSON object.',
    );
    literal = property.initializer;
    target = child;
  }
  return { config, parsed, entry, literal, target, keys: [...remaining, 'forge'] };
}

/** Insert at an object boundary without reprinting its comments or unrelated settings. */
export function addJsonServer(path: string, before: string | null, server: ConnectServer, openCode: boolean) {
  const text = before ?? '{}\n';
  const { config, entry, literal, target, keys: remaining } = jsonModel(path, text, server, openCode);
  if (remaining.length === 1 && Object.hasOwn(target, 'forge')) {
    invariant(
      isDeepStrictEqual(target.forge, entry),
      'BAD_ARGUMENT',
      'A different forge server is already configured. Inspect it before editing the forge entry.',
    );
    return text;
  }
  const key = remaining.shift()!;
  const value = remaining.reduceRight<unknown>((child, part) => ({ [part]: child }), entry);
  const last = literal.properties.at(-1);
  const comma = last && !literal.properties.hasTrailingComma ? ',' : '';
  const end = literal.end - 1;
  const insertion = comma ? last!.end : end;
  const next =
    text.slice(0, insertion) +
    comma +
    text.slice(insertion, end) +
    '\n' +
    JSON.stringify(key) +
    ': ' +
    JSON.stringify(value, null, 2) +
    '\n' +
    text.slice(end);
  target[key] = value;
  invariant(
    isDeepStrictEqual(jsonObject(path, next), config),
    'BAD_ARGUMENT',
    'Forge could not insert the entry without changing other settings.',
  );
  return next;
}

export function removeJsonServer(path: string, text: string, server: ConnectServer, openCode: boolean) {
  const { config, parsed, entry, literal, target, keys } = jsonModel(path, text, server, openCode);
  if (keys.length !== 1 || !Object.hasOwn(target, 'forge')) return text;
  const properties = jsonProperties(literal, 'forge');
  const property = properties[0];
  invariant(
    properties.length === 1 && property && isDeepStrictEqual(target.forge, entry),
    'BAD_ARGUMENT',
    'The forge entry was edited after setup. Inspect the config before removing it.',
  );
  const index = literal.properties.indexOf(property);
  const start = property.getStart(parsed),
    end = property.end;
  const previous = literal.properties[index - 1];
  const forwards = index < literal.properties.length - 1 || literal.properties.hasTrailingComma;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  scanner.setTextPos(forwards ? end : (previous?.end ?? end));
  const comma =
    (forwards || previous) && scanner.scan() === ts.SyntaxKind.CommaToken ? scanner.getTokenPos() : -1;
  const next =
    comma < 0
      ? text.slice(0, start) + text.slice(end)
      : comma < start
        ? text.slice(0, comma) + text.slice(comma + 1, start) + text.slice(end)
        : text.slice(0, start) + text.slice(end, comma) + text.slice(comma + 1);
  delete target.forge;
  invariant(
    isDeepStrictEqual(jsonObject(path, next), config),
    'BAD_ARGUMENT',
    'Forge could not remove its entry safely.',
  );
  return next;
}

function tomlObject(text: string) {
  try {
    return toml(text);
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Forge could not read the Codex TOML config.');
  }
}

const codexEntry = ({ command, args }: ConnectServer) =>
  '[mcp_servers.forge]\n' + stringify({ command, args });
const inlineCodexEntry = ({ command, args }: ConnectServer) =>
  'forge = { ' + stringify({ command, args }).trimEnd().replaceAll('\n', ', ') + ' }';

function sameToml(text: string, expected: unknown) {
  try {
    return isDeepStrictEqual(toml(text), expected);
  } catch {
    return false;
  }
}

export function addCodexServer(before: string | null, entry: ConnectServer) {
  const text = before ?? '';
  const config = tomlObject(text);
  const servers = config.mcp_servers;
  const table = tomlObject(stringify({ command: entry.command, args: entry.args }));
  invariant(servers === undefined || object(servers), 'BAD_ARGUMENT', 'Codex MCP servers must be a table.');
  if (servers && Object.hasOwn(servers, 'forge')) {
    invariant(
      isDeepStrictEqual(servers.forge, table),
      'BAD_ARGUMENT',
      'A different forge server is already configured. Inspect it before editing the forge entry.',
    );
    return text;
  }
  const next = (text ? text + (text.endsWith('\n') ? '\n' : '\n\n') : '') + codexEntry(entry);
  config.mcp_servers = Object.assign(Object.create(null), servers, { forge: table });
  if (sameToml(next, config)) return next;
  // An inline table is sealed, so insert within its braces. Compare the parsed
  // result to disambiguate identical-looking assignments in multiline strings.
  for (const match of text.matchAll(/^[ \t]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[ \t]*=[ \t]*\{/gm)) {
    const at = match.index + match[0].length;
    const separator = servers && Object.keys(servers).length ? ',' : ' ';
    const edited = text.slice(0, at) + ' ' + inlineCodexEntry(entry) + separator + text.slice(at);
    if (sameToml(edited, config)) return edited;
  }
  invariant(false, 'BAD_ARGUMENT', 'Forge could not insert the entry without changing other settings.');
}

export function removeCodexServer(text: string, entry: ConnectServer) {
  const config = tomlObject(text),
    servers = config.mcp_servers;
  invariant(servers === undefined || object(servers), 'BAD_ARGUMENT', 'Codex MCP servers must be a table.');
  if (!servers || !Object.hasOwn(servers, 'forge')) return text;
  const table = tomlObject(stringify({ command: entry.command, args: entry.args }));
  invariant(
    isDeepStrictEqual(servers.forge, table),
    'BAD_ARGUMENT',
    'The forge entry was edited after setup. Inspect the config before removing it.',
  );
  delete servers.forge;
  const block = codexEntry(entry);
  for (let start = text.indexOf(block); start !== -1; start = text.indexOf(block, start + block.length)) {
    const next = text.slice(0, start) + text.slice(start + block.length);
    if (sameToml(next, config)) return next;
    if (!Object.keys(servers).length) {
      // Removing an implicit table may remove its empty parent as well.
      const withoutTable = Object.assign(Object.create(null), config);
      delete withoutTable.mcp_servers;
      if (sameToml(next, withoutTable)) return next;
    }
  }
  const inline = inlineCodexEntry(entry);
  for (let start = text.indexOf(inline); start !== -1; start = text.indexOf(inline, start + inline.length)) {
    const left = text.slice(0, start),
      right = text.slice(start + inline.length);
    const next = /^[ \t]*,/.test(right)
      ? left + right.replace(/^([ \t]*),/, '$1')
      : left.replace(/,([ \t]*)$/, '$1') + right;
    if (sameToml(next, config)) return next;
  }
  invariant(false, 'BAD_ARGUMENT', 'Forge could not remove its entry safely.');
}
