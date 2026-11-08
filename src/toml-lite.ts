// SPDX-License-Identifier: Apache-2.0
/** A small TOML reader for manifests (Cargo.toml, pyproject.toml): tables, arrays of tables, dotted
 * and quoted keys, strings (basic, literal, multi-line), arrays, inline tables, booleans and numbers.
 * Dates and numbers stay as their text. Malformed input throws; callers treat that as an unknown
 * layout, never as an empty manifest. */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export type TomlTable = { [key: string]: TomlValue };

const isTable = (value: unknown): value is TomlTable =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let at = 0;
  const fail = (message: string): never => {
    throw new Error(`TOML: ${message} at line ${text.slice(0, at).split('\n').length}`);
  };
  const skip = (newlines: boolean) => {
    for (;;) {
      const char = text[at];
      if (char === ' ' || char === '\t' || char === '\r' || (newlines && char === '\n')) at++;
      else if (char === '#') while (at < text.length && text[at] !== '\n') at++;
      else return;
    }
  };
  const basic = (multi: boolean) => {
    let out = '';
    if (multi && text[at] === '\n') at++;
    for (;;) {
      if (at >= text.length) fail('unterminated string');
      if (multi ? text.startsWith('"""', at) : text[at] === '"') {
        at += multi ? 3 : 1;
        while (multi && text[at] === '"') {
          out += '"';
          at++;
        }
        return out;
      }
      const char = text[at++]!;
      if (!multi && char === '\n') fail('newline in string');
      if (char !== '\\') {
        out += char;
        continue;
      }
      const next = text[at++]!;
      if (ESCAPES[next]) out += ESCAPES[next];
      else if (next === 'u' || next === 'U') {
        const size = next === 'u' ? 4 : 8;
        out += String.fromCodePoint(parseInt(text.slice(at, at + size), 16));
        at += size;
      } else if (multi && /\s/.test(next)) while (/\s/.test(text[at] ?? '')) at++;
      else fail('bad escape');
    }
  };
  const literal = (multi: boolean) => {
    const end = multi ? "'''" : "'";
    if (multi && text[at] === '\n') at++;
    const close = text.indexOf(end, at);
    if (close < 0 || (!multi && text.slice(at, close).includes('\n'))) fail('unterminated string');
    let value = text.slice(at, close);
    at = close + end.length;
    while (multi && text[at] === "'") {
      value += "'";
      at++;
    }
    return value;
  };
  const string = () => {
    if (text.startsWith('"""', at)) return ((at += 3), basic(true));
    if (text.startsWith("'''", at)) return ((at += 3), literal(true));
    if (text[at] === '"') return (at++, basic(false));
    if (text[at] === "'") return (at++, literal(false));
    return null;
  };
  const key = () => {
    const parts: string[] = [];
    for (;;) {
      skip(false);
      const quoted = text[at] === '"' || text[at] === "'" ? string() : null;
      if (quoted !== null) parts.push(quoted);
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(text.slice(at, at + 256));
        if (!match) fail('expected a key');
        parts.push(match![0]);
        at += match![0].length;
      }
      skip(false);
      if (text[at] !== '.') return parts;
      at++;
    }
  };
  const descend = (table: TomlTable, parts: string[]) => {
    let current = table;
    for (const part of parts) {
      let next = current[part];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (next === undefined) next = current[part] = {};
      if (!isTable(next)) fail(`key ${part} is not a table`);
      current = next as TomlTable;
    }
    return current;
  };
  const assign = (table: TomlTable, parts: string[], value: TomlValue) => {
    const target = descend(table, parts.slice(0, -1));
    const last = parts[parts.length - 1]!;
    if (last in target) fail(`duplicate key ${last}`);
    target[last] = value;
  };
  const value = (): TomlValue => {
    skip(false);
    const quoted = string();
    if (quoted !== null) return quoted;
    if (text[at] === '[') {
      at++;
      const items: TomlValue[] = [];
      for (;;) {
        skip(true);
        if (text[at] === ']') return (at++, items);
        items.push(value());
        skip(true);
        if (text[at] === ',') at++;
        else if (text[at] !== ']') fail('expected , or ]');
      }
    }
    if (text[at] === '{') {
      at++;
      const table: TomlTable = {};
      skip(false);
      if (text[at] === '}') return (at++, table);
      for (;;) {
        const parts = key();
        if (text[at++] !== '=') fail('expected =');
        assign(table, parts, value());
        skip(false);
        if (text[at] === '}') return (at++, table);
        if (text[at++] !== ',') fail('expected , or }');
      }
    }
    const match = /^[^\s,\]}#]+/.exec(text.slice(at, at + 128));
    if (!match) fail('expected a value');
    at += match![0].length;
    const word = match![0];
    if (word === 'true' || word === 'false') return word === 'true';
    // Dates (1979-05-27, 07:32:00) may hold one space; numbers stay numbers when they parse.
    const number = Number(word.replaceAll('_', ''));
    return Number.isFinite(number) && /^[+-]?[\d_.eE+-]+$/.test(word) ? number : word;
  };
  let current = root;
  for (;;) {
    skip(true);
    if (at >= text.length) return root;
    if (text[at] === '[') {
      const array = text[at + 1] === '[';
      at += array ? 2 : 1;
      const parts = key();
      if (!text.startsWith(array ? ']]' : ']', at)) fail('expected ]');
      at += array ? 2 : 1;
      if (array) {
        const parent = descend(root, parts.slice(0, -1));
        const last = parts[parts.length - 1]!;
        const list = (parent[last] ??= []) as TomlValue[];
        if (!Array.isArray(list)) fail(`key ${last} is not an array of tables`);
        const table: TomlTable = {};
        list.push(table);
        current = table;
      } else current = descend(root, parts);
    } else {
      const parts = key();
      if (text[at++] !== '=') fail('expected =');
      assign(current, parts, value());
    }
    skip(false);
    if (at < text.length && text[at] !== '\n') fail('expected end of line');
  }
}

/** `table.a.b` when every step is a table, else undefined. */
export function tomlGet(table: TomlTable, ...path: string[]): TomlValue | undefined {
  let current: TomlValue | undefined = table;
  for (const part of path) current = isTable(current) ? current[part] : undefined;
  return current;
}
export const tomlTable = (value: TomlValue | undefined): TomlTable => (isTable(value) ? value : {});
export const tomlStrings = (value: TomlValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
