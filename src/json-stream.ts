// SPDX-License-Identifier: Apache-2.0
import { StringDecoder } from 'node:string_decoder';

type Frame = {
  value: unknown[] | Record<string, unknown>;
  state: 'key-or-end' | 'key' | 'colon' | 'value-or-end' | 'value' | 'comma-or-end';
  key?: string;
  path: (string | number)[] | undefined;
  descend: boolean;
};
/** Decode JSON without retaining the complete UTF-8 buffer, UTF-16 text and
 * parsed graph together. Tokens can span arbitrary byte/escape boundaries.
 * JSON.parse remains the authority for scalar syntax and string escapes. */
export async function parseJsonStream(
  chunks: AsyncIterable<Uint8Array>,
  transform?: {
    select: (path: (string | number)[]) => boolean;
    /** Omit descendant paths when only the complete container is consumed. */
    descend?: (path: (string | number)[]) => boolean;
    value: (value: unknown, path: (string | number)[]) => Promise<unknown>;
  },
): Promise<unknown> {
  const decoder = new StringDecoder('utf8'),
    stack: Frame[] = [];
  let result: unknown,
    complete = false,
    token = '',
    string = false,
    escaped = false;
  function invalid(): never {
    throw new SyntaxError('Invalid streamed JSON.');
  }
  function value(value: unknown) {
    const frame = stack.at(-1);
    if (!frame) {
      if (complete) invalid();
      result = value;
      complete = true;
    } else {
      if (frame.state !== 'value' && frame.state !== 'value-or-end') invalid();
      if (Array.isArray(frame.value)) frame.value.push(value);
      else {
        if (frame.key === undefined) invalid();
        Object.defineProperty(frame.value, frame.key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      frame.state = 'comma-or-end';
    }
  }
  function scalar(text: string) {
    const parsed: unknown = JSON.parse(text),
      frame = stack.at(-1);
    if (frame && (frame.state === 'key' || frame.state === 'key-or-end')) {
      if (typeof parsed !== 'string') invalid();
      frame.key = parsed;
      frame.state = 'colon';
    } else {
      const path = transform ? nextPath() : undefined;
      value(parsed);
      if (path && transform?.select(path)) return replace(path, parsed);
    }
  }
  function nextPath() {
    const parent = stack.at(-1);
    return parent
      ? parent.descend
        ? [...parent.path!, Array.isArray(parent.value) ? parent.value.length : parent.key!]
        : undefined
      : [];
  }
  async function replace(path: (string | number)[], child: unknown) {
    const mapped = await transform!.value(child, path),
      parent = stack.at(-1);
    if (!parent) result = mapped;
    else
      Object.defineProperty(parent.value, path.at(-1)!, {
        value: mapped,
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  function punctuation(char: string) {
    const frame = stack.at(-1);
    if (char === '{' || char === '[') {
      const path = transform ? nextPath() : undefined,
        child = char === '[' ? [] : {};
      value(child);
      stack.push({
        path,
        descend: !!path && (transform?.descend?.(path) ?? true),
        value: child,
        state: char === '[' ? 'value-or-end' : 'key-or-end',
      });
    } else if (char === '}' || char === ']') {
      if (
        !frame ||
        Array.isArray(frame.value) !== (char === ']') ||
        !['comma-or-end', char === ']' ? 'value-or-end' : 'key-or-end'].includes(frame.state)
      )
        invalid();
      stack.pop();
      if (frame.path && transform?.select(frame.path)) return replace(frame.path, frame.value);
    } else if (char === ':') {
      if (!frame || frame.state !== 'colon') invalid();
      frame.state = 'value';
    } else {
      if (!frame || frame.state !== 'comma-or-end') invalid();
      frame.state = Array.isArray(frame.value) ? 'value' : 'key';
    }
  }
  async function consume(text: string) {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (string) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') {
          token += text.slice(start, i + 1);
          const pending = scalar(token);
          if (pending) await pending;
          token = '';
          string = false;
          start = i + 1;
        }
        continue;
      }
      const delimiter =
        char === ' ' || char === '\n' || char === '\r' || char === '\t' || '{}[]:,'.includes(char);
      if (delimiter) {
        if (token || start < i) {
          const pending = scalar(token + text.slice(start, i));
          if (pending) await pending;
          token = '';
        }
        if ('{}[]:,'.includes(char)) {
          const pending = punctuation(char);
          if (pending) await pending;
        }
        start = i + 1;
      } else if (char === '"') {
        if (token || start < i) invalid();
        string = true;
        start = i;
      }
    }
    token += text.slice(start);
  }
  for await (const chunk of chunks)
    await consume(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  await consume(decoder.end());
  if (string) invalid();
  if (token) await scalar(token);
  if (stack.length || !complete) invalid();
  return result;
}
