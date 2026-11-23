// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// What only the person sees on their own page (Item 6a251b23): their devices and browser sign-ins, and the projects
// they starred. Both reads are the signed-in person's own (convex/authSessions.ts list, convex/publicDiscovery.ts
// myStarred), so neither can show anyone else's, whatever page asks. Each is asked once when the page opens, never
// subscribed; no polling, no timer. Changes are made on the Devices page ("Manage").
import { useEffect, useState, type ReactNode } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { hrefFor } from '../app/paths';
import { followLink } from '../app/router';
import type { AccountSessions } from '../app/YouView';
import type { ListedProject } from './read';

/** Devices and browsers shown here; the Devices page lists the rest. */
const SHOWN = 10;
const nf = new Intl.NumberFormat('en-US');
const dateOf = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

type Load<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ok'; data: T };

/** One read, asked once when the region mounts. */
function useOnce<T>(read: () => Promise<T>): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    read()
      .then(data => live && setLoad({ state: 'ok', data }))
      .catch(() => live && setLoad({ state: 'failed' }));
    return () => {
      live = false;
    };
    // Asked once: `read` is rebuilt each render and must not re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return load;
}

const manageHref = () => hrefFor({ frame: 'account', place: 'devices' });

const deviceWords = (device: AccountSessions['devices'][number], now: number) =>
  device.revoked
    ? 'Signed out'
    : device.approvalExpired
      ? 'Approval expired'
      : device.expiresAt <= now
        ? `Sign-in expired ${dateOf(device.expiresAt)}`
        : `Signed in until ${dateOf(device.expiresAt)}`;

function ago(ms: number, now: number) {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 60) return minutes < 1 ? 'just now' : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${nf.format(days)} days ago`;
}

const Terminal = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="m3.5 5 3.5 3-3.5 3M8.5 11.5h4" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
const Window = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <rect x="2.5" y="3.5" width="11" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M2.5 6.5h11" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/** Devices and the browsers signed in: the person's own view only. */
export function OwnDevices({ now }: { now: number }) {
  const convex = useConvex();
  const load = useOnce(() =>
    convex.query(api.authSessions.list, { paginationOpts: { numItems: SHOWN, cursor: null } }),
  );
  const data = load.state === 'ok' ? (load.data as AccountSessions) : null;
  const devices = data?.devices.filter(device => !device.removed) ?? [];
  const browsers = data?.sessions.slice(0, SHOWN) ?? [];
  return (
    <section className="region" aria-label="Devices and places you are signed in">
      <div className="ph plain">
        <h2>Devices and sign-ins</h2>
        {data ? <span className="cnt">{nf.format(devices.length + browsers.length)}</span> : null}
        <span className="hint">only you see this</span>
        <a className="lk right" href={manageHref()} onClick={followLink}>
          Manage
        </a>
      </div>
      {load.state === 'loading' ? (
        <p className="quietline" aria-busy="true">
          Loading your devices…
        </p>
      ) : load.state === 'failed' ? (
        <p className="quietline" role="status">
          Your devices could not be read here. They are on the{' '}
          <a className="lk" href={manageHref()} onClick={followLink}>
            Devices page
          </a>
          .
        </p>
      ) : (
        <>
          {devices.map(device => (
            <div key={device.credentialId} className="row dv">
              <div>
                <span className="who dev">
                  <span className="av si">
                    <Terminal />
                  </span>
                  <span>Device</span>
                  {device.code ? (
                    <span className="mono" translate="no">
                      {device.code}
                    </span>
                  ) : (
                    <span>without a code</span>
                  )}
                </span>
                <span className="meta">
                  {deviceWords(device, now)}
                  {device.approvedAt ? ` · approved ${dateOf(device.approvedAt)}` : ''}
                </span>
              </div>
            </div>
          ))}
          {browsers.map(session => (
            <div key={session.sessionId} className="row dv">
              <div>
                <span className="who">
                  <span className="av si">
                    <Window />
                  </span>
                  <span>A browser</span>
                </span>
                <span className="meta">
                  signed in {ago(session.creationTime, now)}
                  {session.current ? ' · this browser' : ''}
                </span>
              </div>
            </div>
          ))}
          {!data!.isDone ? (
            <p className="quietline">
              More on the{' '}
              <a className="lk" href={manageHref()} onClick={followLink}>
                Devices page
              </a>
              .
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The projects the person starred: never public, only they see this list. */
export function Starred({
  now,
  rows,
}: {
  now: number;
  rows: (projects: readonly ListedProject[]) => ReactNode;
}) {
  const convex = useConvex();
  const load = useOnce(() => convex.query(api.publicDiscovery.myStarred, { now }));
  const data = load.state === 'ok' ? load.data : null;
  return (
    <section className="region" aria-label="Starred">
      <div className="ph plain">
        <h2>Starred</h2>
        {data ? (
          <span className="cnt">
            {nf.format(data.projects.length)}
            {data.more ? '+' : ''}
          </span>
        ) : null}
        <span className="hint">only you see this list</span>
      </div>
      {load.state === 'loading' ? (
        <p className="quietline" aria-busy="true">
          Loading your stars…
        </p>
      ) : load.state === 'failed' ? (
        <p className="quietline" role="status">
          Your starred projects could not be read. Try again later.
        </p>
      ) : data!.projects.length ? (
        rows(data!.projects)
      ) : (
        <p className="quietline">
          Projects you star are kept here.{' '}
          <a className="lk" href={hrefFor({ frame: 'discover', page: 'explore' })} onClick={followLink}>
            Explore
          </a>
        </p>
      )}
    </section>
  );
}
