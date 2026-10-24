// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import {
  CLOSE,
  OPEN,
  header,
  literalEnd,
  matching,
  splitTop,
  statements,
  stripComments,
} from './contract-lex.js';

/** Declaration-level export scanner. Syntactic and approximate by design: it never
 * runs repository code, needs no type checker, and a missed export is only a missed
 * notice, never a wrong acceptance. */
export type ExportEntry = { decl: string; sig: string };
export type ExportMap = Map<string, ExportEntry>;
export const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const squash = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}()[\],;:<>=|&?])\s*/g, '$1')
    .trim();
const short = (text: string) => createHash('sha1').update(squash(text)).digest('hex').slice(0, 12);
const entry = (decl: string, sig: string): ExportEntry => ({ decl, sig: short(sig) });

function classSignature(body: string): string {
  const open = body.indexOf('{');
  if (open < 0) return body;
  const close = matching(body, open),
    inner = body.slice(open + 1, close < 0 ? undefined : close);
  const members: string[] = [];
  let depth = 0,
    start = 0,
    previous = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    const end = literalEnd(inner, i, previous);
    if (end > i) {
      i = end - 1;
      previous = inner[i]!;
      continue;
    }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      depth--;
      if (!depth && c === '}') {
        members.push(inner.slice(start, i + 1));
        start = i + 1;
      }
    } else if (c === ';' && !depth) {
      members.push(inner.slice(start, i + 1));
      start = i + 1;
    }
    if (!/\s/.test(c)) previous = c;
  }
  const heads = members
    .map(member => member.trim())
    .filter(member => member && !/^(?:private\b|#|static\s+#|protected\b)/.test(member))
    .map(member => {
      const stop = member.search(/[{=;]/);
      return squash(stop < 0 ? member : member.slice(0, stop));
    });
  return `${squash(body.slice(0, open))}|${heads.join('|')}`;
}
const SCHEMA_VALUE = /^(?:z|v)\.|^define(?:Schema|Table)\(|^(?:\w+\.)?(?:object|array|union)\(/;
const FUNCTION_WRAPPER = /^\w*(?:query|mutation|action)\w*\(/i;

function declarator(rest: string): [string, ExportEntry][] {
  const keyword = /^(?:const|let|var)\s+/.exec(rest);
  if (!keyword) return [];
  const parts: string[] = [];
  for (const part of splitTop(rest.slice(keyword[0].length).replace(/;$/, '')))
    if (parts.length && !/^[\w$]+\s*(?:=|:|$)/.test(part)) parts[parts.length - 1] += `,${part}`;
    else parts.push(part);
  return parts.flatMap(part => declared(part));
}
function declared(part: string): [string, ExportEntry][] {
  const match = /^([\w$]+)\s*/.exec(part);
  if (!match) return [];
  const name = match[1]!;
  let tail = part.slice(match[0].length);
  if (tail.startsWith(':')) {
    // Annotation up to the `=` that starts the initializer.
    let angle = 0,
      paren = 0,
      i = 1;
    for (; i < tail.length; i++) {
      const c = tail[i]!;
      if (c === '<') angle++;
      else if (c === '>' && tail[i - 1] !== '=') angle = Math.max(0, angle - 1);
      else if (c === '(' || c === '{' || c === '[') paren++;
      else if (c === ')' || c === '}' || c === ']') paren--;
      else if (c === '=' && tail[i + 1] !== '>' && !angle && !paren) break;
    }
    return [[name, entry('const', tail.slice(0, i))]];
  }
  if (!tail.startsWith('=')) return [[name, entry('const', tail)]];
  tail = tail.slice(1).trim().replace(/;$/, '');
  if (/^(?:async\s+)?(?:\(|[\w$]+\s*=>)/.test(tail) || /^(?:async\s+)?function\b/.test(tail)) {
    const arrow = /^(?:async\s+)?function\b/.test(tail) ? header(tail, 0) : arrowHeader(tail);
    return [[name, entry('function', arrow)]];
  }
  if (FUNCTION_WRAPPER.test(tail)) {
    // Convex-style endpoint: its public contract is args/returns, not the handler.
    const open = tail.indexOf('{'),
      close = open < 0 ? -1 : matching(tail, open);
    const props =
      open < 0 ? [] : splitTop(tail.slice(open + 1, close < 0 ? undefined : close)).filter(Boolean);
    const picked = props.filter(item => /^(?:args|returns)\s*:/.test(item));
    return [[name, entry('function', `${tail.slice(0, tail.indexOf('(') + 1)}${picked.join(',')}`)]];
  }
  if (/^defineSchema\(/.test(tail)) return tables(tail);
  return [[name, entry(SCHEMA_VALUE.test(tail) ? 'schema' : 'const', tail)]];
}
function arrowHeader(text: string): string {
  let depth = 0,
    previous = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const end = literalEnd(text, i, previous);
    if (end > i) {
      i = end - 1;
      previous = text[i]!;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '=' && text[i + 1] === '>' && !depth) return text.slice(0, i + 2);
    if (!/\s/.test(c)) previous = c;
  }
  return text;
}
function tables(text: string): [string, ExportEntry][] {
  const open = text.indexOf('{'),
    close = open < 0 ? -1 : matching(text, open);
  if (open < 0) return [['default', entry('schema', text)]];
  return splitTop(text.slice(open + 1, close < 0 ? undefined : close)).flatMap(item => {
    const match = /^([\w$]+)\s*:/.exec(item);
    return match ? [[`table:${match[1]}`, entry('schema', item)] as [string, ExportEntry]] : [];
  });
}
function specifiers(list: string, from: string | undefined): [string, ExportEntry][] {
  return splitTop(list).flatMap(item => {
    const match = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(item.trim());
    return match
      ? [
          [match[2] ?? match[1]!, entry('reexport', `${match[1]}${from ? `@${from}` : ''}`)] as [
            string,
            ExportEntry,
          ],
        ]
      : [];
  });
}
function exported(statement: string): [string, ExportEntry][] {
  let rest = statement.slice('export'.length).trim();
  if (rest.startsWith('default')) {
    rest = rest.slice('default'.length).trim();
    const named = /^(?:async\s+)?(?:function\*?|class)\b/.test(rest) ? exported(`export ${rest}`) : [];
    if (named.length) return named.map(([, value]) => ['default', value]);
    if (/^defineSchema\(/.test(rest)) return tables(rest);
    return [['default', entry(SCHEMA_VALUE.test(rest) ? 'schema' : 'const', rest)]];
  }
  rest = rest.replace(/^declare\s+/, '').replace(/^abstract\s+/, '');
  let match: RegExpExecArray | null;
  if ((match = /^(?:type\s+)?\{([^]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?\s*;?$/.exec(rest)))
    return specifiers(match[1]!, match[2]);
  if ((match = /^(?:type\s+)?\*\s*(?:as\s+([\w$]+)\s*)?from\s*['"]([^'"]+)['"]/.exec(rest)))
    return [[match[1] ?? `*:${match[2]}`, entry('reexport', `*@${match[2]}`)]];
  if ((match = /^type\s+([\w$]+)/.exec(rest))) return [[match[1]!, entry('type', rest)]];
  if ((match = /^interface\s+([\w$]+)/.exec(rest))) return [[match[1]!, entry('interface', rest)]];
  if ((match = /^(?:const\s+)?enum\s+([\w$]+)/.exec(rest))) return [[match[1]!, entry('enum', rest)]];
  if ((match = /^(?:async\s+)?function\*?\s*([\w$]+)/.exec(rest)))
    return [[match[1]!, entry('function', header(rest, 0))]];
  if ((match = /^class\s+([\w$]+)/.exec(rest))) return [[match[1]!, entry('class', classSignature(rest))]];
  if ((match = /^(?:namespace|module)\s+([\w$.]+)/.exec(rest)))
    return [[match[1]!, entry('namespace', rest)]];
  return declarator(rest);
}
const cache = new Map<string, ExportMap>();
/** Exports of one TS/JS source file; memoized by content digest. */
export function scanExports(text: string, key?: string): ExportMap {
  const known = key ? cache.get(key) : undefined;
  if (known) return known;
  const map: ExportMap = new Map();
  for (const statement of statements(stripComments(text)))
    if (/^export\b/.test(statement) && !/^export\s*=/.test(statement))
      for (const [name, value] of exported(statement)) map.set(name, value);
  if (key) {
    if (cache.size > 4000) cache.clear();
    cache.set(key, map);
  }
  return map;
}
export type ContractChange = { file: string; export: string; kind: 'added' | 'removed' | 'changed' };
export function diffExports(file: string, before: ExportMap | undefined, after: ExportMap | undefined) {
  const out: ContractChange[] = [];
  for (const [name, value] of before ?? [])
    if (!after?.has(name)) out.push({ file, export: name, kind: 'removed' });
    else if (after.get(name)!.sig !== value.sig || after.get(name)!.decl !== value.decl)
      out.push({ file, export: name, kind: 'changed' });
  for (const name of after?.keys() ?? [])
    if (!before?.has(name)) out.push({ file, export: name, kind: 'added' });
  return out.sort((a, b) => (a.export < b.export ? -1 : a.export > b.export ? 1 : 0));
}
export type ImportRef = { spec: string; names: string[] | '*' };
/** Static import/re-export/dynamic-import specifiers of comment-free source. */
export function scanImports(text: string): ImportRef[] {
  const out: ImportRef[] = [],
    clean = stripComments(text);
  const clause = (body: string): string[] | '*' => {
    const names: string[] = [];
    for (const part of splitTop(body.replace(/^type\s+/, ''))) {
      if (part.startsWith('*')) return '*';
      const brace = /^\{([^]*)\}$/.exec(part);
      if (brace)
        for (const item of splitTop(brace[1]!)) {
          const name = /^(?:type\s+)?([\w$]+)/.exec(item.trim())?.[1];
          if (name) names.push(name);
        }
      else if (part) names.push('default');
    }
    return names;
  };
  for (const match of clean.matchAll(
    /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g,
  ))
    out.push({ spec: match[2]!, names: match[1]!.trim().startsWith('*') ? '*' : clause(match[1]!.trim()) });
  for (const match of clean.matchAll(/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g))
    out.push({ spec: match[1]!, names: '*' });
  for (const match of clean.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
    out.push({ spec: match[1]!, names: '*' });
  return out;
}
