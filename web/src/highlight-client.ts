// SPDX-License-Identifier: Apache-2.0
import { plainLines, type SourceToken } from './source-highlight';
let worker: Worker | undefined;
let unavailable = false,
  nextId = 0;
const pending = new Map<number, { text: string; resolve: (tokens: SourceToken[][]) => void }>();
/** No grammar or parser runs on the UI thread, including worker-load failures. */
export function requestHighlight(
  file: string,
  text: string,
  blob?: string,
  range?: string,
): Promise<SourceToken[][]> {
  if (unavailable || typeof Worker === 'undefined' || text.length > 1_000_000)
    return Promise.resolve(plainLines(text));
  try {
    if (!worker) {
      worker = new Worker(new URL('./source-highlight.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ id: number; tokens: SourceToken[][] }>) => {
        pending.get(event.data.id)?.resolve(event.data.tokens);
        pending.delete(event.data.id);
      };
      worker.onerror = event => {
        event.preventDefault();
        unavailable = true;
        worker?.terminate();
        for (const request of pending.values()) request.resolve(plainLines(request.text));
        pending.clear();
      };
    }
    return new Promise(resolve => {
      const id = nextId++;
      pending.set(id, { text, resolve });
      try {
        worker!.postMessage({ id, file, text, blob, range });
      } catch {
        pending.delete(id);
        resolve(plainLines(text));
      }
    });
  } catch {
    unavailable = true;
    return Promise.resolve(plainLines(text));
  }
}
