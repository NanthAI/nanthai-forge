import type { PendingStatus } from '../../../src/pending-status';
import { serviceLastSeen } from '../cockpit/queue-model';
import { ConnectionToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { AutoTag } from '../ui/signals';
import { age, shortHash } from '../ui/status';
import { useReadsAsleep } from '../live-reads';

/** Re-renders relative ages on a calm cadence; stands still while live reads are asleep. */
export function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  const asleep = useReadsAsleep();
  const slept = useRef(false);
  useEffect(() => {
    if (asleep) {
      slept.current = true;
      return;
    }
    if (slept.current) setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, asleep]);
  return now;
}

const checkWord = (status: string | undefined) =>
  status === 'passed'
    ? { tone: 'passed', glyph: 'passed', word: 'passing' }
    : status === 'failed'
      ? { tone: 'failed', glyph: 'failed', word: 'failing' }
      : status === 'cancelled' || status === 'interrupted'
        ? { tone: 'plain', glyph: 'plain', word: status.charAt(0).toUpperCase() + status.slice(1) }
        : status === 'queued' || status === 'running' || status === 'preparing'
          ? { tone: 'running', glyph: 'running', word: 'checking' }
          : null;

export type StripActor = { name: string; kind?: 'person' | 'agent' };

/**
 * The 32px Channel strip: where main is, who moved it and whether its check passed, with the
 * connection state at the right. The hash lives in the tooltip, not in the strip.
 */
export function ChannelStrip({
  channel = 'main',
  head,
  at,
  check,
  by,
  automatic = false,
  pending = false,
  live,
  stale,
  freshness,
  queue,
}: {
  queue?: PendingStatus;
  stale?: string | undefined;
  freshness?: ReactNode;
  channel?: string;
  head?: string;
  at?: string | number;
  check?: string;
  by?: StripActor;
  automatic?: boolean;
  /** Still reading where main is: say nothing rather than "nothing accepted yet". */
  pending?: boolean;
  live: ReactNode;
}) {
  const now = useNow();
  const state = checkWord(check);
  const landing = queue ? serviceLastSeen(queue, now) : null;
  return (
    <div className="fx-strip">
      <span className="fx-strip-chan" title={head ? `${channel} at ${shortHash(head, 12)}` : undefined}>
        <Glyph name="channel" size={13} />
        <b>{channel}</b>
      </span>
      {head ? (
        <span className="fx-strip-moved">
          accepted {age(at, now, true)}
          {by && <span className="fx-strip-by"> · {by.name}</span>}
          {automatic && (
            <>
              {' '}
              <AutoTag />
            </>
          )}
        </span>
      ) : pending ? null : (
        <span className="fx-faint">nothing accepted yet</span>
      )}
      {head && state && (
        <>
          <span className="fx-sub-sep" aria-hidden="true" />
          <span
            className={`fx-strip-check fx-c-${stale ? 'plain' : state.tone}`}
            title={stale}
            tabIndex={stale ? 0 : undefined}
          >
            <Glyph name={stale && state.tone === 'running' ? 'stale' : (state.glyph as 'passed')} size={12} />
            {state.word}
          </span>
        </>
      )}
      {landing && (
        <>
          <span className="fx-sub-sep" aria-hidden="true" />
          <span className="fx-strip-check" title={landing.tip}>
            <span className={`fx-dot fx-dot-${landing.tone === 'plain' ? 'waiting' : 'stale'}`} />
            {landing.text}
          </span>
        </>
      )}
      {freshness}
      <span className="fx-strip-live">{live}</span>
    </div>
  );
}

/** Connection state only: "Live" while updates arrive, "Paused" while the tab is idle. Never presence. */
export function LiveStatus({ error, local }: { error?: string; local?: boolean }) {
  const asleep = useReadsAsleep();
  if (asleep && !error && !local)
    return (
      <span className="fx-live fx-live-off" role="status" title="Updates resume when you come back.">
        <span className="fx-dot fx-dot-stale" />
        Paused
      </span>
    );
  if (error)
    return (
      <>
        <ConnectionToast disconnected />
        <span
          className="fx-live fx-live-off"
          role="status"
          title={local ? 'The local Forge server is not answering; retrying.' : 'Updates paused; retrying.'}
        >
          <span className="fx-dot fx-dot-stale" />
          <span aria-label="Connection paused" />
        </span>
      </>
    );
  return (
    <span className="fx-live" role="status">
      <ConnectionToast disconnected={false} />
      <span className="fx-pulse" aria-hidden="true" />
      Live
    </span>
  );
}
