// SPDX-License-Identifier: Apache-2.0
import '../access.css';
import '../../ds/review.css';
import { Band, CodeBox, Key, Region, Who } from '../../ds';
import { A } from '../frames';
import { Head } from '../Place';
import { hrefFor } from '../paths';
import type { PlaceProps } from '../screens';
import { when, type SessionRow, type SessionsRead } from './model';
export function AgentView({
  route,
  data,
  rows,
  more,
}: Pick<PlaceProps, 'route'> & { data?: SessionsRead; rows: SessionRow[]; more: () => void }) {
  const current = rows[0],
    at = (place: 'stats' | 'lanes') => hrefFor({ ...route, place, section: '', rest: '' });
  return (
    <>
      <Head
        trail={[{ label: 'Lanes', href: at('lanes') }, { label: route.rest }]}
        sentence={
          <>
            <b>A session acts for a person.</b> Its Lanes and the identity it reported, with unknowns left
            visible.
          </>
        }
      />
      <div className="panes access-frame">
        <Region
          title="Its Lanes"
          count={rows.length}
          hint={`${rows.length} shown${data?.isDone === false ? ', more available' : ''}`}
        >
          {!data ? (
            <p className="pad" role="status">
              Loading this session…
            </p>
          ) : !rows.length ? (
            <div className="pad">
              <p>Nothing from this session on this page yet.</p>
              {!data.isDone && (
                <Key size="sm" onClick={more}>
                  Look on the next page
                </Key>
              )}
            </div>
          ) : (
            rows.map(row => (
              <A
                key={row.laneId}
                className="row p2"
                href={hrefFor({ ...route, section: '', rest: `${row.laneId}/holder` })}
              >
                <div>
                  <div className="ttl">{row.title}</div>
                  <div className="meta">Last seen {when(row.lastSeen)}</div>
                </div>
                <span className="mono">Held</span>
              </A>
            ))
          )}
          {data && !data.isDone && (
            <div className="pad">
              <Key size="sm" onClick={more}>
                More Lanes
              </Key>
            </div>
          )}
          <Band title="Asks of you" hint="not reported" />
          <p className="pad">
            <A className="lk" href={hrefFor({ ...route, place: 'needs', section: '', rest: '' })}>
              See what needs you
            </A>
          </p>
          <Band title="Landed today" hint="not reported" />
          <p className="pad">
            <A className="lk" href={at('stats')}>
              See checked work and spending
            </A>
          </p>
        </Region>
        <Region title="About it">
          <div>
            <dl className="kv">
              <dt>Acts for</dt>
              <dd>{current ? <Who handle={`@${current.person}`} /> : 'Not reported'}</dd>
              <dt>Agent app</dt>
              <dd>
                {current?.app ?? 'Not reported'}
                {current?.app && <span className="sub">reported by the agent</span>}
              </dd>
              <dt>Model</dt>
              <dd>Not reported</dd>
              <dt>Session</dt>
              <dd className="mono">{current?.name ?? route.rest.split('/').at(-1)}</dd>
              <dt>Identity from</dt>
              <dd>{current?.identityFrom ?? 'Not reported'}</dd>
              <dt>Device</dt>
              <dd>
                {current?.device?.code ?? 'Not reported'}
                {current?.device?.name && <span className="sub">“{current.device.name}”</span>}
              </dd>
              <dt>First observed here</dt>
              <dd>{current?.startedAt ? when(current.startedAt) : 'Not recorded'}</dd>
              <dt>Last seen</dt>
              <dd>{current ? when(current.lastSeen) : 'Not recorded'}</dd>
            </dl>
          </div>
          <Band title="Which chat window?" />
          <div className="pad">
            <CodeBox label="Run in that window">nforge agent . whoami</CodeBox>
            <p className="sub">
              Access is the person’s, narrowed by the device. A session name grants nothing.
            </p>
          </div>
        </Region>
      </div>
    </>
  );
}
