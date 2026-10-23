// SPDX-License-Identifier: Apache-2.0
import { highlightSource, plainLines, type SourceToken } from './source-highlight';
const cache = new Map<string, SourceToken[][]>();
self.onmessage = async (
  event: MessageEvent<{ id: number; file: string; text: string; blob?: string; range?: string }>,
) => {
  const { id, file, text, blob, range } = event.data;
  try {
    // Blob identity plus visible range; older endpoints without blob hashes use a content digest.
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
      n => n.toString(16).padStart(2, '0'),
    ).join('');
    const key = `${file.split('.').at(-1)}:${blob ?? digest}:${range ?? ''}:${digest}`;
    const tokens = cache.get(key) ?? (await highlightSource(file, text));
    cache.delete(key);
    cache.set(key, tokens);
    if (cache.size > 2048) cache.delete(cache.keys().next().value!);
    self.postMessage({ id, tokens });
  } catch {
    self.postMessage({ id, tokens: plainLines(text) });
  }
};
