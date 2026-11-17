// SPDX-License-Identifier: Apache-2.0
import '../access.css';
import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Avatar, Band, CodeBox, Key, Region, Who } from '../../ds';
import { Head } from '../Place';
import { A } from '../frames';
import { hrefFor } from '../paths';
import type { PlaceProps } from '../screens';
import { seen, sessionGroups, distinctSessions, when, type SessionsRead, type SessionRow } from './model';
import '../../ds/figures.css';
import '../../ds/review.css';
import { AgentRun } from './Agent';
export default function Sessions(props: PlaceProps) {
  const [person, run] = props.route.rest.split('/').map(part => decodeURIComponent(part));
  if (person && run) return <AgentRun {...props} person={person} run={run} />;
  return <SessionList {...props} />;
}
function SessionList(props: PlaceProps) {
  const [cursor, setCursor] = useState<string | null>(null);
  const result = useQuery(api.projectSessions.read, { projectId: props.projectId, cursor });
  const data = result ? (JSON.parse(result) as SessionsRead) : undefined;
  return (
    <SessionsView
      {...props}
      data={data}
      more={() => data && setCursor(data.continueCursor)}
      first={() => setCursor(null)}
    />
  );
}
export function SessionsView({
  route,
  data,
  more,
  first,
}: Pick<PlaceProps, 'route'> & { data?: SessionsRead; more: () => void; first: () => void }) {
  const [find, setFind] = useState(''),
    [person, setPerson] = useState(''),
    [app, setApp] = useState('');
  const [showCommand, setShowCommand] = useState(false);
  const [peek, setPeek] = useState<SessionRow | null>(null);
  const rows = data?.rows ?? [];
  const matches = rows.filter(
    row =>
      (!find || (row.name ?? '').includes(find.toLowerCase())) &&
      (!person || row.person === person) &&
      (!app || row.app === app),
  );
  const shown = matches;
  const sessions = distinctSessions(shown);
  const groups = sessionGroups(sessions);
  const laneHref = (id: string) => hrefFor({ ...route, section: '', rest: `${id}/holder` });
  const sessionHref = (row: SessionRow) =>
    hrefFor({ ...route, section: 'sessions', rest: `${row.person}/${row.name}` });
  const name = (row: SessionRow) => row.name ?? 'Person';
  const selected = peek;
  return (
    <>
      <Head
        trail={[
          { label: 'Lanes', href: hrefFor({ ...route, section: '', rest: '' }) },
          { label: 'Sessions' },
        ]}
        sentence={
          <>
            <b>Who is working here.</b> By person, then device; most recently seen first.
          </>
        }
      >
        <Key
          className="cli"
          aria-controls="session-command"
          aria-expanded={showCommand}
          onClick={() => setShowCommand(!showCommand)}
        >
          <span className="mono">nforge agent . whoami</span>
        </Key>
      </Head>
      {showCommand && (
        <div id="session-command">
          <CodeBox label="In the chat window">nforge agent . whoami</CodeBox>
        </div>
      )}
      <div className={peek ? 'panes access-frame' : 'panes access-single'}>
        <Region
          title="Live sessions"
          count={sessions.length}
          hint={`${shown.length} Lane observations shown${data?.isDone === false ? ', more available' : ''}`}
        >
          {rows.length > 12 && (
            <div className="tbar" role="search">
              <label className="find">
                <span className="sr">Find a session on this page</span>
                <input
                  className="inp"
                  type="search"
                  placeholder="Find a session by name…"
                  value={find}
                  onChange={e => setFind(e.target.value)}
                />
              </label>
              <label className="sr" htmlFor="session-person">
                Person
              </label>
              <select
                className="chip off"
                id="session-person"
                value={person}
                onChange={e => setPerson(e.target.value)}
              >
                <option value="">Any person</option>
                {[...new Set(rows.map(r => r.person))].map(p => (
                  <option key={p} value={p}>
                    @{p}
                  </option>
                ))}
              </select>
              <label className="sr" htmlFor="session-app">
                App
              </label>
              <select
                className="chip off"
                id="session-app"
                value={app}
                onChange={e => setApp(e.target.value)}
              >
                <option value="">Any app</option>
                {[...new Set(rows.flatMap(r => (r.app ? [r.app] : [])))].map(a => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </div>
          )}
          {!data ? (
            <p className="pad" role="status">
              Loading sessions…
            </p>
          ) : !shown.length ? (
            <div className="pad">
              <p>{rows.length ? 'No sessions match on this page.' : 'No agent has been seen here yet.'}</p>
              <CodeBox label="In the chat window">nforge agent . whoami</CodeBox>
            </div>
          ) : (
            groups.map(group => (
              <div key={group.person}>
                <Band title={`@${group.person}`} count={group.devices.flat().length} />
                {group.devices.map((devices, d) => (
                  <div key={d}>
                    <Band
                      title={devices[0]?.device?.code ?? 'Device not reported'}
                      hint={devices[0]?.device?.name ? `“${devices[0].device.name}”` : undefined}
                    />
                    {devices.map(row => (
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
                        <div className="seen">{seen(row.lastSeen, data.observedAt)}</div>
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
        {peek && (
          <Region title={selected ? name(selected) : 'Which chat window?'} hint={selected?.app ?? undefined}>
            <div className="pad">
              {selected && (
                <>
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
                </>
              )}
              <p>Run this in the chat window you think it is.</p>
              <CodeBox label="In the chat window">nforge agent . whoami</CodeBox>
              <p className="sub">
                Match the full session reference and name. A name identifies a window; it grants no access.
              </p>
              {peek && (
                <Key size="sm" onClick={() => setPeek(null)}>
                  Close
                </Key>
              )}
            </div>
          </Region>
        )}
      </div>
    </>
  );
}
