// SPDX-License-Identifier: Apache-2.0
export type LogPage = {
  offset: number;
  nextOffset: number;
  bytes: number;
  text: string;
  more: boolean;
  available?: boolean;
  firstLine?: number;
};
export type LogRead = (stream: 'stdout' | 'stderr', offset: number, signal?: AbortSignal) => Promise<LogPage>;
export const failureMarker = (text: string) =>
  /✖|not ok|Error:|\bFAIL(?:ED)?\b|\berror TS\d+:|\bAssertionError\b|\s+error\s{2,}/i.test(text);
export const liveRun = (status: string) => ['queued', 'preparing', 'running'].includes(status);
export function logLines(page: LogPage) {
  let offset = page.offset;
  return page.text.split('\n').map((text, index) => {
    const line = { number: (page.firstLine ?? 1) + index, text: text.replace(/\x1b\[[0-9;]*m/g, ''), offset };
    offset += new TextEncoder().encode(text + '\n').length;
    return line;
  });
}
/** Optional scope hook: render only recorded scope, never derive test coverage from output. */
export function scopeLabel(scope?: { mode: 'scoped' | 'full'; selectedTests: readonly string[] }) {
  return scope ? (scope.mode === 'full' ? 'Full suite' : `Scoped · ${scope.selectedTests.length} tests`) : '';
}
export function cancellationResult(run: { status: string; cancelRequested?: boolean }) {
  if (!liveRun(run.status)) return `Check ${run.status}.`;
  return run.cancelRequested ? 'Cancellation requested. Waiting for the runner.' : `Check ${run.status}.`;
}
export function logCommand(runId: string, stream = 'stdout', offset = 0) {
  return `nforge agent ROOT log '${JSON.stringify({ operationId: runId, stream, offset, bytes: 16384 })}'`;
}

/** Count newlines from retained bytes; byte pins and displayed line numbers stay distinct. */
export function numberedLogRead(read: LogRead): LogRead {
  const starts = { stdout: new Map([[0, 1]]), stderr: new Map([[0, 1]]) };
  return async (stream, offset, signal) => {
    const known = starts[stream];
    let start = Math.max(...[...known.keys()].filter(value => value <= offset));
    let number = known.get(start)!;
    while (start < offset) {
      const page = await read(stream, start, signal);
      if (page.available === false || page.nextOffset <= start) return page;
      const prefix = new TextDecoder().decode(new TextEncoder().encode(page.text).slice(0, offset - start));
      number += (prefix.match(/\n/g) ?? []).length;
      start = Math.min(offset, page.nextOffset);
      known.set(start, number);
    }
    const page = await read(stream, offset, signal);
    known.set(page.nextOffset, number + (page.text.match(/\n/g) ?? []).length);
    return { ...page, firstLine: number };
  };
}
