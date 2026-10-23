// SPDX-License-Identifier: Apache-2.0
/** JSON data only (parsed source metadata): preserve JSON.stringify's property
 * order and pretty whitespace without constructing a whole-history string. */
export function* jsonChunks(value: unknown, space = 0): Generator<string> {
  const unit = ' '.repeat(space);
  function* encode(value: unknown, depth: number): Generator<string> {
    if (value === null || typeof value !== 'object') {
      yield JSON.stringify(value) ?? 'null';
      return;
    }
    const array = Array.isArray(value);
    const keys = array
      ? undefined
      : Object.keys(value).filter(key => {
          const field = (value as Record<string, unknown>)[key];
          return field !== undefined && typeof field !== 'function' && typeof field !== 'symbol';
        });
    const length = array ? value.length : keys!.length;
    yield array ? '[' : '{';
    for (let i = 0; i < length; i++) {
      yield `${i ? ',' : ''}${space ? `\n${unit.repeat(depth + 1)}` : ''}`;
      const key = keys?.[i];
      if (key !== undefined) yield `${JSON.stringify(key)}:${space ? ' ' : ''}`;
      yield* encode(array ? value[i] : (value as Record<string, unknown>)[key!], depth + 1);
    }
    if (length && space) yield `\n${unit.repeat(depth)}`;
    yield array ? ']' : '}';
  }
  let chunk = '';
  for (const token of encode(value, 0)) {
    // Slice large scalar strings too. Avoid splitting UTF-16 surrogate pairs.
    for (let offset = 0; offset < token.length;) {
      let end = Math.min(offset + 32768 - chunk.length, token.length);
      if (end < token.length && /[\uD800-\uDBFF]/.test(token[end - 1]!)) end--;
      chunk += token.slice(offset, end);
      offset = end;
      if (chunk.length >= 32767) {
        yield chunk;
        chunk = '';
      }
    }
  }
  if (chunk) yield chunk;
}
