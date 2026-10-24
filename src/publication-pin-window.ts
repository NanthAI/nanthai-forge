// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';

/** Locate the last top-level pins array in already parsed/validated JSON.
 * Keep offsets in the original Unicode pages, including arbitrary whitespace
 * and escaped property names. Duplicate JSON keys use JSON.parse's last value. */
export function publicationPinWindow(pages: string[]) {
  const text = pages.join('');
  let depth = 0,
    start = -1,
    end = -1,
    selected = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const begin = i;
      while (++i < text.length) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      if (depth === 1) {
        let next = i + 1;
        while (/\s/.test(text[next] ?? '')) next++;
        if (text[next] === ':' && JSON.parse(text.slice(begin, i + 1)) === 'pins') {
          while (/\s/.test(text[++next] ?? '')) {
            /* JSON whitespace */
          }
          invariant(text[next] === '[', 'INVALID_WORK_BACKUP', 'Publication pins are not an array.');
          start = next + 1;
          selected = true;
        }
      }
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (selected && c === ']' && depth === 2) {
        end = i;
        selected = false;
      }
      depth--;
    }
  }
  invariant(start >= 0 && end >= start, 'INVALID_WORK_BACKUP', 'Publication pins are missing.');
  const locate = (offset: number) => {
    for (let position = 0; position < pages.length; position++) {
      if (offset < pages[position]!.length || position === pages.length - 1) return { position, offset };
      offset -= pages[position]!.length;
    }
    throw new Error('Publication offset is outside its pages.');
  };
  const first = locate(start),
    last = locate(end);
  return { ...first, endPosition: last.position, endOffset: last.offset };
}

/** The complete schema has established that these objects contain only hash
 * strings and numeric sizes, so a literal closing brace terminates one pin. */
export function publicationPagePins(tail: string, body: string) {
  let text = tail + body;
  const pins: { sha256: string; size: number }[] = [];
  while (true) {
    text = text.replace(/^[\s,]+/, '');
    const end = text.indexOf('}');
    if (end < 0) return { pins, tail: text.replace(/\s/g, '') };
    pins.push(JSON.parse(text.slice(0, end + 1)));
    text = text.slice(end + 1);
  }
}
