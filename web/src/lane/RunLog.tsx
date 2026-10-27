import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Glyph } from '../ui/Glyph';
import { Button } from '../ui/primitives';
import {
  liveRun,
  logLines,
  failureMarker,
  logCommand,
  numberedLogRead,
  type LogPage,
  type LogRead,
} from './run-model';
import './run-detail.css';

/** A single byte-paged reader for retained output and live local output. */
export function RunLog({
  runId,
  status,
  read,
  remoteMachine,
}: {
  runId: string;
  status: string;
  read: LogRead;
  remoteMachine?: string;
}) {
  const readPage = useMemo(() => numberedLogRead(read), [read]);
  const initial = new URLSearchParams(location.search);
  const pinned = initial.get('checkRun') === runId;
  const [stream, setStream] = useState<'stdout' | 'stderr'>(
    pinned && initial.get('checkStream') === 'stderr' ? 'stderr' : 'stdout',
  );
  const [offset, setOffset] = useState(pinned ? Math.max(0, Number(initial.get('checkOffset')) || 0) : 0);
  const [page, setPage] = useState<LogPage | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0),
    [notice, setNotice] = useState('');
  const [focusRequest, setFocusRequest] = useState(0);
  const [previous, setPrevious] = useState<number[]>([]);
  const controller = useRef<AbortController | null>(null);
  const loading = useRef(false);
  const searching = useRef(false);
  const pollDelay = useRef(2500);
  const lastPage = useRef('');
  const output = useRef<HTMLDivElement>(null);
  const selectedLine = pinned ? Number(initial.get('checkLine')) : NaN;
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (loading.current || searching.current) return;
      loading.current = true;
      setBusy(true);
      setError('');
      try {
        const result = await readPage(stream, offset, signal);
        if (!signal.aborted) {
          const fingerprint = JSON.stringify(result);
          pollDelay.current =
            fingerprint === lastPage.current ? Math.min(30_000, pollDelay.current * 2) : 2500;
          lastPage.current = fingerprint;
          setPage(result);
        }
      } catch (e) {
        if (!signal.aborted) setError((e as Error).message);
      } finally {
        loading.current = false;
        if (!signal.aborted) setBusy(false);
      }
    },
    [readPage, stream, offset],
  );
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    loading.current = false;
    const abort = new AbortController();
    controller.current = abort;
    setPage(null);
    void load(abort.signal);
    return () => abort.abort();
  }, [load, retry, status]);
  useEffect(() => {
    if (!liveRun(status) || error || page?.more || (!remoteMachine && page?.available === false)) return;
    const timer = setTimeout(() => {
      if (controller.current) void load(controller.current.signal);
    }, pollDelay.current);
    return () => clearTimeout(timer);
  }, [status, load, error, page?.more, page?.available, remoteMachine, page]);
  useEffect(() => {
    const selected = output.current?.querySelector<HTMLElement>('[data-selected="true"]');
    if (selected) {
      selected.focus({ preventScroll: true });
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [page, focusRequest]);
  async function failure() {
    searching.current = true;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      for (const candidate of [stream]) {
        let start = 0;
        while (!abort.signal.aborted) {
          const next = await readPage(candidate, start, abort.signal);
          if (logLines(next).some(line => failureMarker(line.text))) {
            setStream(candidate);
            setOffset(start);
            setPrevious([]);
            setPage(next);
            setNotice('First failure');
            setFocusRequest(value => value + 1);
            return;
          }
          if (!next.more || next.nextOffset <= start || next.available === false) break;
          start = next.nextOffset;
        }
      }
      if (!abort.signal.aborted) setNotice(`No failure marker found in ${stream}.`);
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      searching.current = false;
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  function lineLink(line: number, number: number) {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({
      checkRun: runId,
      checkStream: stream,
      checkOffset: offset,
      checkLine: line,
    }))
      url.searchParams.set(key, String(value));
    url.hash = `L${number}`;
    return url.href;
  }
  async function copy(line: number, number: number) {
    try {
      await navigator.clipboard.writeText(lineLink(line, number));
      setNotice('Log line link copied.');
    } catch {
      setNotice('Could not copy the link.');
    }
  }
  const lines = page ? logLines(page) : [];
  const remoteWaiting = Boolean(
    !page?.providerUrl &&
    remoteMachine &&
    liveRun(status) &&
    (!page || page.available === false || page.bytes === 0),
  );
  const waitingMessage =
    status === 'queued'
      ? `Queued on ${remoteMachine} · output appears when it finishes`
      : status === 'preparing'
        ? `Preparing on ${remoteMachine} · output appears when it finishes`
        : `Running on ${remoteMachine} · output appears when it finishes`;
  const firstBad = lines.findIndex(line => failureMarker(line.text));
  return (
    <div className="fx-run-log">
      <div
        className="fx-run-tools"
        hidden={remoteWaiting || page?.status === 'summary' || !!page?.providerUrl}
      >
        <label>
          Output{' '}
          <select
            aria-label="Log stream"
            value={stream}
            onChange={event => {
              setStream(event.target.value as typeof stream);
              setOffset(0);
              setPrevious([]);
            }}
          >
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
          </select>
        </label>
        <Button
          disabled={busy}
          title="First failure marker in the selected stream"
          onClick={() => void failure()}
        >
          First failure
        </Button>
        <Button disabled={busy} onClick={() => setRetry(value => value + 1)}>
          Refresh
        </Button>
      </div>
      <div
        className="fx-run-output"
        data-waiting={remoteWaiting || undefined}
        ref={output}
        tabIndex={0}
        aria-label={`${stream} log`}
        aria-busy={busy}
      >
        {remoteWaiting ? (
          <span className="fx-faint" role="status">
            {waitingMessage}
          </span>
        ) : page?.providerUrl ? (
          <div className="fx-run-unavailable">
            <a href={page.providerUrl} target="_blank" rel="noreferrer">
              Full log on the CI provider
            </a>
            {page.text && <pre>{page.text}</pre>}
          </div>
        ) : ['summary', 'expired', 'local-only'].includes(page?.status ?? '') ? (
          <div className="fx-run-unavailable">
            Retained failure summary<pre>{page?.text}</pre>
          </div>
        ) : page?.available === false ? (
          <div className="fx-run-unavailable">
            <span>Output is on the runner. Local command:</span>
            <br />
            <code>{logCommand(runId, stream, offset)}</code>
          </div>
        ) : (
          lines.map((line, index) => (
            <div
              key={line.offset}
              tabIndex={-1}
              className={`fx-run-line${failureMarker(line.text) ? ' fx-log-bad' : ''}`}
              data-selected={
                line.offset === selectedLine || (notice === 'First failure' && index === firstBad)
              }
            >
              <a
                className="fx-log-number"
                id={`L${line.number}`}
                href={lineLink(line.offset, line.number)}
                aria-label={`Line ${line.number}`}
              >
                {line.number}
              </a>
              <button
                title="Copy log line link"
                aria-label="Copy link to this log line"
                onClick={() => void copy(line.offset, line.number)}
              >
                <Glyph name="copy" size={12} />
              </button>
              <code>{line.text || ' '}</code>
            </div>
          ))
        )}
        {!remoteWaiting && !page && !error && <span className="fx-faint">Reading output…</span>}
        {!remoteWaiting && page && page.available !== false && page.bytes === 0 && (
          <span className="fx-faint">{liveRun(status) ? 'Waiting for output…' : 'No output recorded.'}</span>
        )}
      </div>
      <div
        className="fx-run-tools"
        hidden={remoteWaiting || page?.status === 'summary' || !!page?.providerUrl}
      >
        <Button
          disabled={offset === 0 || busy}
          onClick={() => {
            setOffset(previous.at(-1) ?? Math.max(0, offset - 16384));
            setPrevious(value => value.slice(0, -1));
          }}
        >
          Previous
        </Button>
        <Button
          disabled={!page?.more || busy}
          onClick={() => {
            setPrevious(value => [...value, offset]);
            setOffset(page!.nextOffset);
          }}
        >
          Next
        </Button>
        <span className="fx-faint">
          {liveRun(status)
            ? 'Partial output'
            : page && (page.more ? 'More output available' : 'End of output')}
        </span>
      </div>
      <div className="fx-run-feedback" aria-live="polite">
        {error ? (
          <ErrorToast>
            {error} <Button onClick={() => setRetry(value => value + 1)}>Retry read</Button>
          </ErrorToast>
        ) : notice === 'Could not copy the link.' ? (
          <ErrorToast error={notice} />
        ) : notice === 'First failure' ? (
          ''
        ) : (
          notice
        )}
      </div>
    </div>
  );
}
