// SPDX-License-Identifier: Apache-2.0
import { blank, fromFile, lineEnd, quoted, type DeclarationScan } from './structural-scan-types.js';

/** Ruby without comments, `=begin` blocks, string literals and heredoc bodies (offsets kept).
 * Returns the masked text and each literal's original body by its start offset. */
export function maskRuby(text: string) {
  const out = text.split('');
  const literals = new Map<number, string>();
  const heredocs: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const lineStart = i === 0 || text[i - 1] === '\n';
    if (c === '\n' && heredocs.length) {
      // Heredoc bodies start on the next line and end at their terminator line.
      let k = i + 1;
      while (heredocs.length && k < text.length) {
        const end = lineEnd(text, k);
        if (text.slice(k, end).trim() === heredocs[0]) heredocs.shift();
        blank(out, k, end);
        k = end + 1;
      }
      i = k;
    } else if (lineStart && text.startsWith('=begin', i)) {
      const close = text.indexOf('\n=end', i);
      const end = close < 0 ? text.length : lineEnd(text, close + 1);
      blank(out, i, end);
      i = end;
    } else if (c === '#') {
      const end = lineEnd(text, i);
      blank(out, i, end);
      i = end;
    } else if (c === '<' && /^<<[~-]?(['"]?)[A-Z_]\w*\1/.test(text.slice(i, i + 40))) {
      const head = /^<<[~-]?(['"]?)([A-Z_]\w*)\1/.exec(text.slice(i, i + 40))!;
      heredocs.push(head[2]!);
      i += head[0].length;
    } else if (c === '"' || c === "'" || c === '`') {
      const end = quoted(text, i, c);
      literals.set(i, text.slice(i + 1, end - 1));
      // The opening quote stays, so the literal is one token at its own offset.
      blank(out, i + 1, end);
      i = end;
    } else if (c === '?' && /[\w)\]]/.test(text[i - 1] ?? ' ') === false && /\S/.test(text[i + 1] ?? '')) {
      // A character literal (`?a`, `?#`).
      blank(out, i, i + 2);
      i += 2;
    } else i++;
  }
  return { masked: out.join(''), literals };
}

/** Keywords that open a block closed by `end`; `if`/`unless`/`while`/`until` only at statement start. */
const OPENERS = /(?<![.\w:])(?:class|module|def|case|begin|for)\b(?![?!:])/g;
const CONDITIONAL = /(?:^|[=(;[,]|\|\||&&)\s*(?:if|unless|while|until)\b(?![?!:])/g;
/** `while x do`, `for x in y do`: the optional `do` opens nothing of its own. */
const LOOP_DO = /^\s*(?:while|until|for)\b.*\bdo\s*$/;
const DO = /(?<![.\w:])do\b(?![?!:])/g;
const END = /(?<![.\w:])end\b(?![?!:])/g;
const count = (pattern: RegExp, line: string) => [...line.matchAll(pattern)].length;

/** Classes, modules and methods (private after a bare `private`, or `private def`), and
 * `require`/`require_relative` uses. Methods are named plainly; classes by their last segment,
 * provided by their full nesting (`App::Accounts::User`). */
export function scanRuby(text: string, file: string): DeclarationScan {
  const { masked, literals } = maskRuby(text);
  const out: DeclarationScan = { symbols: [], uses: [], provides: [], ok: true };
  type Block = { owner?: string; private?: boolean };
  const stack: Block[] = [];
  let offset = 0;
  for (const line of masked.split('\n')) {
    const at = (index: number) => offset + index;
    const owner = [...stack].reverse().find(block => block.owner !== undefined);
    const bare = /^\s*(private|protected|public)\s*$/.exec(line)?.[1];
    if (bare && owner) owner.private = bare !== 'public';
    const type = /^\s*(class|module)\s+([A-Z][\w]*(?:::[A-Z]\w*)*)/.exec(line);
    const method =
      /^\s*(?:(private|protected|public)\s+)?def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?|\[\]=?|[-+*/%<>=!~^&|]+)/.exec(
        line,
      );
    const endless = /^\s*(?:\w+\s+)?def\s+[^\s(]+(?:\([^)]*\))?\s*=(?!=)/.test(line);
    if (type) {
      const name = type[2]!;
      const qualified = [...stack.flatMap(block => (block.owner ? [block.owner] : [])), name].join('::');
      out.provides.push(qualified);
      const short = name.slice(name.lastIndexOf(':') + 1);
      const from = at(line.indexOf(name) + name.length - short.length);
      out.symbols.push({
        name: short,
        kind: type[1] === 'class' ? 'ClassDefinition' : 'ModuleDefinition',
        exported: true,
        from,
        to: from + short.length,
      });
    } else if (method) {
      const name = method[2]!;
      const from = at(line.indexOf(name, line.indexOf('def') + 3));
      const hidden = method[1] ? method[1] !== 'public' : !!owner?.private;
      out.symbols.push({ name, kind: 'MethodDefinition', exported: !hidden, from, to: from + name.length });
    }
    for (const use of line.matchAll(/(?<![.\w])(require_relative|require)\b[\s(]*(?=\S)/g)) {
      const start = at(use.index! + use[0].length);
      const path = literals.get(start);
      if (path === undefined || !path || /#\{/.test(path)) continue;
      const rb = path.endsWith('.rb') ? path : `${path}.rb`;
      const relative = use[1] === 'require_relative' ? fromFile(file, rb) : null;
      out.uses.push({
        specifier: path,
        from: start,
        to: start + path.length + 2,
        paths: use[1] === 'require_relative' ? (relative === null ? [] : [relative]) : [`lib/${rb}`, rb],
        ...(use[1] === 'require' ? { suffix: `lib/${rb}` } : {}),
      });
    }
    // Block depth: one-line `def x; end`, endless `def x = 1` and modifiers keep it.
    const opens =
      count(OPENERS, line) -
      (endless ? 1 : 0) +
      count(CONDITIONAL, line) +
      count(DO, line) -
      (LOOP_DO.test(line) ? 1 : 0);
    for (let k = 0; k < opens; k++) stack.push(k === 0 && type ? { owner: type[2]! } : {});
    for (let k = count(END, line); k > 0; k--)
      if (!stack.pop()) {
        out.ok = false;
        break;
      }
    if (!out.ok) break;
    offset += line.length + 1;
  }
  if (stack.length) out.ok = false;
  return out;
}
