// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One agent run's page in a project (Item 6a251b23): who it is (run · model · for @person), its first and last action,
// its Lanes, saves, landings and comments, and the identity it reported. One read per view (convex/projectAgentRun.ts), plus one per
// "look further back"; it re-runs only when one of its Lanes changes. Its comments are read up to when the page opened
// (`asOf`), so the person's other Work writes never re-run it. No timer.
import '../access.css';
import '../../ds/review.css';
import '../../ds/figures.css';
import './agent.css';
import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Key, Region, State, Who } from '../../ds';
import { A } from '../frames';
import { Head } from '../Place';
import { hrefFor } from '../paths';
import type { PlaceProps } from '../screens';
import { whoLinks } from '../who-links';
import type { AgentLane, AgentRunRead } from '../../../../convex/projectAgentRun';

const nf = new Intl.NumberFormat('en-US');
const at = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function AgentRun({ person, run, ...props }: PlaceProps & { person: string; run: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<AgentLane[]>([]);
  const [earlierHooks, setEarlierHooks] = useState<AgentRunRead['hooks']>();
  const [asOf] = useState(() => Date.now());
  const args = {
    projectId: props.projectId,
    person,
    run,
    asOf,
  };
  const liveResult = useQuery(api.projectAgentRun.read, { ...args, cursor: null });
  const pageResult = useQuery(api.projectAgentRun.read, cursor ? { ...args, cursor } : 'skip');
  const live = liveResult ? (JSON.parse(liveResult) as AgentRunRead) : undefined;
  const page = pageResult ? (JSON.parse(pageResult) as AgentRunRead) : undefined;
  const next = cursor ? page : live;
  const older = newerHooks(page?.hooks, earlierHooks);
  const lanes = new Map(live?.lanes.map(lane => [lane.laneId, lane]));
  for (const lane of [...earlier, ...(page?.lanes ?? [])])
    if (!lanes.has(lane.laneId)) lanes.set(lane.laneId, lane);
  const read =
    live?.schema === 1
      ? {
          ...live,
          lanes: [...lanes.values()],
          hooks: newerHooks(live.hooks, older),
          isDone: next?.isDone ?? false,
        }
      : live;
  return (
    <AgentView
      route={props.route}
      person={person}
      run={run}
      data={read}
      more={() => {
        if (!next || next.isDone) return;
        if (page) setEarlier([...earlier, ...page.lanes]);
        setEarlierHooks(older);
        setCursor(next.continueCursor);
      }}
    />
  );
}

const newerHooks = (a: AgentRunRead['hooks'], b: AgentRunRead['hooks']) =>
  a && (!b || a.at >= b.at) ? a : b;

export function AgentView({
  route,
  person,
  run,
  data,
  more,
}: Pick<PlaceProps, 'route'> & {
  person: string;
  run: string;
  data: AgentRunRead | undefined;
  more: () => void;
}) {
  const by = `${person}/${run}`;
  const project = { handle: route.handle, project: route.project };
  const lanes = data?.lanes ?? [];
  const landed = lanes.filter(lane => lane.landed).sort((a, b) => b.landed!.at.localeCompare(a.landed!.at));
  const saves = lanes.reduce((sum, lane) => sum + (lane.saves ?? 0), 0);
  const savesAll = lanes.every(lane => lane.saves !== null);
  const comments = data?.comments ?? null;
  const unlisted = comments ? comments.count - comments.rows.length : 0;
  const itemHref = (id: string) => hrefFor({ ...route, place: 'plan', section: '', rest: id });
  const open = lanes.filter(lane => lane.open);
  const first = lanes.length ? Math.min(...lanes.map(lane => lane.first)) : null;
  const last = lanes.length ? Math.max(...lanes.map(lane => lane.last)) : null;
  const laneHref = (id: string) => hrefFor({ ...route, section: '', rest: id });
  const receiptHref = (id: string) => hrefFor({ ...route, place: 'code', section: '', rest: id });
  const read = data
    ? data.isDone
      ? 'every Lane it started here'
      : 'its newest Lanes here; more further back'
    : '';
  return (
    <>
      <Head
        trail={[{ label: 'Lanes', href: hrefFor({ ...route, section: '', rest: '' }) }, { label: run }]}
        sentence={
          !data ? (
            'Loading this agent run…'
          ) : !lanes.length && data.hooks ? (
            <b>{run} reported its Forge hook state.</b>
          ) : !lanes.length ? (
            <>
              <b>Nothing from {run} here yet.</b> Its Lanes and landings show once it starts one.
            </>
          ) : (
            <>
              <b>
                {run}{' '}
                {open.length
                  ? `has ${nf.format(open.length)} open ${open.length === 1 ? 'Lane' : 'Lanes'}`
                  : 'has no open Lane'}
              </b>{' '}
              and landed {nf.format(landed.length)} of the {nf.format(lanes.length)}{' '}
              {lanes.length === 1 ? 'Lane' : 'Lanes'} shown.
            </>
          )
        }
      />
      <div className="idband">
        <Who
          handle={by}
          {...(data?.model == null ? {} : { model: data.model })}
          layout="line"
          size="md"
          {...whoLinks(by, project)}
        />
        {first ? (
          <span className="when">
            First action <b>{at(first)}</b>
          </span>
        ) : null}
        {last ? (
          <span className="when">
            Last action <b>{at(last)}</b>
          </span>
        ) : null}
      </div>
      <div className="panes agent">
        <section className="pane">
          <div className="nums" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
            <div>
              <b>{nf.format(lanes.length)}</b>
              <span>{lanes.length === 1 ? 'Lane' : 'Lanes'}</span>
            </div>
            <div>
              <b>
                {nf.format(saves)}
                {savesAll ? '' : '+'}
              </b>
              <span>{saves === 1 ? 'save' : 'saves'}</span>
            </div>
            <div>
              <b>{nf.format(landed.length)}</b>
              <span>{landed.length === 1 ? 'landing' : 'landings'}</span>
            </div>
            <div>
              <b>
                {comments ? nf.format(comments.count) : '–'}
                {comments?.partial ? (
                  <span title="At least this many: older days are counted from what is still kept">+</span>
                ) : null}
              </b>
              <span>{comments?.count === 1 ? 'comment' : 'comments'}</span>
            </div>
          </div>
          <Region
            title="Its Lanes"
            count={lanes.length}
            hint={data ? `open first, then newest · ${read}` : undefined}
          >
            {!data ? (
              <p className="quietline" role="status">
                Loading its Lanes…
              </p>
            ) : !lanes.length ? (
              <p className="quietline">No Lane from this run in this project.</p>
            ) : (
              [...open, ...lanes.filter(lane => !lane.open)].map(lane => (
                <A key={lane.laneId} className="row p2" href={laneHref(lane.laneId)}>
                  <div>
                    <div className="ttl" dir="auto">
                      {lane.title}
                    </div>
                    <div className="meta">
                      {lane.saves === null
                        ? ''
                        : `${nf.format(lane.saves)} ${lane.saves === 1 ? 'save' : 'saves'} · `}
                      started {at(lane.first)} · last activity {at(lane.last)}
                    </div>
                  </div>
                  {lane.landed ? (
                    <State word="Landed" />
                  ) : lane.open ? (
                    <State word="In progress" />
                  ) : (
                    <State word="Set aside" />
                  )}
                </A>
              ))
            )}
            {data && !data.isDone ? (
              <div className="pad">
                <Key size="sm" onClick={more}>
                  Look further back
                </Key>
              </div>
            ) : null}
          </Region>
          {landed.length ? (
            <Region title="Landed" count={landed.length} hint="newest first">
              {landed.map(lane => (
                <A key={lane.laneId} className="row p3" href={receiptHref(lane.landed!.receiptId)}>
                  <span className="num t3">{at(Date.parse(lane.landed!.at))}</span>
                  <div className="ttl" dir="auto">
                    {lane.title}
                  </div>
                  <span className="mono t3">receipt</span>
                </A>
              ))}
            </Region>
          ) : null}
          {comments ? (
            <Region
              title="Comments"
              count={comments.count}
              hint={
                unlisted > 0 || comments.more
                  ? `newest first · ${unlisted > 0 ? `${nf.format(unlisted)}${comments.partial ? '+' : ''}` : 'more'} older not listed; open the Item to read them`
                  : 'newest first'
              }
            >
              {comments.rows.length ? (
                comments.rows.map(comment => (
                  <div key={`${comment.itemId}:${comment.at}`} className="row cm">
                    <span className="num t3">{at(comment.at)}</span>
                    <div className="what">
                      <div className="on">
                        on{' '}
                        <A className="lk mono" href={itemHref(comment.itemId)}>
                          Item {comment.itemId.slice(0, 8)}
                        </A>
                      </div>
                      <div className="q" dir="auto">
                        {comment.text}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <p className="quietline">
                  {comments.count
                    ? 'Its comments here are archived; open its Items to read them.'
                    : 'No comments.'}
                </p>
              )}
            </Region>
          ) : null}
        </section>
        <section className="pane">
          <Region title="About it">
            <dl className="kv">
              <dt>Acts for</dt>
              <dd>
                <Who handle={`@${person}`} {...whoLinks(person)} />
              </dd>
              <dt>Agent app</dt>
              <dd>
                {data?.app ?? 'not reported'}
                {data?.app ? <span className="sub"> reported by the agent</span> : null}
              </dd>
              <dt>Model</dt>
              <dd>
                {data?.model ? (
                  <>
                    <span className="mono">{data.model}</span>
                    <span className="sub"> declared, not verified</span>
                  </>
                ) : data?.model === '' ? (
                  'model not declared'
                ) : (
                  'nothing landed yet, so no declaration was read'
                )}
              </dd>
              <dt>Identity from</dt>
              <dd>{data?.identityFrom ?? 'not reported'}</dd>
              <dt>Forge hooks</dt>
              <dd>
                {data?.hooks ? (
                  <>
                    {{ configured: 'Configured', off: 'Off', unavailable: 'Unavailable' }[data.hooks.state]}
                    <span className="sub"> reported {at(data.hooks.at)}</span>
                  </>
                ) : (
                  'not reported'
                )}
              </dd>
              <dt>Device</dt>
              <dd className="mono">{data?.device ?? 'not reported'}</dd>
            </dl>
          </Region>
          <p className="quietline" data-weight="ref">
            Crossings and waits are on{' '}
            <A className="lk" href={hrefFor({ ...route, section: 'touching', rest: '' })}>
              Who is touching what
            </A>
            , because they involve two agents.
          </p>
        </section>
      </div>
    </>
  );
}
