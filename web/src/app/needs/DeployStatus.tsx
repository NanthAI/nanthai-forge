// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useState } from 'react';
import type { DeployStatus, DeployStatusRead } from '../../../../src/deploy-status';
import { Glyph, Key } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import type { PlaceProps } from '../screens';
import { deployStatusId } from './notice-attention';

type Seen = (target: string, key: string) => Promise<void>;
const sinceFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function DeployStatusLines({
  status,
  route,
  seen,
}: {
  status: DeployStatusRead | undefined;
  route: PlaceProps['route'];
  seen?: Seen;
}) {
  if (!status?.targets.length) return null;
  return (
    <ul className="deploy-status-lines" aria-label="Deploy status">
      {status.targets.map(target => (
        <DeployLine
          key={`${target.target}:${target.failure?.key ?? ''}`}
          target={target}
          mainSequence={status.mainSequence}
          route={route}
          seen={seen}
        />
      ))}
    </ul>
  );
}

function DeployLine({
  target,
  mainSequence,
  route,
  seen,
}: {
  target: DeployStatus;
  mainSequence: number;
  route: PlaceProps['route'];
  seen?: Seen;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const { failure, liveSequence } = target;
  const live = liveSequence === null ? 'Live version unverified' : `Live at #${liveSequence}`;
  const when = failure ? new Date(failure.since) : null;
  const work = failure?.work;
  return (
    <li className="deploy-status-line" id={deployStatusId(target.target)}>
      <span className="deploy-status-title">
        <Glyph of={failure ? 'waiting' : 'passed'} size={12} />
        <strong>{target.label}</strong>
        <span>{target.environment}</span>
      </span>
      {failure ? (
        <>
          <span>
            Behind · failing since #{failure.sinceSequence}
            {when && Number.isFinite(when.getTime()) ? (
              <>
                {' '}
                · <time dateTime={failure.since}>{sinceFormat.format(when)}</time>
              </>
            ) : null}
          </span>
          <span>
            {live} · main #{mainSequence}
          </span>
          {work ? (
            <A
              className="lk"
              href={hrefFor({
                ...route,
                place: work.kind === 'lane' ? 'lanes' : 'plan',
                section: '',
                rest: work.id,
              })}
            >
              {work.who} is on it
            </A>
          ) : null}
          <span>Clears itself when the next deploy succeeds</span>
          {failure.runUrl ? (
            <a className="lk" href={failure.runUrl} target="_blank" rel="noreferrer">
              Open the run
            </a>
          ) : null}
          {seen ? (
            <Key
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(false);
                try {
                  await seen(target.target, failure.key);
                } catch {
                  setError(true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Seen
            </Key>
          ) : null}
          {error ? <span role="status">Could not mark this deploy as seen.</span> : null}
        </>
      ) : (
        <span>{live}</span>
      )}
    </li>
  );
}
