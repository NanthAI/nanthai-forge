// SPDX-License-Identifier: Apache-2.0
/** Comment-, literal- and bracket-aware text scanning for the export scanner. */
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_WORDS = /(?:^|[^\w$])(?:return|typeof|case|void|delete|in|of|yield|await|throw|new)$/;

/** Index after a string, template or regex literal starting at `i`, else -1. */
export function literalEnd(text: string, i: number, previous: string): number {
  const c = text[i]!;
  if (c === "'" || c === '"') {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === c || text[j] === '\n') return j + 1;
    }
    return text.length;
  }
  if (c === '`') return templateEnd(text, i);
  if (
    c === '/' &&
    (previous === '' ||
      REGEX_BEFORE.test(previous) ||
      REGEX_WORDS.test(text.slice(Math.max(0, i - 12), i).trimEnd()))
  ) {
    let cls = false;
    for (let j = i + 1; j < text.length; j++) {
      const d = text[j]!;
      if (d === '\\') j++;
      else if (d === '\n') return -1;
      else if (d === '[') cls = true;
      else if (d === ']') cls = false;
      else if (d === '/' && !cls) {
        let k = j + 1;
        while (k < text.length && /[a-z]/.test(text[k]!)) k++;
        return k;
      }
    }
  }
  return -1;
}
function templateEnd(text: string, start: number): number {
  for (let j = start + 1; j < text.length; j++) {
    const c = text[j]!;
    if (c === '\\') j++;
    else if (c === '`') return j + 1;
    else if (c === '$' && text[j + 1] === '{') {
      let depth = 1;
      j += 2;
      for (; j < text.length && depth; j++) {
        const d = text[j]!;
        if (d === '`') j = templateEnd(text, j) - 1;
        else if (d === "'" || d === '"') j = literalEnd(text, j, '') - 1;
        else if (d === '{') depth++;
        else if (d === '}') depth--;
      }
      j--;
    }
  }
  return text.length;
}
/** Comments removed (replaced by one space or newline); literals preserved. */
export function stripComments(text: string): string {
  let out = '',
    i = 0,
    previous = '';
  while (i < text.length) {
    const c = text[i]!,
      next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).includes('\n') ? '\n' : ' ';
      i = stop;
      continue;
    }
    const end = literalEnd(text, i, previous);
    if (end > i) {
      out += text.slice(i, end);
      previous = text[end - 1]!;
      i = end;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) previous = c;
    i++;
  }
  return out;
}
export const OPEN = '({[',
  CLOSE = ')}]';
/** Top-level statements of comment-free text. A statement ends at a depth-0 `;` or at
 * a depth-0 line break before a column-0 token that cannot continue it. */
export function statements(text: string): string[] {
  const out: string[] = [];
  let depth = 0,
    start = 0,
    previous = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const end = literalEnd(text, i, previous);
    if (end > i) {
      i = end - 1;
      previous = text[i]!;
      continue;
    }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ';' && !depth) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (c === '\n' && !depth && text[i + 1] && !/[\s}).\]?:|&,+\-*/=<>]/.test(text[i + 1]!)) {
      if (!/[=,(|&?:+\-*<]\s*$/.test(text.slice(start, i))) {
        out.push(text.slice(start, i));
        start = i + 1;
      }
    }
    if (!/\s/.test(c)) previous = c;
  }
  out.push(text.slice(start));
  return out.map(item => item.trim()).filter(Boolean);
}
/** Split a bracket body at depth-0 separators. */
export function splitTop(text: string, separator = ','): string[] {
  const out: string[] = [];
  let depth = 0,
    start = 0,
    previous = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const end = literalEnd(text, i, previous);
    if (end > i) {
      i = end - 1;
      previous = text[i]!;
      continue;
    }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === separator && !depth) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
    if (!/\s/.test(c)) previous = c;
  }
  out.push(text.slice(start));
  return out.map(item => item.trim()).filter(Boolean);
}
/** Index of the bracket closing the one at `open`, or -1. */
export function matching(text: string, open: number): number {
  let depth = 0,
    previous = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    const end = literalEnd(text, i, previous);
    if (end > i) {
      i = end - 1;
      previous = text[i]!;
      continue;
    }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c) && --depth === 0) return i;
    if (!/\s/.test(c)) previous = c;
  }
  return -1;
}
/** Text up to the `{` opening a function or class body, or the whole text. */
export function header(text: string, from: number): string {
  let paren = 0,
    angle = 0,
    previous = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    const end = literalEnd(text, i, previous);
    if (end > i) {
      i = end - 1;
      previous = text[i]!;
      continue;
    }
    if (c === '(' || c === '[') paren++;
    else if (c === ')' || c === ']') paren--;
    else if (c === '<' && !paren) angle++;
    else if (c === '>' && !paren && text[i - 1] !== '=' && angle) angle--;
    else if (c === '{' && !paren) {
      const before = text.slice(from, i).trimEnd();
      // A brace in type position (annotation, union, generic, arrow return) is not the body.
      if (!(angle > 0 || /[:|&,<(=]$/.test(before) || before.endsWith('=>'))) return before;
      const close = matching(text, i);
      if (close < 0) return text.slice(from);
      i = close;
      previous = '}';
      continue;
    }
    if (!/\s/.test(c)) previous = c;
  }
  return text.slice(from);
}
