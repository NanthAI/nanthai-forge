// SPDX-License-Identifier: Apache-2.0
// Research only: ordered, compact native JSON manifests, not a replacement State reader.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stateSchema } from '../dist/state/format.js';

/** Consume each input once, verify its exact pin, retain at most a chunk and one entry.
 * Deliberately accepts only compact native writer order; unsupported encodings fail explicitly.
 * A production reader must also support legacy field orders, whitespace and optional metadata. */
export async function* manifestFiles(stream, pin, metadata) {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    size = 0,
    header = false,
    ended = false,
    previous = null;
  for await (const chunk of stream) {
    hash.update(chunk);
    size += chunk.length;
    assert(size <= pin.size, 'manifest exceeds pin');
    buffer += decoder.decode(chunk, { stream: true });
    if (!header) {
      const start = buffer.indexOf(',"files":[');
      if (start < 0) continue;
      Object.assign(metadata, JSON.parse(buffer.slice(0, start) + '}'));
      assert.equal(metadata.schema, 1);
      assert.equal(metadata.kind, 'forge-source-state');
      assert.deepEqual(Object.keys(metadata), ['schema', 'kind', 'parents']);
      buffer = buffer.slice(start + ',"files":['.length);
      header = true;
    }
    while (!ended && buffer.length) {
      if (buffer[0] === ',') buffer = buffer.slice(1);
      if (!buffer.length) break;
      if (buffer[0] === ']') {
        ended = true;
        break;
      }
      assert.equal(buffer[0], '{');
      let quoted = false,
        escaped = false,
        end = -1;
      for (let i = 1; i < buffer.length; i++) {
        const c = buffer[i];
        if (escaped) escaped = false;
        else if (quoted && c === '\\') escaped = true;
        else if (c === '"') quoted = !quoted;
        else if (!quoted && c === '}') {
          end = i + 1;
          break;
        }
      }
      if (end < 0) break;
      const file = stateSchema.shape.files.element.parse(JSON.parse(buffer.slice(0, end)));
      assert(previous === null || previous < file.path, 'manifest paths must be ordered uniquely');
      assert(!/(?:^|\/)\.(?:forge|git)(?:\/|$)/i.test(file.path), 'reserved source path');
      // Lexicographic neighbors alone cannot prove no file/directory collision (a, a-, a/b).
      // Fixtures are trusted valid States; general collision validation is outside this spike.
      previous = file.path;
      buffer = buffer.slice(end);
      yield file;
    }
  }
  buffer += decoder.decode();
  assert(header && ended, 'truncated manifest');
  assert.equal(size, pin.size, 'manifest size differs');
  assert.equal(hash.digest('hex'), pin.sha256, 'manifest hash differs');
  const suffix = JSON.parse('{' + buffer.slice(2)); // ],"message":... -> {"message":...
  assert.deepEqual(Object.keys(suffix), ['message', 'at']);
  Object.assign(metadata, suffix);
}

/** Three ordered iterators: no path Map, tree clone, sorted union or full JSON string. */
export async function* mergeWalk(iterators, merge) {
  const heads = await Promise.all(iterators.map(iterator => iterator.next()));
  while (heads.some(head => !head.done)) {
    const path = heads
      .filter(head => !head.done)
      .map(head => head.value.path)
      .sort()[0];
    const entries = heads.map(head => (!head.done && head.value.path === path ? head.value : undefined));
    const file = merge(...entries);
    assert.notEqual(file, null, 'research prototype needs a metadata-only merge');
    if (file) yield { path: file.path, blob: file.blob, mode: file.mode };
    await Promise.all(
      heads.map(async (head, i) => {
        if (!head.done && head.value.path === path) heads[i] = await iterators[i].next();
      }),
    );
  }
}
