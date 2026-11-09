// SPDX-License-Identifier: Apache-2.0
import { blank, fromFile, lineEnd, quoted, type DeclarationScan } from './structural-scan-types.js';

/** PHP code only: text outside `<?php … ?>`, comments, attributes, strings and heredoc/nowdoc
 * bodies become spaces (offsets kept). Each string's original body is kept by its start offset. */
export function maskPhp(text: string) {
  const out = text.split('');
  const literals = new Map<number, string>();
  let i = 0;
  let code = false;
  while (i < text.length) {
    if (!code) {
      const open = text.indexOf('<?', i);
      const end = open < 0 ? text.length : open + (text.startsWith('<?php', open) ? 5 : 2);
      blank(out, i, end);
      i = end;
      code = open >= 0;
      continue;
    }
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '?' && next === '>') {
      code = false;
    } else if ((c === '/' && next === '/') || (c === '#' && next !== '[')) {
      // A line comment also ends at `?>`.
      let end = lineEnd(text, i);
      const close = text.indexOf('?>', i);
      if (close >= 0 && close < end) end = close;
      blank(out, i, end);
      i = end;
    } else if ((c === '/' && next === '*') || (c === '#' && next === '[')) {
      const close = c === '/' ? text.indexOf('*/', i + 2) : text.indexOf(']', i);
      const end = close < 0 ? text.length : close + (c === '/' ? 2 : 1);
      blank(out, i, end);
      i = end;
    } else if (c === '<' && /^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1/.test(text.slice(i, i + 40))) {
      const head = /^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1/.exec(text.slice(i, i + 40))!;
      const stop = new RegExp(`\\n[ \\t]*${head[2]}\\b`).exec(text.slice(i));
      const end = stop ? i + stop.index + stop[0].length : text.length;
      blank(out, i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      const end = quoted(text, i, c);
      literals.set(i, text.slice(i + 1, end - 1));
      // The opening quote stays, so the literal is one token at its own offset.
      blank(out, i + 1, end);
      i = end;
    } else i++;
  }
  return { masked: out.join(''), literals };
}

const TYPES: Record<string, string> = {
  class: 'ClassDeclaration',
  interface: 'InterfaceDeclaration',
  trait: 'TraitDeclaration',
  enum: 'EnumDeclaration',
};
/** Names keep a trailing `\` (`use A\{B, C}`'s prefix). */
const TOKEN = /\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*\\?|::|->|[{}();,]|\S/g;

/** Namespaces, classes, interfaces, traits and enums (provided as `Namespace\Name`), functions and
 * methods (private/protected ones not exported), and `use` imports at file level plus literal
 * `require`/`include` paths. Closures and anonymous classes declare nothing. */
export function scanPhp(text: string, file: string): DeclarationScan {
  const { masked, literals } = maskPhp(text);
  const out: DeclarationScan = { symbols: [], uses: [], provides: [], ok: true };
  const tokens = [...masked.matchAll(TOKEN)].map(m => ({ v: m[0], from: m.index! }));
  let namespace = '';
  let depth = 0;
  /** Brace depth of the file level (0, or 1 inside `namespace X { … }`), and of class bodies. */
  let fileDepth = 0;
  const bodies: number[] = [];
  let pendingBody = false;
  for (let i = 0; i < tokens.length; i++) {
    const { v } = tokens[i]!;
    const prev = tokens[i - 1]?.v;
    const word = v.toLowerCase();
    if (v === '{') {
      depth++;
      if (pendingBody) bodies.push(depth);
      pendingBody = false;
    } else if (v === '}') {
      if (bodies.at(-1) === depth) bodies.pop();
      if (--depth < 0) return { ...out, ok: false };
      if (depth < fileDepth) fileDepth = depth;
    } else if (word === 'namespace' && depth === fileDepth && prev !== '\\') {
      const name = tokens[i + 1]?.v ?? '';
      namespace = /^[A-Za-z_]/.test(name) ? name : '';
      if (namespace) out.provides.push(namespace);
      if (tokens[i + (namespace ? 2 : 1)]?.v === '{') fileDepth = depth + 1;
    } else if (TYPES[word] && prev !== '::' && prev !== '->' && prev?.toLowerCase() !== 'new') {
      const name = tokens[i + 1];
      if (!name || !/^[A-Za-z_]\w*$/.test(name.v)) continue;
      out.provides.push(namespace ? `${namespace}\\${name.v}` : name.v);
      out.symbols.push({
        name: name.v,
        kind: TYPES[word]!,
        exported: true,
        from: name.from,
        to: name.from + name.v.length,
      });
      pendingBody = true;
    } else if (word === 'function' && prev !== '::' && prev !== '->') {
      let k = i + 1;
      if (tokens[k]?.v === '&') k++;
      const name = tokens[k];
      if (!name || !/^[A-Za-z_]\w*$/.test(name.v) || tokens[k + 1]?.v !== '(') continue;
      const inClass = bodies.at(-1) === depth;
      if (!inClass && depth !== fileDepth) continue;
      let hidden = false;
      for (let back = i - 1; back >= 0 && /^[a-z]+$/i.test(tokens[back]!.v); back--)
        if (/^(?:private|protected)$/i.test(tokens[back]!.v)) hidden = true;
      out.symbols.push({
        name: name.v,
        kind: inClass ? 'MethodDeclaration' : 'FunctionDeclaration',
        exported: !hidden,
        from: name.from,
        to: name.from + name.v.length,
      });
    } else if (word === 'use' && depth === fileDepth && tokens[i + 1]?.v !== '(') {
      // `use A\B;`, `use A\{B, C as D};`, `use function A\f;`
      let k = i + 1;
      if (/^(?:function|const)$/i.test(tokens[k]?.v ?? '')) k++;
      let prefix = '';
      for (; k < tokens.length && tokens[k]!.v !== ';'; k++) {
        const t = tokens[k]!;
        if (t.v === '{') prefix = (tokens[k - 1]?.v ?? '').replace(/\\$/, '');
        else if (t.v === '}') prefix = '';
        else if (/^\\?[A-Za-z_]/.test(t.v) && !/^as$/i.test(t.v) && !/^as$/i.test(tokens[k - 1]?.v ?? '')) {
          if (t.v.endsWith('\\')) continue;
          const specifier = (prefix ? `${prefix}\\${t.v}` : t.v).replace(/^\\/, '');
          out.uses.push({ specifier, from: t.from, to: t.from + t.v.length });
        }
      }
      i = k;
    } else if (/^(?:require|include)(?:_once)?$/.test(word)) {
      let k = i + 1;
      if (tokens[k]?.v === '(') k++;
      if (tokens[k]?.v === '__DIR__' && tokens[k + 1]?.v === '.') k += 2;
      const path = literals.get(tokens[k]?.from ?? -1);
      if (!path || !/^[\w./-]+\.php$/.test(path)) continue;
      const relative = fromFile(file, path.replace(/^\//, ''));
      out.uses.push({
        specifier: path,
        from: tokens[k]!.from,
        to: tokens[k]!.from + path.length + 2,
        paths: relative === null ? [] : [relative],
      });
    }
  }
  if (depth !== 0) out.ok = false;
  return out;
}
