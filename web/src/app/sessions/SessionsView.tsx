// SPDX-License-Identifier: Apache-2.0
import '../access.css';
import { useState } from 'react';
import { hostedProjectRoot } from '../../../../src/project-routes';
import { SESSION_QUIET_MS } from '../../../../src/session-presence';
import { Avatar, Band, CodeBox, Key, Region, Who } from '../../ds';
import { Head } from '../Place';
import { A } from '../frames';
import { hrefFor } from '../paths';
import type { PlaceProps } from '../screens';
import {
  seen,
  sessionGroups,
  distinctSessions,
  when,
  type SessionFilters,
  type SessionsRead,
  type SessionRow,
} from './model';
import '../../ds/figures.css';
import '../../ds/review.css';

export function listHref(route: PlaceProps['route'], filters: SessionFilters = {}, activity = false) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (activity) params.set('activity', '1');
  return hrefFor({ ...route, rest: '' }) + (params.size ? `?${params}` : '');
}
export function SessionsView({
  route,
  data,
  more,
  first,
  activity = false,
  filters = {},
  setFilters,
  now = data?.observedAt,
  readFailed,
}: Pick<PlaceProps, 'route'> & {
  data?: SessionsRead;
  more: () => void;
  first: () => void;
  activity?: boolean;
  filters?: SessionFilters;
  setFilters?: (filters: SessionFilters) => void;
  now?: number;
  readFailed?: boolean;
}) {
  const [showCommand, setShowCommand] = useState(false);
  const [peek, setPeek] = useState<SessionRow | null>(null);
  const rows = data?.rows ?? [];
  const sessions = distinctSessions(
    activity || now === undefined ? rows : rows.filter(row => now - row.lastSeen < SESSION_QUIET_MS),
  );
  const groups = sessionGroups(sessions);
  const laneHref = (id: string) => hrefFor({ ...route, section: '', rest: `${id}/holder` });
  const sessionHref = (row: SessionRow) =>
    hrefFor({ ...route, section: 'sessions', rest: `${row.person}/${row.name}` });
  const name = (row: SessionRow) => row.name ?? 'Person';
  const selected = sessions.find(row => row.laneId === peek?.laneId);
  const deviceSelected = Boolean(filters.device || filters.deviceId);
  return (
    <>
      <Head
        trail={[
          { label: 'Lanes', href: hrefFor({ ...route, section: '', rest: '' }) },
          { label: 'Sessions', ...(activity ? { href: listHref(route) } : {}) },
          ...(activity ? [{ label: 'Activity' }] : []),
        ]}
        sentence={<>{activity ? 'Sessions quiet for 30 minutes.' : 'Who is working here.'}</>}
      >
        {!activity && (
          <Key
            className="cli"
            aria-controls="session-command"
            aria-expanded={showCommand}
            onClick={() => setShowCommand(!showCommand)}
          >
            <span className="mono">nforge agent . whoami</span>
          </Key>
        )}
      </Head>
      {showCommand && (
        <div id="session-command">
          <CodeBox label="In the chat window">nforge agent . whoami</CodeBox>
        </div>
      )}
      <div className={selected ? 'panes access-frame' : 'panes access-single'}>
        <Region
          title={activity ? 'Session activity' : 'Live sessions'}
          count={sessions.length}
          hint={data?.isDone === false ? 'More pages available' : undefined}
        >
          <div className="tbar session-controls">
            {setFilters && (
              <form
                className="session-filters"
                role="search"
                onSubmit={event => {
                  event.preventDefault();
                  const input = new FormData(event.currentTarget);
                  setFilters({
                    find: String(input.get('find') ?? '').trim(),
                    person: String(input.get('person') ?? '')
                      .trim()
                      .replace(/^@/, '')
                      .toLowerCase(),
                    app: String(input.get('app') ?? '').trim(),
                    ...(filters.device ? { device: filters.device } : {}),
                    ...(filters.deviceId ? { deviceId: filters.deviceId } : {}),
                  });
                }}
              >
                <label className="find">
                  <span className="sr">Session name</span>
                  <input
                    className="inp"
                    type="search"
                    placeholder="Find a session by name…"
                    name="find"
                    defaultValue={filters.find}
                  />
                </label>
                <input
                  className="inp"
                  aria-label="Person"
                  name="person"
                  placeholder="Any person"
                  defaultValue={filters.person}
                  list="session-people"
                />
                <datalist id="session-people">
                  {[...new Set(rows.map(row => row.person))].map(person => (
                    <option key={person} value={person} />
                  ))}
                </datalist>
                <input
                  className="inp"
                  aria-label="App"
                  name="app"
                  placeholder="Any app"
                  defaultValue={filters.app}
                  list="session-apps"
                />
                <datalist id="session-apps">
                  {[...new Set(rows.flatMap(row => (row.app ? [row.app] : [])))].map(app => (
                    <option key={app} value={app} />
                  ))}
                </datalist>
                <Key size="sm" type="submit">
                  Search
                </Key>
              </form>
            )}
            {deviceSelected && (
              <A className="lk" href={listHref(route, { ...filters, device: '', deviceId: '' }, activity)}>
                Clear device filter
              </A>
            )}
            <A
              className="lk"
              href={
                activity
                  ? hostedProjectRoot(route.handle, route.project) + '/activity'
                  : listHref(route, {}, true)
              }
            >
              {activity ? 'All activity' : 'Activity'}
            </A>
          </div>
          {readFailed ? (
            <p className="pad" role="alert">
              Could not read sessions.
            </p>
          ) : !data ? (
            <p className="pad" role="status">
              Loading sessions…
            </p>
          ) : !sessions.length ? (
            <div className="pad">
              <p>
                {data.isDone ? 'No sessions match.' : 'No matches on this page. More sessions are available.'}
              </p>
            </div>
          ) : (
            groups.map(group => (
              <div key={group.person}>
                <Band title={`@${group.person}`} count={group.devices.flat().length} />
                {group.devices.map(devices => (
                  <div key={devices[0]?.device?.id ?? 'unknown'}>
                    <Band
                      title={devices[0]?.device?.code ?? 'Device not reported'}
                      hint={devices[0]?.device?.name ? `“${devices[0].device.name}”` : undefined}
                    />
                    {(deviceSelected || !devices[0]?.device ? devices : devices.slice(0, 1)).map(row => (
                      <div className="row session" key={row.laneId}>
                        <Avatar handle={`${row.person}/${name(row)}`} />
                        <div className="nm">
                          <A href={sessionHref(row)}>
                            <b translate="no" dir="auto">
                              {name(row)}
                            </b>
                          </A>
                          <span className="sub">{row.app ?? 'App not reported'}</span>
                        </div>
                        <div className="on-what">
                          <A className="ttl" href={laneHref(row.laneId)}>
                            {row.title}
                          </A>
                          <span className="sub">Holds this Lane</span>
                        </div>
                        <div className="seen">{seen(row.lastSeen, now ?? data.observedAt)}</div>
                        <Key
                          className="icb"
                          size="sm"
                          aria-label={`Which window is ${name(row)}?`}
                          onClick={() => setPeek(row)}
                        >
                          …
                        </Key>
                      </div>
                    ))}
                    {!deviceSelected && devices[0]?.device && (devices.length > 1 || !data.isDone) && (
                      <div className="pad">
                        <A
                          className="lk"
                          href={listHref(
                            route,
                            { device: devices[0].device.code, deviceId: devices[0].device.id },
                            activity,
                          )}
                        >
                          {devices.length > 1
                            ? `${devices.length - 1} more on this page · All device sessions`
                            : 'All device sessions'}
                        </A>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
          <div className="pad btns">
            <Key size="sm" onClick={first}>
              First page
            </Key>
            {data && !data.isDone && (
              <Key size="sm" onClick={more}>
                More sessions
              </Key>
            )}
          </div>
        </Region>
        {selected && (
          <Region title={name(selected)} hint={selected.app ?? undefined}>
            <div className="pad">
              <p>
                <Who handle={selected.person} /> ·{' '}
                <span className="dcode">{selected.device?.code ?? 'Device not reported'}</span>
              </p>
              <dl className="kv">
                <dt>Identity from</dt>
                <dd>{selected.identityFrom ?? 'Not reported'}</dd>
                <dt>First observed</dt>
                <dd>{selected.startedAt ? when(selected.startedAt) : 'Not recorded'}</dd>
                <dt>Last seen</dt>
                <dd>{when(selected.lastSeen)}</dd>
                <dt>Holds</dt>
                <dd>
                  <A className="lk" href={laneHref(selected.laneId)}>
                    {selected.title}
                  </A>
                </dd>
              </dl>
              <p>Run this in the chat window you think it is.</p>
              <CodeBox label="In the chat window">nforge agent . whoami</CodeBox>
              <p className="sub">
                Match the full session reference and name. A name identifies a window; it grants no access.
              </p>
              <Key size="sm" onClick={() => setPeek(null)}>
                Close
              </Key>
            </div>
          </Region>
        )}
      </div>
    </>
  );
}
